/**
 * Thin wrapper around the desktop shell's keychain-backed secrets API.
 *
 * All four commands no-op (or throw) outside of Tauri. UI that calls
 * these should gate on ``isTauri()`` first — there's no web-mode
 * equivalent yet (and shouldn't be: in web mode the deployment admin
 * sets API keys via env vars on the server container).
 */
import { isTauri } from './desktopBridge.js';

function invoke(...args) {
  if (!isTauri()) {
    return Promise.reject(new Error('secrets API is only available in the desktop app'));
  }
  return window.__TAURI__.core.invoke(...args);
}

export function isSecretsAvailable() {
  return isTauri();
}

export async function setSecret(name, value) {
  return invoke('set_secret', { name, value });
}

export async function hasSecret(name) {
  return invoke('has_secret', { name });
}

export async function deleteSecret(name) {
  return invoke('delete_secret', { name });
}

export async function listSecretNames() {
  return invoke('list_secret_names');
}

/**
 * Restart the Python sidecar so newly-saved keys take effect. The Rust
 * command tears down the current child, walks the secrets index, and
 * re-spawns with the new env. Callers should await this before
 * re-fetching ``/api/chat/config``.
 */
export async function restartSidecar() {
  return invoke('restart_sidecar');
}
