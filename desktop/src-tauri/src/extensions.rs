//! Tauri commands for user-managed extension lifecycle.
//!
//! Three install paths, all `uv pip install` shells. A successful install
//! lands a package in the venv's site-packages with its entry-points
//! registered; the new extension only appears after the sidecar restarts
//! (entry-points are scanned at startup). We surface that as a separate
//! restart command so the UI can sequence them.

use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, BackendStatus, Paths};

#[derive(Serialize)]
pub struct InstallReport {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub async fn install_extension_from_pypi(
    state: State<'_, AppState>,
    spec: String,
) -> Result<InstallReport, String> {
    let paths = paths_snapshot(&state)?;
    pip_install(&paths, &[spec.as_str()])
}

#[tauri::command]
pub async fn install_extension_from_git(
    state: State<'_, AppState>,
    url: String,
) -> Result<InstallReport, String> {
    let paths = paths_snapshot(&state)?;
    // `git+https://github.com/user/repo.git` (or `git+https://...@<ref>`).
    // If the caller already prefixed `git+` we don't double it.
    let spec = if url.starts_with("git+") {
        url
    } else {
        format!("git+{url}")
    };
    pip_install(&paths, &[spec.as_str()])
}

#[tauri::command]
pub async fn install_extension_from_wheel(
    state: State<'_, AppState>,
    path: String,
) -> Result<InstallReport, String> {
    let paths = paths_snapshot(&state)?;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("file not found: {path}"));
    }

    // Two accepted inputs: a single ``.whl``, or a ``.zip`` containing
    // one or more wheels (the bundle format that GAT's ``make
    // gridsight-bundle`` emits). Bundle case lets us install both
    // ``gat`` and ``gridsight-gat`` in a single click — uv resolves the
    // dependency order from wheel metadata when passed multiple wheels
    // in one invocation.
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".whl") {
        return pip_install(&paths, &[path.as_str()]);
    }
    if lower.ends_with(".zip") {
        return install_wheel_bundle(&paths, p);
    }
    Err(format!("unsupported file type: {path} (expected .whl or .zip)"))
}

fn install_wheel_bundle(paths: &Paths, zip_path: &std::path::Path) -> Result<InstallReport, String> {
    use std::io::Read;

    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("open {}: {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("read zip: {e}"))?;

    let tmp = tempdir_in(&paths.data_dir, "extension_bundle")
        .map_err(|e| format!("tempdir: {e}"))?;
    let mut wheel_paths: Vec<std::path::PathBuf> = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("zip entry {i}: {e}"))?;
        // Only accept wheels. Reject paths with .. or absolute components
        // so a malicious bundle can't drop files outside the temp dir.
        let name = match entry.enclosed_name() {
            Some(n) => n.to_path_buf(),
            None => continue,
        };
        let Some(fname) = name.file_name().and_then(|s| s.to_str()) else { continue };
        if !fname.to_ascii_lowercase().ends_with(".whl") {
            continue;
        }
        let dst = tmp.join(fname);
        let mut out = std::fs::File::create(&dst)
            .map_err(|e| format!("create {}: {e}", dst.display()))?;
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf).map_err(|e| format!("read entry {fname}: {e}"))?;
        std::io::Write::write_all(&mut out, &buf)
            .map_err(|e| format!("write {}: {e}", dst.display()))?;
        wheel_paths.push(dst);
    }

    if wheel_paths.is_empty() {
        return Err(format!(
            "no .whl files found inside {}",
            zip_path.display()
        ));
    }

    log::info!(
        "ext: installing {} wheel(s) from bundle {}",
        wheel_paths.len(),
        zip_path.display()
    );
    let wheel_strs: Vec<&str> = wheel_paths
        .iter()
        .map(|p| p.to_str().unwrap_or(""))
        .filter(|s| !s.is_empty())
        .collect();
    let report = pip_install(paths, &wheel_strs)?;
    // Best-effort cleanup; not fatal if it fails (next launch's tmp prune
    // will handle it).
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(report)
}

/// Make a fresh per-install temp directory under the app's data dir so
/// the extracted wheels stay on the same filesystem as the venv (avoids
/// cross-volume copies during ``uv pip install``).
fn tempdir_in(base: &std::path::Path, prefix: &str) -> std::io::Result<std::path::PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!(".{prefix}-{stamp}"));
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub async fn uninstall_extension(
    state: State<'_, AppState>,
    name: String,
) -> Result<InstallReport, String> {
    let paths = paths_snapshot(&state)?;
    let python = paths
        .python_bin
        .to_str()
        .ok_or_else(|| "python path not utf-8".to_string())?;
    let report = uv(&paths, &["pip", "uninstall", "--python", python, &name])?;
    Ok(report)
}

#[tauri::command]
pub async fn restart_sidecar(app: AppHandle) -> Result<u16, String> {
    let state = app.state::<AppState>();

    // Tear down whatever is running. The Drop impl SIGTERMs the child and
    // waits, so by the time we exit this scope the port is free.
    {
        let mut guard = state.backend.lock();
        guard.shutdown();
    }

    let paths = paths_snapshot(&state)?;

    *state.status.lock() = BackendStatus::Launching;
    let _ = app.emit("backend-status", BackendStatus::Launching);

    match crate::sidecar::spawn(&paths) {
        Ok((handle, port)) => {
            *state.backend.lock() = handle;
            *state.status.lock() = BackendStatus::Ready { port };
            let _ = app.emit("backend-status", BackendStatus::Ready { port });
            Ok(port)
        }
        Err(e) => {
            let msg = format!("sidecar respawn: {e:#}");
            *state.status.lock() = BackendStatus::Failed { error: msg.clone() };
            let _ = app.emit("backend-status", BackendStatus::Failed { error: msg.clone() });
            Err(msg)
        }
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn paths_snapshot(state: &State<'_, AppState>) -> Result<Paths, String> {
    state
        .paths
        .lock()
        .clone()
        .ok_or_else(|| "Python environment not yet provisioned".to_string())
}

fn pip_install(paths: &Paths, args: &[&str]) -> Result<InstallReport, String> {
    let python = paths
        .python_bin
        .to_str()
        .ok_or_else(|| "python path not utf-8".to_string())?;
    let mut full = vec!["pip", "install", "--python", python];
    full.extend_from_slice(args);
    uv(paths, &full)
}

fn uv(paths: &Paths, args: &[&str]) -> Result<InstallReport, String> {
    log::info!("ext: $ {} {}", paths.uv_bin.display(), args.join(" "));
    let output = Command::new(&paths.uv_bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("spawn uv: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Ok(InstallReport {
        ok: output.status.success(),
        stdout,
        stderr,
    })
}
