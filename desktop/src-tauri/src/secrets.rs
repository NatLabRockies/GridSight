//! OS-keychain-backed storage for LLM provider API keys.
//!
//! Secret *values* live in the OS keychain (macOS Keychain, Windows
//! Credential Manager, Linux Secret Service). The keyring crate has no
//! portable enumeration API, so we keep a small JSON index of *names* in
//! the data dir. When the sidecar spawns, we walk that index and re-fetch
//! each secret to inject it as an environment variable — providers.py
//! already reads `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / etc., so the
//! server needs no changes to pick them up.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use keyring::Entry;
use tauri::State;

use crate::AppState;

const SERVICE: &str = "GridSight";

fn index_path(data_dir: &Path) -> PathBuf {
    data_dir.join("secrets-index.json")
}

fn load_index(data_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(index_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

fn save_index(data_dir: &Path, names: &[String]) -> Result<()> {
    let p = index_path(data_dir);
    let body = serde_json::to_vec_pretty(names).context("serialize secrets index")?;
    std::fs::write(&p, body).with_context(|| format!("write {}", p.display()))
}

fn data_dir_from_state(state: &State<AppState>) -> Result<PathBuf, String> {
    state
        .paths
        .lock()
        .as_ref()
        .map(|p| p.data_dir.clone())
        .ok_or_else(|| "paths not yet initialised".to_string())
}

#[tauri::command]
pub fn set_secret(
    state: State<AppState>,
    name: String,
    value: String,
) -> Result<(), String> {
    let data_dir = data_dir_from_state(&state)?;
    let entry = Entry::new(SERVICE, &name).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())?;
    let mut idx = load_index(&data_dir);
    if !idx.iter().any(|n| n == &name) {
        idx.push(name);
        save_index(&data_dir, &idx).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Returns Ok(true) if a value exists for `name`, Ok(false) otherwise.
/// We deliberately don't return the plaintext to the webview — the UI only
/// needs to know whether a key is set, not what it is. If a user wants to
/// rotate, they re-enter the value.
#[tauri::command]
pub fn has_secret(name: String) -> Result<bool, String> {
    let entry = Entry::new(SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_secret(state: State<AppState>, name: String) -> Result<(), String> {
    let data_dir = data_dir_from_state(&state)?;
    let entry = Entry::new(SERVICE, &name).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    let mut idx = load_index(&data_dir);
    idx.retain(|n| n != &name);
    save_index(&data_dir, &idx).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_secret_names(state: State<AppState>) -> Result<Vec<String>, String> {
    let data_dir = data_dir_from_state(&state)?;
    Ok(load_index(&data_dir))
}

/// Fetch every stored secret as `(name, value)` pairs. Called from the
/// sidecar spawn path to inject keys as environment variables. Silently
/// skips entries whose index pointer no longer matches a keychain entry
/// — that just means the user deleted it from Keychain Access manually,
/// which is fine.
pub fn load_all_for_env(data_dir: &Path) -> Vec<(String, String)> {
    let names = load_index(data_dir);
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let Ok(entry) = Entry::new(SERVICE, &name) else { continue };
        match entry.get_password() {
            Ok(value) => out.push((name, value)),
            Err(keyring::Error::NoEntry) => {}
            Err(e) => log::warn!("secrets: read {} failed: {}", name, e),
        }
    }
    out
}
