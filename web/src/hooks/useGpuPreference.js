/**
 * useGpuPreference — feature-detect WebGPU + persist a user preference.
 *
 * Returns a single object with everything the UI needs to render an
 * informative renderer-status section in Settings. The "active" flag is
 * the only one consumers should pass downstream as the boolean toggle
 * for components like chartgpu-react — it's true only when the browser
 * supports WebGPU AND the user hasn't opted out.
 *
 * The preference is stored in localStorage (key: `meridian.webgpuPreferred`)
 * so toggling it survives reloads. Default depends on environment:
 *   - Desktop (Tauri): ON — the webview is always a secure context and
 *     supports WebGPU on supported hardware.
 *   - Browser: OFF — Meridian deployments aren't guaranteed to serve
 *     over HTTPS, so ChartGPU stays opt-in.
 * An explicit user toggle (`setPreferred`) overrides the default in both.
 *
 *   const gpu = useGpuPreference();
 *
 *   gpu.checked          // adapter probe finished
 *   gpu.supported        // navigator.gpu present + adapter request succeeded
 *   gpu.adapter          // { vendor, architecture } | null
 *   gpu.preferred        // user's stored preference, defaults to false
 *   gpu.setPreferred(b)  // flip the toggle
 *   gpu.active           // supported && preferred — pass this to consumers
 */

import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'meridian.webgpuPreferred';

function isTauriDesktop() {
  // Tauri exposes window.__TAURI__ (or __TAURI_INTERNALS__ in v2 IPC mode)
  // when the page is loaded inside the desktop shell. withGlobalTauri=true
  // in tauri.conf.json guarantees the v1-style global is present.
  return typeof window !== 'undefined'
    && (!!window.__TAURI__ || !!window.__TAURI_INTERNALS__);
}

function defaultPreference() {
  return isTauriDesktop();
}

function readStoredPreference() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === null) return defaultPreference();
    return v !== '0' && v !== 'false';
  } catch {
    return defaultPreference();          // private mode / disabled storage
  }
}

export default function useGpuPreference() {
  const [state, setState] = useState({
    checked: false,
    supported: false,
    adapter: null,
  });
  const [preferred, setPreferredState] = useState(readStoredPreference);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A non-secure context (the display wall is served over plain HTTP)
      // must never report support: navigator.gpu is normally absent there, but
      // check explicitly so the answer doesn't depend on that guarantee.
      const secure = typeof window === 'undefined' || window.isSecureContext !== false;
      if (typeof navigator === 'undefined' || !navigator.gpu || !secure) {
        if (!cancelled) {
          setState({ checked: true, supported: false, adapter: null });
        }
        return;
      }
      try {
        const adapter = await navigator.gpu.requestAdapter();
        const info = adapter && adapter.requestAdapterInfo
          ? await adapter.requestAdapterInfo()
          : null;
        if (cancelled) return;
        setState({
          checked: true,
          supported: !!adapter,
          adapter: info ? {
            vendor: info.vendor || '',
            architecture: info.architecture || '',
            description: info.description || '',
          } : null,
        });
      } catch {
        if (!cancelled) {
          setState({ checked: true, supported: false, adapter: null });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setPreferred = useCallback((next) => {
    const v = !!next;
    setPreferredState(v);
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* noop */ }
  }, []);

  return {
    checked: state.checked,
    supported: state.supported,
    adapter: state.adapter,
    preferred,
    setPreferred,
    active: state.supported && preferred,
  };
}
