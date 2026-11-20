use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::thread;

use anyhow::{Context, Result};

use crate::{Mode, Paths};

/// Spawn a thread that reads `reader` line-by-line and writes each line to
/// both the backend log file and the parent's stderr (the developer's
/// terminal). Used in dev mode so `bun run dev` shows sidecar output live
/// without losing the persistent backend.log trail.
fn tee_to_log_and_stderr<R: Read + Send + 'static>(reader: R, mut log: File) {
    thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines().flatten() {
            let _ = writeln!(log, "{}", line);
            eprintln!("[sidecar] {}", line);
        }
    });
}

#[derive(Default)]
pub struct BackendHandle {
    child: Option<Child>,
}

impl BackendHandle {
    pub fn shutdown(&mut self) {
        if let Some(mut child) = self.child.take() {
            log::info!("terminating backend pid {}", child.id());
            #[cfg(unix)]
            unsafe {
                libc_kill(child.id() as i32, 15);
            }
            #[cfg(not(unix))]
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Non-blocking liveness check. Returns ``Some(exit_status_string)``
    /// if the child has exited, ``None`` if it's still running or there
    /// is no child to watch.
    pub fn check_exited(&mut self) -> Option<String> {
        let child = self.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(format!("{status}")),
            Ok(None) => None,
            Err(e) => Some(format!("try_wait error: {e}")),
        }
    }
}

impl Drop for BackendHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn spawn(paths: &Paths) -> Result<(BackendHandle, u16)> {
    // Self-heal: if the previous Tauri process didn't drop cleanly (force
    // kill, panic) the sidecar will still be listening on a port recorded
    // in .dev-backend.json. Find it and SIGTERM it before claiming a new
    // port, otherwise we'll leave an orphan plus a stale dev-backend file
    // pointing at a port nothing is using.
    cleanup_stale_sidecar(&paths.desktop_dir.join(".dev-backend.json"));

    let port = pick_free_port()?;
    let log_path = paths.log_dir.join("backend.log");
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .with_context(|| format!("open log {}", log_path.display()))?;

    // Tag the log file with a launch marker so successive runs are easy to skim.
    {
        let mut header = log_file.try_clone().ok();
        if let Some(h) = header.as_mut() {
            let _ = writeln!(h, "\n=== launch port={} ===", port);
        }
    }
    let log_clone = log_file.try_clone().context("clone log handle")?;
    // Extra clones reserved for the dev-mode tee threads so the in-terminal
    // mirroring doesn't fight the child for the same OS-level handle.
    let dev_stdout_log = if paths.mode == Mode::Dev {
        Some(log_file.try_clone().context("clone log handle (dev stdout)")?)
    } else {
        None
    };
    let dev_stderr_log = if paths.mode == Mode::Dev {
        Some(log_file.try_clone().context("clone log handle (dev stderr)")?)
    } else {
        None
    };

    log::info!(
        "starting backend: {} -m uvicorn app:app --port {} (cwd {})",
        paths.python_bin.display(),
        port,
        paths.server_dir.display()
    );

    let mut cmd = Command::new(&paths.python_bin);
    cmd.args([
        "-m",
        "uvicorn",
        "app:app",
        "--host",
        "127.0.0.1",
        "--port",
        &port.to_string(),
    ])
    .current_dir(&paths.server_dir)
    .env("MERIDIAN_DESKTOP", "1")
    // The webview reaches the protocol handler via different URL forms
    // depending on the host OS (see desktopBridge.js for the same logic).
    // The server uses this base to assemble URLs it hands to the webview
    // (extension icons, etc.).
    .env(
        "MERIDIAN_API_BASE",
        if cfg!(target_os = "windows") {
            "http://meridian-api.localhost"
        } else {
            "meridian-api://localhost"
        },
    )
    .env("MERIDIAN_DATA_DIR", &paths.data_dir)
    .env("DATA_DIR", &paths.data_dir)
    .env("DB_PATH", paths.data_dir.join("meridian.db"))
    // Co-locate GAT data with Meridian's per-install data dir instead
    // of GAT's user-home default (~/.gat/server/...). Backups, resets,
    // and uninstalls then target a single tree, and parallel desktop
    // installs don't accidentally share scenarios.
    .env("GAT_DB_PATH", paths.data_dir.join("gat").join("gat_server.duckdb"))
    .env("GAT_DATA_ROOT", paths.data_dir.join("gat").join("scenarios"))
    .env("API_KEY", crate::DESKTOP_API_KEY)
    ;
    // Dev: pipe so we can fan stdout/stderr to both the log file and the
    // developer's terminal. Bundled: hand the file handles directly to the
    // child — same behavior as before.
    if paths.mode == Mode::Dev {
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        // Drop the file handles we no longer need at child setup; the
        // dev_*_log clones outlive this scope and the tee threads own them.
        drop(log_file);
        drop(log_clone);
    } else {
        cmd.stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_clone));
    }

    // Pull any LLM provider keys the user has stored in the OS keychain
    // and inject them as env vars. providers.py reads OPENAI_API_KEY etc.
    // straight from os.environ, so no server-side wiring is needed.
    let stored = crate::secrets::load_all_for_env(&paths.data_dir);
    if !stored.is_empty() {
        log::info!(
            "injecting {} secret(s) from keychain: {}",
            stored.len(),
            stored.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", ")
        );
        for (k, v) in stored {
            cmd.env(k, v);
        }
    }

    let mut child = cmd.spawn().context("spawn uvicorn")?;
    log::info!("backend pid {}", child.id());

    // Dev: fan child's stdout/stderr to both backend.log and the parent
    // process's stderr so `bun run dev` shows live sidecar output in the
    // terminal (instead of running silent).
    if paths.mode == Mode::Dev {
        if let (Some(out), Some(log)) = (child.stdout.take(), dev_stdout_log) {
            tee_to_log_and_stderr(out, log);
        }
        if let (Some(err), Some(log)) = (child.stderr.take(), dev_stderr_log) {
            tee_to_log_and_stderr(err, log);
        }
    }

    write_dev_backend_file(port, &paths.desktop_dir).ok();
    // Also write to the user config dir so the MCP server subprocess can
    // discover the backend regardless of where it was launched from.
    write_backend_config_file(port).ok();

    // Uvicorn takes ~3-8s of cold-start (polars, pyarrow, duckdb, extension
    // discovery, DB restore) before it actually binds the listening socket.
    // If we return Ok before that, the React app fetches /api/* into a
    // closed port and gets ECONNREFUSED.
    if let Err(e) = wait_for_listen(port, &mut child, std::time::Duration::from_secs(90)) {
        let _ = child.kill();
        return Err(e);
    }

    Ok((BackendHandle { child: Some(child) }, port))
}

fn wait_for_listen(
    port: u16,
    child: &mut std::process::Child,
    timeout: std::time::Duration,
) -> Result<()> {
    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    let deadline = Instant::now() + timeout;
    let probe_addr = format!("127.0.0.1:{}", port);
    loop {
        if let Some(status) = child.try_wait().context("try_wait sidecar")? {
            anyhow::bail!("sidecar exited during startup ({status})");
        }
        if TcpStream::connect_timeout(
            &probe_addr.parse().context("parse probe addr")?,
            Duration::from_millis(200),
        )
        .is_ok()
        {
            log::info!("sidecar listening on port {}", port);
            return Ok(());
        }
        if Instant::now() >= deadline {
            anyhow::bail!("sidecar didn't bind port {} within {:?}", port, timeout);
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

// Drop a small JSON file into desktop/ so Vite's dev proxy can route /api
// requests at the sidecar's freshly chosen ephemeral port. The file lives
// outside the build pipeline and is gitignored. Production builds don't
// need this — Tauri's asset/proxy plumbing handles routing there.
fn write_dev_backend_file(port: u16, desktop_dir: &std::path::Path) -> Result<()> {
    let body = format!(
        "{{\n  \"port\": {},\n  \"apiKey\": \"{}\"\n}}\n",
        port,
        crate::DESKTOP_API_KEY
    );
    let path = desktop_dir.join(".dev-backend.json");
    std::fs::write(&path, body).with_context(|| format!("write {}", path.display()))?;
    log::info!("wrote dev backend descriptor: {}", path.display());
    Ok(())
}

/// Write backend connection info to the user config dir so the MCP server
/// subprocess can discover the ephemeral port without the desktop source tree.
/// Path: <config_dir>/meridian/backend.json
fn write_backend_config_file(port: u16) -> Result<()> {
    let Some(config_dir) = dirs::config_dir() else {
        log::warn!("could not determine user config dir; MCP discovery will fall back to .dev-backend.json");
        return Ok(());
    };
    let dir = config_dir.join("meridian");
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create {}", dir.display()))?;
    let path = dir.join("backend.json");
    let body = format!(
        "{{\n  \"port\": {},\n  \"apiKey\": \"{}\"\n}}\n",
        port,
        crate::DESKTOP_API_KEY
    );
    std::fs::write(&path, &body).with_context(|| format!("write {}", path.display()))?;
    log::info!("wrote backend config for MCP: {}", path.display());
    Ok(())
}

fn pick_free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").context("bind ephemeral port")?;
    let port = listener.local_addr().context("local_addr")?.port();
    drop(listener);
    Ok(port)
}

fn cleanup_stale_sidecar(dev_backend_file: &std::path::Path) {
    let Ok(body) = std::fs::read_to_string(dev_backend_file) else {
        return;
    };
    // Cheap manual parse — the file is one we wrote ourselves, no need to
    // pull in serde_json for it.
    let Some(port) = body
        .lines()
        .find_map(|l| l.trim().strip_prefix("\"port\":").and_then(|rest| {
            rest.trim().trim_end_matches(',').trim().parse::<u16>().ok()
        }))
    else {
        return;
    };
    let pid = pid_listening_on(port);
    if let Some(pid) = pid {
        log::warn!("found stale sidecar on port {} (pid {}) — terminating", port, pid);
        #[cfg(unix)]
        unsafe {
            kill(pid, 15);
        }
        // Brief grace window for the orphan to release the port. We don't
        // strictly need to wait, but it makes the launch sequence less
        // racy when something else immediately tries to bind to that port.
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let _ = std::fs::remove_file(dev_backend_file);
}

#[cfg(unix)]
fn pid_listening_on(port: u16) -> Option<i32> {
    use std::process::Command;
    let out = Command::new("lsof")
        .args(["-ti", &format!("tcp:{}", port), "-sTCP:LISTEN"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.split_whitespace().next().and_then(|t| t.parse().ok())
}

#[cfg(not(unix))]
fn pid_listening_on(_port: u16) -> Option<i32> {
    None
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}
#[cfg(unix)]
#[allow(non_snake_case)]
unsafe fn libc_kill(pid: i32, sig: i32) -> i32 {
    kill(pid, sig)
}
