/**
 * desktopBridge.js
 *
 * When the React app runs inside the Tauri desktop shell, two things differ
 * from the Bun-proxy web mode that the rest of the code assumes:
 *
 *   1. The auth endpoints (/auth/session, /auth/login, /auth/logout) don't
 *      exist on the Python backend — Bun owns those in web mode. We mock
 *      them here so AuthContext sees a permanent operator session.
 *   2. The WebSocket sync URL is constructed from window.location in
 *      stateBus.js, which produces the wrong host:port inside the Tauri
 *      webview. We wrap WebSocket to redirect localhost connections to
 *      the sidecar port we read from Tauri.
 *
 * /api/* requests are *not* touched here — Vite's dev proxy reads
 * desktop/.dev-backend.json on every request and routes them at the
 * sidecar (injecting the API key), so call sites stay same-origin and
 * cookie/CORS issues never arise. The same mechanism will be replaced by
 * Tauri's asset-protocol proxy in production (M3 work).
 */

const AUTH_PREFIX = '/auth/';
const API_PREFIX = '/api/';

// Custom URI scheme registered in Rust (src-tauri/src/protocol.rs). The
// handler proxies requests to the sidecar's HTTP endpoint, injects the
// API key, and returns the response. We pick a scheme that's distinct
// from Tauri's default asset scheme so we don't have to override the
// built-in static-file serving.
//
// Tauri 2 exposes custom protocols at different URL forms per OS:
//   macOS / Linux : <scheme>://localhost/<path>
//   Windows       : http://<scheme>.localhost/<path>
// We pick the right form at runtime so the rest of the bridge can stay
// platform-agnostic.
const API_SCHEME_HOST = (() => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/windows/i.test(ua)) return 'http://gridsight-api.localhost';
  return 'gridsight-api://localhost';
})();

let _installed = false;

// Verbose log forwarding (every console.log/info/debug + every XHR
// open/send/load) is invaluable during desktop debugging but spams
// ``backend.log`` in steady state. Default off; flip with
// ``localStorage.setItem('gridsight.verbose', '1')`` and reload.
// warn/error and abnormal XHR terminal states (error/abort/timeout) are
// always forwarded — those are the signals you actually want to find.
function isVerbose() {
  try {
    return typeof localStorage !== 'undefined'
      && localStorage.getItem('gridsight.verbose') === '1';
  } catch (_) {
    return false;
  }
}

export function isTauri() {
  if (typeof window === 'undefined') return false;
  return (
    typeof window.__TAURI_INTERNALS__ !== 'undefined' ||
    window.isTauri === true ||
    typeof window.__TAURI__ !== 'undefined'
  );
}

/**
 * pickFilesNative — open Tauri's native file dialog and return objects
 * shaped like File but carrying an absolute ``path`` field. The upload
 * loaders detect ``.path`` and short-circuit to the
 * ``/upload-local`` / ``/preview-local`` endpoints, which means the
 * file bytes never have to traverse the multipart upload path inside
 * the local machine.
 *
 * Caller use it from a "Browse…" button in the upload dialogs when
 * ``isTauri()`` is true:
 *
 *     const files = await pickFilesNative({ multiple: true, filters: [
 *       { name: 'HDF5', extensions: ['h5', 'h5.gz'] },
 *     ] });
 *
 * Returns ``[]`` when the user cancels.
 *
 * @param {{ multiple?: boolean, directory?: boolean, filters?: Array }} [opts]
 * @returns {Promise<Array<{ name: string, path: string, size: number }>>}
 */
export async function pickFilesNative(opts = {}) {
  if (!isTauri()) {
    throw new Error('pickFilesNative is only available in the Tauri desktop shell');
  }
  // The dialog plugin lives under @tauri-apps/plugin-dialog; the Cargo
  // side already lists tauri-plugin-dialog v2. Import dynamically so
  // the web bundle doesn't try to resolve it at static-analysis time.
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({
    multiple: !!opts.multiple,
    directory: !!opts.directory,
    filters: opts.filters,
    title: opts.title,
  });
  if (picked == null) return [];
  const paths = Array.isArray(picked) ? picked : [picked];
  return paths.map((p) => {
    const name = p.split('/').pop() || p;
    // ``size`` would require an extra ``stat`` round-trip; the upload
    // dialogs use ``size`` only for the progress bar's denominator,
    // and the local upload path skips the byte-progress phase anyway.
    // Leave it 0; UI falls back to indeterminate.
    return { name, path: p, size: 0, __nativePick: true };
  });
}

export async function initDesktopBridge({ onProgress } = {}) {
  if (!isTauri()) {
    // Plain browser (dev.sh or deployed web wall display): no Tauri APIs, but
    // we still want to receive MCP-driven bus commands. Subscribe to the SSE
    // stream over the same-origin proxy (which injects auth). Empty apiKey
    // → installMcpSseListener uses the relative URL.
    if (!_installed) {
      installMcpSseListener('', '');
      _installed = true;
    }
    return { tauri: false, mcpBridge: true };
  }
  if (_installed) return { tauri: true, alreadyInstalled: true };

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  const backendUrl = await waitForBackend({ invoke, listen, onProgress });

  installConsoleForwarder(invoke);
  installAuthMock();
  installXhrOverride();
  installWebSocketOverride(backendUrl);
  installWindowOpenOverride(invoke);

  const apiKey = await invoke('get_api_key');
  installMcpSseListener(backendUrl, apiKey);

  window.__GRIDSIGHT__ = { backendUrl, apiKey };

  _installed = true;
  return { tauri: true, backendUrl };
}

// ---------------------------------------------------------------------------
// Backend readiness — same shape as before, but the URL is only used for
// the WebSocket redirect now.
// ---------------------------------------------------------------------------

function waitForBackend({ invoke, listen, onProgress }) {
  return new Promise((resolve, reject) => {
    let unlisten = null;
    let settled = false;

    const finish = (urlOrErr, isErr = false) => {
      if (settled) return;
      settled = true;
      if (unlisten) try { unlisten(); } catch (_) { /* ignore */ }
      isErr ? reject(urlOrErr) : resolve(urlOrErr);
    };

    const tryUrl = (status) => {
      if (!status) return false;
      onProgress?.(status);
      if (status.phase === 'ready' && Number.isInteger(status.port)) {
        finish(`http://127.0.0.1:${status.port}`);
        return true;
      }
      if (status.phase === 'failed') {
        finish(new Error(`Sidecar failed: ${status.error}`), true);
        return true;
      }
      return false;
    };

    listen('backend-status', (event) => tryUrl(event.payload))
      .then((u) => { unlisten = u; })
      .catch(() => { /* ignore — invoke path below also reports */ });

    invoke('get_backend_status').then(tryUrl).catch(() => { /* event will deliver */ });
  });
}

// ---------------------------------------------------------------------------
// /auth/* mock
// ---------------------------------------------------------------------------

function installAuthMock() {
  const originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init = {}) {
    const reqUrl = typeof input === 'string' ? input : (input?.url ?? '');

    if (reqUrl.startsWith(AUTH_PREFIX)) {
      const mocked = mockAuthResponse(reqUrl);
      if (mocked) return mocked;
    }

    // Rewrite same-origin /api/* requests to the gridsight-api:// scheme so
    // the Rust protocol handler proxies them to the sidecar. Works in dev
    // and packaged builds with the same wiring — replaces the Vite proxy.
    // We force credentials:'omit' because (a) auth is via API key header,
    // not cookies, and (b) wildcard Access-Control-Allow-Origin is rejected
    // by browsers when credentials are included.
    if (reqUrl.startsWith(API_PREFIX)) {
      const rewritten = API_SCHEME_HOST + reqUrl;
      const finalInit = { ...init, credentials: 'omit' };
      if (typeof input === 'string') {
        return originalFetch(rewritten, finalInit);
      }
      return originalFetch(new Request(rewritten, input), finalInit);
    }

    return originalFetch(input, init);
  };
}

function mockAuthResponse(path) {
  if (path === '/auth/session') {
    return jsonResponse({
      authenticated: true,
      user: 'desktop',
      mode: 'operator',
      permissions: null,
    });
  }
  if (path === '/auth/login') return jsonResponse({ ok: true, user: 'desktop' });
  if (path === '/auth/logout') return jsonResponse({ ok: true });
  return null;
}

function jsonResponse(body, init = {}) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    }),
  );
}

// ---------------------------------------------------------------------------
// WebSocket
//
// stateBus.js builds the URL from window.location → in dev mode it
// hardcodes `${hostname}:5001` (which is wrong; our sidecar is on an
// ephemeral port). We wrap the WebSocket constructor with a Proxy that
// rewrites any localhost-y target to the actual sidecar port we got from
// Tauri. WebSocket isn't subject to the CORS-preflight rules that block
// cross-origin fetch in WebKit, so a direct connection works fine.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Console + crash forwarder
//
// All ``console.{log,info,warn,error,debug}`` calls in the webview get
// mirrored to the Rust side, which logs them to the same ``backend.log``
// file the sidecar writes to. Same goes for uncaught errors and
// unhandled promise rejections. The point is debuggability: a single
// ``tail -f ~/Library/Logs/GridSight/backend.log`` shows everything that
// happened across the three processes during an interaction.
//
// We intentionally don't strip arguments — JSON-serialize when we can,
// fall back to ``String(x)`` otherwise. The volume is fine for normal
// usage; if it ever isn't we'll add a log-level cap.
// ---------------------------------------------------------------------------

function installConsoleForwarder(invoke) {
  const original = {
    log: console.log.bind(console),
    info: (console.info || console.log).bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: (console.debug || console.log).bind(console),
  };

  const fmt = (args) => {
    try {
      return args.map((a) => {
        if (a == null) return String(a);
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack || ''}`;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ');
    } catch (e) {
      return `<fmt error: ${e}>`;
    }
  };

  const forward = (level, source, args) => {
    // Fire-and-forget. Don't await; don't await-chain via console (would
    // re-enter the forwarder). Swallow errors silently — the original
    // console call still ran below.
    try {
      invoke('log_event', { level, source, message: fmt(args) }).catch(() => {});
    } catch (_) {
      /* the bridge isn't fully ready yet */
    }
  };

  // warn/error always forwarded — those are the signals worth keeping.
  // log/info/debug only when verbose so steady-state logs stay readable.
  console.log   = (...args) => { if (isVerbose()) forward('info',  'log',   args); original.log(...args); };
  console.info  = (...args) => { if (isVerbose()) forward('info',  'info',  args); original.info(...args); };
  console.warn  = (...args) => { forward('warn',  'warn',  args); original.warn(...args); };
  console.error = (...args) => { forward('error', 'error', args); original.error(...args); };
  console.debug = (...args) => { if (isVerbose()) forward('debug', 'debug', args); original.debug(...args); };

  // Anything that escaped a try/catch lands here. Without this hook,
  // webview-side crashes are invisible from the file logs.
  window.addEventListener('error', (e) => {
    forward('error', 'window.error',
      [`${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
       e.error?.stack || '']);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    forward('error', 'unhandledrejection',
      [r?.stack || (r && r.message) || String(r)]);
  });

  forward('info', 'bridge', ['console forwarder installed']);
}

// ---------------------------------------------------------------------------
// XMLHttpRequest override
//
// loaders.uploadToExtension uses XHR (not fetch) because it needs
// upload-progress events for the multi-GB Sienna H5 — fetch's upload
// progress story is much newer and not universally available. XHR
// bypasses the fetch override in installAuthMock above, so without
// this patch the upload POST hits ``/api/extensions/gat/upload/...``
// against the webview origin (tauri://localhost in packaged builds,
// http://localhost:5173 in dev) — neither resolves, and WebKit
// surfaces a misleading 401.
// ---------------------------------------------------------------------------

function installXhrOverride() {
  const RealXHR = window.XMLHttpRequest;
  const origOpen = RealXHR.prototype.open;
  const origSend = RealXHR.prototype.send;

  RealXHR.prototype.open = function patchedOpen(method, url, async, user, password) {
    let rewritten = url;
    if (typeof url === 'string' && url.startsWith(API_PREFIX)) {
      rewritten = API_SCHEME_HOST + url;
    }
    // Stash for the matching send() log line.
    try { this.__bridgeUrl = rewritten; this.__bridgeMethod = method; } catch (_) {}
    if (isVerbose()) console.log('[xhr] open', method, url, '→', rewritten);
    return origOpen.call(
      this, method, rewritten,
      async !== undefined ? async : true,
      user, password,
    );
  };

  RealXHR.prototype.send = function patchedSend(body) {
    const method = this.__bridgeMethod || '?';
    const url = this.__bridgeUrl || '?';
    let bodyKind = 'none';
    let bodySize = 0;
    if (body instanceof FormData) {
      bodyKind = 'FormData';
      try {
        for (const [k, v] of body.entries()) {
          if (v instanceof Blob) bodySize += v.size;
          else bodySize += String(v).length;
        }
      } catch (_) {}
    } else if (body instanceof Blob) {
      bodyKind = 'Blob'; bodySize = body.size;
    } else if (typeof body === 'string') {
      bodyKind = 'string'; bodySize = body.length;
    } else if (body) {
      bodyKind = typeof body;
    }
    if (isVerbose()) console.log('[xhr] send', method, url, `body=${bodyKind}(${bodySize}B)`);
    // Terminal-state listeners. ``load`` is verbose-only; the abnormal
    // terminations stay on so XHR failures are still traceable.
    this.addEventListener('load', () => {
      if (isVerbose()) console.log('[xhr] load', method, url, 'status=', this.status);
    });
    this.addEventListener('error', () => {
      console.error('[xhr] error', method, url, 'status=', this.status,
        'readyState=', this.readyState);
    });
    this.addEventListener('abort', () => {
      console.warn('[xhr] abort', method, url);
    });
    this.addEventListener('timeout', () => {
      console.warn('[xhr] timeout', method, url);
    });
    return origSend.call(this, body);
  };
}

// ---------------------------------------------------------------------------
// window.open → Tauri WebviewWindow
//
// stateBus.openSyncedTab() opens chart-tray / control-panel popouts via
// `window.open(url, '_blank')`. In a Tauri webview, that pops the system
// browser, which can't see the sidecar. Route it through a Tauri command
// that creates a native window pointed at the same URL — same origin, so
// BroadcastChannel discovery picks the new window up automatically.
// ---------------------------------------------------------------------------

function installWindowOpenOverride(invoke) {
  const originalOpen = window.open.bind(window);

  window.open = function patchedOpen(url, target, features) {
    if (!url) return originalOpen(url, target, features);
    const urlStr = typeof url === 'string' ? url : url.toString();

    // Same-origin (or relative) URLs are popouts of the React app; route to
    // a Tauri window. External URLs (http://github.com/..., mailto:, etc.)
    // should still go through the system handler.
    let isInternal = false;
    try {
      const parsed = new URL(urlStr, window.location.href);
      isInternal =
        parsed.origin === window.location.origin ||
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === 'tauri.localhost' ||
        parsed.hostname.endsWith('.localhost');
    } catch (_) { /* assume external */ }

    if (!isInternal) {
      return originalOpen(url, target, features);
    }

    const label = `popout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    invoke('open_window', {
      label,
      url: new URL(urlStr, window.location.href).toString(),
      title: 'GridSight',
      width: 1200,
      height: 800,
    }).catch((e) => console.error('[desktopBridge] open_window failed:', e));

    // openSyncedTab() ignores the return value; null mirrors what
    // window.open returns when a popup is blocked.
    return null;
  };
}

// ---------------------------------------------------------------------------
// MCP SSE bridge
//
// Claude Desktop pushes bus commands via POST /internal/bus/inject. The
// server fans those out over a Server-Sent Events stream that the frontend
// subscribes to here. Each event is dispatched as a 'gridsight:mcp-bus'
// CustomEvent; stateBus.js calls bus.receive() on it so the local UI
// updates exactly as if the message came from a WebSocket sync peer.
//
// EventSource reconnects automatically on network hiccup, but we also
// add a manual retry on error so transient sidecar restarts recover.
// ---------------------------------------------------------------------------

function installMcpSseListener(backendUrl, apiKey) {
  // Tauri: absolute backend URL + api_key query (EventSource can't set headers).
  // Browser: same-origin relative URL — the bun/vite proxy injects the API key
  // header, so the page never holds the secret.
  const url = apiKey
    ? `${backendUrl}/internal/bus/stream?api_key=${encodeURIComponent(apiKey)}`
    : `/internal/bus/stream`;

  const connect = () => {
    const es = new EventSource(url);

    es.addEventListener('connected', () => {
      console.info('[desktopBridge] MCP SSE stream connected');
    });

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        window.dispatchEvent(new CustomEvent('gridsight:mcp-bus', { detail: msg }));
      } catch (e) {
        console.warn('[desktopBridge] bad MCP SSE message:', event.data, e);
      }
    };

    es.onerror = () => {
      es.close();
      setTimeout(connect, 3000);
    };
  };

  connect();
}

function installWebSocketOverride(backendUrl) {
  const { hostname: backendHost, port: backendPort } = new URL(backendUrl);
  const RealWebSocket = window.WebSocket;

  const Patched = new Proxy(RealWebSocket, {
    construct(_target, args) {
      const [rawUrl, ...rest] = args;
      let url = rawUrl;
      try {
        const parsed = new URL(rawUrl, window.location.href);
        // A remote sync socket (joining a wall on another backend) carries
        // this marker — leave it pointed at the real remote host instead of
        // rewriting it to our local sidecar. Without this, a dev wall on
        // localhost:3001 would be hijacked back to the desktop's own backend.
        if (parsed.searchParams.get('gridsight_passthrough') === '1') {
          return new RealWebSocket(rawUrl, ...rest);
        }
        if (
          parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === 'tauri.localhost' ||
          parsed.hostname.endsWith('.localhost')
        ) {
          parsed.hostname = backendHost;
          parsed.port = backendPort;
          parsed.protocol = parsed.protocol === 'wss:' ? 'wss:' : 'ws:';
          url = parsed.toString();
        }
      } catch (_) { /* leave unparsable URLs alone */ }
      return new RealWebSocket(url, ...rest);
    },
  });

  window.WebSocket = Patched;
}
