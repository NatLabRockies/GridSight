//! Tauri commands for Claude / MCP agent integration setup.
//!
//! Exposes the paths needed to configure an MCP client (Claude Desktop,
//! Claude Code, etc.) and optionally auto-writes the entry into
//! `claude_desktop_config.json` so users don't have to do it by hand.

use serde::Serialize;
use tauri::State;

use crate::AppState;

// ── path helpers ─────────────────────────────────────────────────────────────

/// Platform path to claude_desktop_config.json.
/// macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
/// Windows: %APPDATA%\Claude\claude_desktop_config.json
/// Linux:   ~/.config/Claude/claude_desktop_config.json
fn claude_config_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|d| d.join("Claude").join("claude_desktop_config.json"))
}

fn is_already_configured() -> bool {
    let Some(path) = claude_config_path() else { return false };
    let Ok(content) = std::fs::read_to_string(&path) else { return false };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { return false };
    json.get("mcpServers")
        .and_then(|s| s.get("meridian"))
        .is_some()
}

// ── commands ─────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct McpInfo {
    /// Absolute path to the bundled Python interpreter.
    pub python_bin: String,
    /// Absolute path to mcp_server.py inside the bundle.
    pub mcp_server_path: String,
    /// Absolute path where claude_desktop_config.json lives (may not exist yet).
    pub claude_config_path: String,
    /// True if the meridian entry is already present in the config file.
    pub is_configured: bool,
}

#[tauri::command]
pub async fn get_mcp_info(state: State<'_, AppState>) -> Result<McpInfo, String> {
    let paths = state
        .paths
        .lock()
        .clone()
        .ok_or_else(|| "Python environment not yet provisioned".to_string())?;

    let mcp_server_path = paths.server_dir.join("mcp_server.py");
    let claude_config = claude_config_path()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    Ok(McpInfo {
        python_bin: paths.python_bin.to_string_lossy().into_owned(),
        mcp_server_path: mcp_server_path.to_string_lossy().into_owned(),
        claude_config_path: claude_config,
        is_configured: is_already_configured(),
    })
}

/// Write (or merge) the Meridian MCP server entry into claude_desktop_config.json.
/// Preserves all existing keys — only adds/replaces `mcpServers.meridian`.
/// Returns the path that was written.
#[tauri::command]
pub async fn configure_claude_desktop(state: State<'_, AppState>) -> Result<String, String> {
    let paths = state
        .paths
        .lock()
        .clone()
        .ok_or_else(|| "Python environment not yet provisioned".to_string())?;

    let mcp_server_path = paths.server_dir.join("mcp_server.py");
    let python_bin = paths.python_bin.to_string_lossy().into_owned();
    let mcp_path = mcp_server_path.to_string_lossy().into_owned();

    let config_path = claude_config_path()
        .ok_or_else(|| "Could not determine Claude config directory".to_string())?;

    // Read existing config or start fresh.
    let mut config: serde_json::Value = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("read {}: {e}", config_path.display()))?;
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    // Ensure mcpServers object exists, then upsert the meridian entry.
    if !config.get("mcpServers").map_or(false, |v| v.is_object()) {
        config["mcpServers"] = serde_json::json!({});
    }
    config["mcpServers"]["meridian"] = serde_json::json!({
        "command": python_bin,
        "args": [mcp_path]
    });

    // Write — create the Claude config directory if it doesn't exist yet.
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let output = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(&config_path, output)
        .map_err(|e| format!("write {}: {e}", config_path.display()))?;

    log::info!("wrote Meridian MCP entry to {}", config_path.display());
    Ok(config_path.to_string_lossy().into_owned())
}
