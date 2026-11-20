// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod claude;
mod extensions;
mod protocol;
mod secrets;
mod setup;
mod sidecar;

use std::path::PathBuf;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

// Static API key used between the bundled UI and the sidecar. The sidecar
// only accepts connections on 127.0.0.1, and the key is generated/persisted
// per-install (TODO milestone 3); for now it's a constant so the auth check
// matches what we set in the sidecar env and what the bridge sends.
pub const DESKTOP_API_KEY: &str = "desktop-local-key";

#[derive(Default)]
pub(crate) struct AppState {
    pub(crate) backend: Mutex<sidecar::BackendHandle>,
    pub(crate) status: Mutex<BackendStatus>,
    /// Populated once provisioning has resolved real paths. Commands that
    /// need the venv's uv/python binaries (extension install, etc.) wait
    /// on this — they're only meaningful after a successful boot.
    pub(crate) paths: Mutex<Option<Paths>>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum BackendStatus {
    #[default]
    Starting,
    Provisioning { message: String },
    Launching,
    Ready { port: u16 },
    Failed { error: String },
}

#[tauri::command]
fn get_backend_status(state: State<AppState>) -> BackendStatus {
    state.status.lock().clone()
}

#[tauri::command]
fn get_backend_url(state: State<AppState>) -> Option<String> {
    match &*state.status.lock() {
        BackendStatus::Ready { port } => Some(format!("http://127.0.0.1:{port}")),
        _ => None,
    }
}

#[tauri::command]
fn get_api_key() -> &'static str {
    DESKTOP_API_KEY
}

#[tauri::command]
async fn open_window(
    app: tauri::AppHandle,
    label: String,
    url: String,
    title: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    use tauri::webview::WebviewWindowBuilder;
    use tauri::WebviewUrl;

    // Labels must be unique. If the caller reuses one, focus the existing
    // window instead of erroring — matches browser `window.open(url, name)`
    // semantics where reusing a name targets the same window.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        let _ = existing.eval(format!("window.location.href = {};", json_str(&url)));
        return Ok(());
    }

    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .title(title.as_deref().unwrap_or("GridSight"))
        .inner_size(width.unwrap_or(1200.0), height.unwrap_or(800.0))
        // Keep pop-out windows (chart trays, wall views) running while
        // hidden, like the main window: agents drive and capture them.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .build()
        .map_err(|e| format!("create window: {e}"))?;
    Ok(())
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// Send every Rust-side log line to the same ``backend.log`` the
/// sidecar uvicorn writes to. The webview's ``console.*`` calls reach
/// the same file via ``log_event`` below, so a single ``tail -f`` shows
/// everything that happened during an interaction. Sidecar and Rust use
/// different timestamp formats but the contents are unambiguous because
/// of source prefixes (``[server]`` from uvicorn vs ``[desktop]`` from
/// here vs ``[webview:…]`` from console forwarding).
fn init_logging() {
    use std::io::Write;
    let log_dir = platform_log_dir();
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("backend.log");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path);

    let mut builder = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    );
    builder.format(|buf, record| {
        let ts = buf.timestamp_millis();
        writeln!(
            buf,
            "[desktop] {} {} {} | {}",
            ts,
            record.level(),
            record.target(),
            record.args(),
        )
    });
    if let Ok(f) = file {
        builder.target(env_logger::Target::Pipe(Box::new(f)));
    }
    builder.init();
    log::info!("logging initialised → {}", log_path.display());
}

/// Webview-side log forwarder. ``desktopBridge.js`` overrides
/// ``console.{log,info,warn,error,debug}`` and invokes this command
/// for every call so all browser-side activity lands in the same
/// ``backend.log`` as Rust + sidecar logs. ``window.onerror`` and
/// ``unhandledrejection`` also funnel through here, so crashes that
/// would otherwise sit silently in DevTools are visible from the file.
#[tauri::command]
fn log_event(level: String, source: String, message: String) {
    let lvl = match level.to_ascii_lowercase().as_str() {
        "error" => log::Level::Error,
        "warn" | "warning" => log::Level::Warn,
        "debug" => log::Level::Debug,
        "trace" => log::Level::Trace,
        _ => log::Level::Info,
    };
    // Use a distinct target so the line reads ``[desktop] ... webview:console | message``.
    log::log!(target: &format!("webview:{}", source), lvl, "{}", message);
}

fn emit_status(app: &AppHandle, status: BackendStatus) {
    if let Some(state) = app.try_state::<AppState>() {
        *state.status.lock() = status.clone();
    }
    if let Err(e) = app.emit("backend-status", status) {
        log::warn!("emit backend-status failed: {e}");
    }
}

fn main() {
    init_logging();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_backend_status,
            get_backend_url,
            get_api_key,
            open_window,
            log_event,
            extensions::install_extension_from_pypi,
            extensions::install_extension_from_git,
            extensions::install_extension_from_wheel,
            extensions::uninstall_extension,
            extensions::restart_sidecar,
            secrets::set_secret,
            secrets::has_secret,
            secrets::delete_secret,
            secrets::list_secret_names,
            claude::get_mcp_info,
            claude::configure_claude_desktop,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                bootstrap(handle).await;
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the main window's lifecycle controls the sidecar. Popout
            // windows (chart tray, control panel) come and go without
            // touching the backend.
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    state.backend.lock().shutdown();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building GridSight desktop")
        .run(|app, event| {
            // Quit (⌘Q, menu, osascript) can end the process before the main
            // window's Destroyed event runs; stop the sidecar here as well so
            // it is not left running on its port.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.backend.lock().shutdown();
                }
            }
        });
}

async fn bootstrap(app: AppHandle) {
    emit_status(&app, BackendStatus::Starting);

    let paths = match resolve_paths(&app) {
        Ok(p) => p,
        Err(e) => {
            emit_status(&app, BackendStatus::Failed { error: format!("path resolution: {e}") });
            return;
        }
    };

    let progress_app = app.clone();
    let provision_result = tauri::async_runtime::spawn_blocking(move || {
        setup::provision(&paths, |msg| {
            emit_status(&progress_app, BackendStatus::Provisioning { message: msg.into() });
        })
    })
    .await;

    let paths = match provision_result {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            emit_status(&app, BackendStatus::Failed { error: format!("provision: {e:#}") });
            return;
        }
        Err(join_err) => {
            emit_status(&app, BackendStatus::Failed { error: format!("provision task crashed: {join_err}") });
            return;
        }
    };

    emit_status(&app, BackendStatus::Launching);

    let state = app.state::<AppState>();
    *state.paths.lock() = Some(paths.clone());
    match sidecar::spawn(&paths) {
        Ok((handle, port)) => {
            *state.backend.lock() = handle;
            emit_status(&app, BackendStatus::Ready { port });
            spawn_watchdog(app.clone());
        }
        Err(e) => {
            emit_status(&app, BackendStatus::Failed { error: format!("sidecar: {e:#}") });
        }
    }
}

/// Polls the sidecar child every few seconds. If the process has exited
/// (uvicorn crash, OOM-killed, etc.) we respawn it transparently so the
/// next webview request just works after a short hiccup — restarting the
/// whole Tauri app for a backend crash is a terrible UX.
fn spawn_watchdog(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        use std::time::Duration;
        loop {
            tokio::time::sleep(Duration::from_secs(3)).await;

            let exited = {
                let state = match app.try_state::<AppState>() {
                    Some(s) => s,
                    None => continue,
                };
                let was_ready = matches!(*state.status.lock(), BackendStatus::Ready { .. });
                if !was_ready {
                    None
                } else {
                    state.backend.lock().check_exited()
                }
            };

            let Some(status) = exited else { continue };
            log::warn!("watchdog: sidecar exited ({}); respawning", status);

            let paths = match app.state::<AppState>().paths.lock().clone() {
                Some(p) => p,
                None => {
                    log::error!("watchdog: paths missing; cannot respawn");
                    continue;
                }
            };

            emit_status(&app, BackendStatus::Launching);
            // Drop the dead handle before respawning so the new child
            // owns the slot cleanly.
            *app.state::<AppState>().backend.lock() = sidecar::BackendHandle::default();

            match sidecar::spawn(&paths) {
                Ok((handle, port)) => {
                    *app.state::<AppState>().backend.lock() = handle;
                    emit_status(&app, BackendStatus::Ready { port });
                    log::info!("watchdog: respawn ok, port {}", port);
                }
                Err(e) => {
                    let msg = format!("watchdog respawn: {e:#}");
                    log::error!("{msg}");
                    emit_status(&app, BackendStatus::Failed { error: msg });
                }
            }
        }
    });
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// `bun run dev` — uv syncs against the live server/pyproject.toml in
    /// the repo, with editable sibling packages.
    Dev,
    /// Packaged build — install from bundled requirements.txt + wheels.
    /// No repo on disk, no editable references.
    Bundled,
}

#[derive(Clone)]
pub struct Paths {
    pub mode: Mode,
    pub uv_bin: PathBuf,
    pub data_dir: PathBuf,
    pub venv_dir: PathBuf,
    pub python_bin: PathBuf,
    /// Source tree uvicorn runs from (`cd` here before `python -m uvicorn`).
    /// In dev: live repo's server/. In bundled mode: frozen copy in
    /// resource_dir/server/.
    pub server_dir: PathBuf,
    pub log_dir: PathBuf,
    pub desktop_dir: PathBuf,
    /// Only populated in bundled mode.
    pub requirements: Option<PathBuf>,
    pub wheels_dir: Option<PathBuf>,
}

fn resolve_paths(app: &AppHandle) -> anyhow::Result<Paths> {
    use anyhow::Context;

    let data_dir = dirs::data_dir()
        .context("could not resolve OS data dir")?
        .join("GridSight");
    let cache_dir = dirs::cache_dir()
        .context("could not resolve OS cache dir")?
        .join("GridSight");
    let log_dir = platform_log_dir();

    std::fs::create_dir_all(&data_dir).context("create data dir")?;
    std::fs::create_dir_all(&cache_dir).context("create cache dir")?;
    std::fs::create_dir_all(&log_dir).ok();

    // Tier-1 cleanup: previous releases dumped venv + logs inside the data
    // dir. Migrate them out on first launch with this layout. Idempotent —
    // once moved, the legacy paths no longer exist.
    migrate_legacy_layout(&data_dir, &cache_dir, &log_dir);

    let venv_dir = cache_dir.join("venv");
    let python_bin = if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    };

    // Debug builds (``cargo build``, ``bun run dev``) ALWAYS use the
    // dev-mode path — editable installs of the sibling repos via
    // ``uv sync`` against the local server's pyproject. Otherwise a
    // stale ``resources/wheels/`` left over from a prior
    // ``bun run build`` would shadow the local source edits, and the
    // venv would be running prebuilt wheels even though the developer
    // is editing the GAT / gridsight-gat source live. Release builds
    // ship without the local repo at all, so they need the bundled
    // resources (.app at install time has no ``~/code/GAT``).
    let bundled_server = if cfg!(debug_assertions) {
        None
    } else {
        app
            .path()
            .resource_dir()
            .ok()
            .map(|r| r.join("resources").join("server"))
            .filter(|p| p.exists())
    };

    let (mode, server_dir, desktop_dir, requirements, wheels_dir, uv_bin) =
        if let Some(server_dir) = bundled_server {
            let resource_dir = app.path().resource_dir().context("resource_dir")?;
            let res = resource_dir.join("resources");
            let uv_name = if cfg!(windows) { "uv.exe" } else { "uv" };
            let uv_path = resource_dir.join("binaries").join(uv_name);
            (
                Mode::Bundled,
                server_dir.clone(),
                resource_dir.clone(),
                Some(res.join("requirements.txt")),
                Some(res.join("wheels")),
                uv_path,
            )
        } else {
            let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let desktop_dir = manifest_dir
                .parent()
                .context("desktop parent dir")?
                .to_path_buf();
            let repo_root = desktop_dir.parent().context("repo root")?.to_path_buf();
            (
                Mode::Dev,
                repo_root.join("server"),
                desktop_dir,
                None,
                None,
                locate_uv(app, &manifest_dir)?,
            )
        };

    log::info!(
        "resolved mode={:?}, server={}, uv={}",
        mode,
        server_dir.display(),
        uv_bin.display()
    );

    Ok(Paths {
        mode,
        uv_bin,
        data_dir,
        venv_dir,
        python_bin,
        server_dir,
        log_dir,
        desktop_dir,
        requirements,
        wheels_dir,
    })
}

/// Per-OS log directory. macOS has a dedicated `~/Library/Logs/<App>`
/// spot; Linux and Windows don't, so we tuck logs under the cache root.
fn platform_log_dir() -> PathBuf {
    if cfg!(target_os = "macos") {
        if let Some(home) = dirs::home_dir() {
            return home.join("Library").join("Logs").join("GridSight");
        }
    }
    // Linux + Windows + macOS fallback: <cache>/GridSight/Logs.
    // (Linux has $XDG_STATE_HOME conceptually but `dirs::state_dir()` is
    // None on macOS/Windows, so we don't get cross-platform consistency
    // from it. Cache-adjacent is conventional enough.)
    dirs::cache_dir()
        .map(|c| c.join("GridSight").join("Logs"))
        .unwrap_or_else(|| PathBuf::from("./logs"))
}

/// Pre-Tier-1 builds wrote both the Python venv and the log directory
/// inside the OS data dir. Newer builds split them out. On first launch
/// with the new layout, move existing data so users don't lose their venv
/// (avoiding a forced reinstall) or their backend logs.
fn migrate_legacy_layout(data_dir: &std::path::Path, cache_dir: &std::path::Path, log_dir: &std::path::Path) {
    let old_venv = data_dir.join("venv");
    let new_venv = cache_dir.join("venv");
    if old_venv.exists() && !new_venv.exists() {
        log::info!("migrating venv: {} → {}", old_venv.display(), new_venv.display());
        if let Err(e) = std::fs::rename(&old_venv, &new_venv) {
            // Cross-device rename can fail (e.g. data on one volume, cache
            // on another). Falling back to "leave it where it is" means a
            // fresh venv gets built; not pretty but not destructive.
            log::warn!("venv migration failed ({e}); will provision a fresh one");
        }
    }

    let old_logs = data_dir.join("logs");
    if old_logs.exists() && old_logs != *log_dir {
        log::info!("migrating logs: {} → {}", old_logs.display(), log_dir.display());
        let _ = std::fs::create_dir_all(log_dir);
        // Move each file individually so a partially-populated destination
        // doesn't block migration.
        if let Ok(entries) = std::fs::read_dir(&old_logs) {
            for entry in entries.flatten() {
                let src = entry.path();
                let dst = log_dir.join(entry.file_name());
                if !dst.exists() {
                    let _ = std::fs::rename(&src, &dst);
                }
            }
            let _ = std::fs::remove_dir(&old_logs);
        }
    }
}

fn locate_uv(app: &AppHandle, manifest_dir: &std::path::Path) -> anyhow::Result<PathBuf> {
    let exe_name = if cfg!(windows) { "uv.exe" } else { "uv" };

    // 1) Bundled as a Tauri resource
    if let Ok(resource_dir) = app.path().resource_dir() {
        let p = resource_dir.join("binaries").join(exe_name);
        if p.exists() {
            return Ok(p);
        }
    }

    // 2) Dev location alongside the cargo manifest
    let dev = manifest_dir.join("binaries").join(exe_name);
    if dev.exists() {
        return Ok(dev);
    }

    // 3) Fall back to PATH
    log::warn!("bundled uv not found at {} — falling back to PATH lookup", dev.display());
    Ok(PathBuf::from("uv"))
}
