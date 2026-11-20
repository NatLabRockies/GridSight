/**
 * StateBus — session-based state synchronization between browser tabs and machines.
 *
 * Tabs start disconnected. A session is created explicitly (or implicitly via "pop out").
 * Other tabs can discover active sessions via BroadcastChannel heartbeats and join them.
 *
 * Each tab controls per-channel receive/publish toggles within a session.
 *
 * Architecture:
 *   - Discovery channel: all tabs broadcast heartbeats on a shared BroadcastChannel
 *   - Session channel: tabs in the same session exchange state on a session-specific BroadcastChannel
 *   - WebSocket: optional, for cross-machine sessions via server relay
 */

let _seq = 0;

/** Unique ID for this tab, persisted in sessionStorage so refreshes keep the same ID.
 *
 * Gotcha: same-origin popups opened via window.open() inherit a CLONE of the
 * opener's sessionStorage. Without special handling the popup reads the
 * opener's tabId and both tabs believe they share the same identity — which
 * breaks both the discovery heartbeat filter and the cross-tab receive
 * filter (messages get dropped as "from self"). We detect a fresh popup and
 * regenerate, but only once per tab lifetime — subsequent HMR reloads of
 * this module see the window-level sentinel and keep the stored id, so we
 * don't churn tabIds on every dev edit.
 */
const _tabId = (() => {
  const alreadyInit = !!window.__gridsightTabIdInitialized__;
  const isFreshPopup = !alreadyInit && !!window.opener;
  let id = sessionStorage.getItem('gridsight-tab-id');
  if (!id || isFreshPopup) {
    id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem('gridsight-tab-id', id);
  }
  window.__gridsightTabIdInitialized__ = true;
  return id;
})();

/** Per-channel throttle intervals in ms. */
const THROTTLE = {
  cursor: 100,
};

/** All known sync channels. */
export const SYNC_CHANNELS = {
  viewport:            { label: 'Map Viewport',     description: 'Pan, zoom, rotation' },
  controls:            { label: 'Input Controls',   description: 'Slider and control values' },
  'controls:effects':  { label: 'Control Effects',  description: 'Dataset invalidation + layer actions from a remote control commit' },
  'layers:visibility': { label: 'Layer Visibility', description: 'Which layers are shown' },
  'layers:style':      { label: 'Layer Styles',     description: 'Colormaps, opacity, filters' },
  clock:               { label: 'Animation',        description: 'Playback position and speed' },
  scenario:            { label: 'Scenario',         description: 'Active project and scenario' },
  charts:              { label: 'Charts',           description: 'Chart tray contents' },
  story:               { label: 'Story',            description: 'Active story and chapter' },
  extensions:          { label: 'Extensions',       description: 'Enabled/disabled extensions' },
  'layers:catalog':    { label: 'Layer Catalog',    description: 'List of layer ids and names' },
  tooltip:             { label: 'Tooltips',         description: 'Entity click/hover popups' },
  presence:            { label: 'Presence',         description: 'Connected guest roster' },
};

/**
 * Channels where one tab is the authoritative AUTHOR of state changes
 * (the control center) and the other is a passive FOLLOWER (the display).
 * These specifically need one-way to avoid races: viewport (the two maps
 * fly-fight each other) and clock (whoever publishes runs the ticker).
 *
 * Other state channels (layers:visibility, layers:style, scenario, story,
 * extensions) stay BIDIRECTIONAL — the existing useStateBusSync echo guard
 * (`fromBusRef`) prevents loops, and bidirectional flow lets the cascade
 * after a perspective-apply (story → layers/scenario/clock) reach the
 * control panel without extra plumbing.
 */
export const ONE_WAY_STATE_CHANNELS = ['viewport', 'clock'];

/**
 * Source-of-truth metadata channels — the display owns the catalog (what
 * layers/extensions exist) and broadcasts it; the control panel reads.
 */
export const DISPLAY_METADATA_CHANNELS = [
  'layers:catalog',
];

/**
 * Apply the standard sync flags for a given session role. Operators can
 * override per-channel afterwards via the Sync Settings panel; this just
 * sets the right defaults at session-establishment time so the control
 * panel never fights the display for state ownership.
 *
 * @param {object} bus  the singleton state bus
 * @param {'display' | 'control'} role
 */
export function applyRoleDefaults(bus, role) {
  if (role === 'display') {
    // Display follows the control panel: receive state changes, never echo.
    for (const ch of ONE_WAY_STATE_CHANNELS) {
      bus.setChannelSync(ch, { receive: true, publish: false });
    }
    // Display is the source of truth for catalogs.
    for (const ch of DISPLAY_METADATA_CHANNELS) {
      bus.setChannelSync(ch, { receive: true, publish: true });
    }
  } else if (role === 'control') {
    // Control panel pushes state changes; ignores any echoes from display.
    for (const ch of ONE_WAY_STATE_CHANNELS) {
      bus.setChannelSync(ch, { receive: false, publish: true });
    }
    // Control panel reads the catalog but never overrides it.
    for (const ch of DISPLAY_METADATA_CHANNELS) {
      bus.setChannelSync(ch, { receive: true, publish: false });
    }
  }
}

/** Session colors for visual identification. */
const SESSION_COLORS = [
  '#2196f3', '#4caf50', '#ff9800', '#e91e63', '#9c27b0', '#00bcd4', '#ff5722', '#607d8b',
];

function pickSessionColor(sessionId) {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
  return SESSION_COLORS[Math.abs(hash) % SESSION_COLORS.length];
}

// ─── Discovery ────────────────────────────────────────────────────────────

const DISCOVERY_CHANNEL_NAME = 'gridsight-discovery';
const HEARTBEAT_INTERVAL = 2000;
const TAB_TIMEOUT = 6000; // consider tab dead if no heartbeat for this long

class TabDiscovery {
  constructor() {
    this._channel = new BroadcastChannel(DISCOVERY_CHANNEL_NAME);
    this._tabs = new Map(); // tabId → { tabId, title, sessionId, lastSeen, url }
    this._listeners = new Set();
    this._heartbeatTimer = null;
    this._cleanupTimer = null;
    this._sessionId = null;

    this._notifyTimer = null;
    this._channel.onmessage = (e) => this._handleMessage(e.data);
    this._startHeartbeat();
    this._startCleanup();
  }

  getTabId() { return _tabId; }
  getSessionId() { return this._sessionId; }
  setSessionId(id) {
    this._sessionId = id;
    this._beat(); // announce immediately
  }

  /** Get all discovered tabs (excluding self). */
  getTabs() {
    const tabs = [];
    for (const [id, info] of this._tabs) {
      if (id === _tabId) continue;
      tabs.push({ ...info });
    }
    return tabs;
  }

  /** Listen for tab list changes. Returns unsubscribe fn. */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Request a specific tab to flash its border (visual identification). */
  flashTab(tabId) {
    this._channel.postMessage({ type: 'flash', targetTabId: tabId, fromTabId: _tabId });
  }

  destroy() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._channel.postMessage({ type: 'goodbye', tabId: _tabId });
    this._channel.close();
  }

  _beat() {
    this._channel.postMessage({
      type: 'heartbeat',
      tabId: _tabId,
      sessionId: this._sessionId,
      title: document.title,
      url: window.location.href,
      timestamp: Date.now(),
    });
  }

  _startHeartbeat() {
    this._beat();
    this._heartbeatTimer = setInterval(() => this._beat(), HEARTBEAT_INTERVAL);
  }

  _startCleanup() {
    this._cleanupTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, info] of this._tabs) {
        if (now - info.lastSeen > TAB_TIMEOUT) {
          this._tabs.delete(id);
          changed = true;
        }
      }
      if (changed) this._notify();
    }, HEARTBEAT_INTERVAL);
  }

  _handleMessage(msg) {
    if (msg.tabId === _tabId) return; // ignore own messages
    if (msg.type === 'heartbeat') {
      const prev = this._tabs.get(msg.tabId);
      this._tabs.set(msg.tabId, {
        tabId: msg.tabId,
        sessionId: msg.sessionId,
        title: msg.title,
        url: msg.url,
        lastSeen: msg.timestamp,
      });
      // Only notify if something actually changed (new tab or session change)
      if (!prev || prev.sessionId !== msg.sessionId) {
        this._debouncedNotify();
      }
    } else if (msg.type === 'goodbye') {
      if (this._tabs.delete(msg.tabId)) {
        this._debouncedNotify();
      }
    } else if (msg.type === 'flash' && msg.targetTabId === _tabId) {
      bus._flashBorder(msg.fromTabId);
    }
  }

  _debouncedNotify() {
    if (this._notifyTimer) clearTimeout(this._notifyTimer);
    this._notifyTimer = setTimeout(() => {
      this._notifyTimer = null;
      this._notify();
    }, 300);
  }

  _notify() {
    const tabs = this.getTabs();
    for (const fn of this._listeners) {
      try { fn(tabs); } catch (e) { console.warn('[TabDiscovery] listener error:', e); }
    }
  }
}

// ─── Session Transports ───────────────────────────────────────────────────

class SessionBroadcastChannel {
  constructor(sessionId, onMessage) {
    this.type = 'local';
    this._channel = new BroadcastChannel(`gridsight-session-${sessionId}`);
    this._channel.onmessage = (e) => {
      if (e.data && typeof e.data === 'object' && e.data.channel) {
        onMessage(e.data);
      }
    };
  }

  send(msg) { this._channel.postMessage(msg); }
  destroy() { this._channel.close(); }
}

const WS_RECONNECT_BASE = 1000;
const WS_RECONNECT_MAX = 30000;

class SessionWebSocket {
  constructor(sessionKey, onMessage, onStatusChange, opts = {}) {
    this.type = 'remote';
    this._sessionKey = sessionKey;
    this._onMessage = onMessage;
    this._onStatusChange = onStatusChange || (() => {});
    // Guest tabs supply a `ticket` (issued by Bun's /auth/guest/ws-ticket)
    // and an optional `ticketRefresh` async function that returns a fresh
    // ticket on reconnect. Operator tabs leave both undefined.
    this._ticket = opts.ticket || null;
    this._ticketRefresh = typeof opts.ticketRefresh === 'function'
      ? opts.ticketRefresh : null;
    // Optional explicit backend base (e.g. "https://gridsight.example.org" or
    // "http://localhost:5001") for joining a session hosted on a DIFFERENT
    // backend. When unset, the socket targets this page's origin (the
    // same-origin / dev-port-5001 default below).
    this._wsBase = opts.wsBase || null;
    this._ws = null;
    this._destroyed = false;
    this._reconnectDelay = WS_RECONNECT_BASE;
    this._reconnectTimer = null;
    this._queue = [];
    this.status = 'connecting'; // 'connecting', 'connected', 'disconnected'

    this._connect();
  }

  send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(msg));
    } else {
      this._queue.push(msg);
      if (this._queue.length > 200) this._queue.shift();
    }
  }

  destroy() {
    this._destroyed = true;
    this.status = 'disconnected';
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.onclose = null;
      this._ws.close();
    }
    this._onStatusChange('disconnected');
  }

  async _connect() {
    if (this._destroyed) return;
    this.status = 'connecting';
    this._onStatusChange('connecting');

    // Guests need a fresh ticket on every (re)connect because the server
    // consumes them on a successful handshake. Operators don't carry one.
    if (this._ticketRefresh) {
      try {
        this._ticket = await this._ticketRefresh();
      } catch (e) {
        console.warn('[SessionWebSocket] ticket refresh failed:', e);
        this._scheduleReconnect();
        return;
      }
    }

    // Resolve the backend host. An explicit `wsBase` (remote session on
    // another backend) wins; otherwise target this page's origin — in dev
    // connect directly to the Python backend (:5001) to bypass the Vite proxy.
    let wsProto, host;
    if (this._wsBase) {
      const u = new URL(this._wsBase);
      wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      host = u.host;
    } else {
      wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      host = window.location.port === '5173'
        ? `${window.location.hostname}:5001`  // dev: bypass Vite proxy
        : window.location.host;               // prod: same host
    }
    const params = new URLSearchParams();
    if (this._ticket) params.set('ticket', this._ticket);
    // Mark remote-backend sockets so the desktop WebSocket override — which
    // otherwise rewrites every localhost target to its own sidecar port —
    // lets this one through to the actual remote host (e.g. a wall on
    // localhost:3001 in dev). Harmless elsewhere; the server ignores it.
    if (this._wsBase) params.set('gridsight_passthrough', '1');
    const qs = params.toString();
    const url = `${wsProto}//${host}/ws/sync/${encodeURIComponent(this._sessionKey)}${qs ? `?${qs}` : ''}`;

    try {
      this._ws = new WebSocket(url);
    } catch (e) {
      console.warn('[SessionWebSocket] connect error:', e);
      this._scheduleReconnect();
      return;
    }

    this._ws.onopen = () => {
      console.log('[SessionWebSocket] connected, session:', this._sessionKey);
      this._reconnectDelay = WS_RECONNECT_BASE;
      this.status = 'connected';
      this._onStatusChange('connected');
      while (this._queue.length > 0) this.send(this._queue.shift());
    };

    this._ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && typeof msg === 'object' && msg.channel) {
          this._onMessage(msg);
        }
      } catch (e) { /* ignore parse errors */ }
    };

    this._ws.onclose = (event) => {
      console.log('[SessionWebSocket] closed, code:', event.code, 'reason:', event.reason);
      this.status = 'disconnected';
      this._onStatusChange('disconnected');
      if (!this._destroyed) this._scheduleReconnect();
    };

    this._ws.onerror = (e) => {
      console.warn('[SessionWebSocket] error:', e);
    };
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectDelay = Math.min(this._reconnectDelay * 2, WS_RECONNECT_MAX);
      this._connect();
    }, this._reconnectDelay);
  }
}

// ─── StateBus ─────────────────────────────────────────────────────────────

class StateBus {
  constructor() {
    this._subscribers = new Map();
    this._throttleState = new Map();
    this._transports = []; // active session transports (can have both local + remote)
    this._sessionId = null;
    this._sessionType = null;  // 'local', 'remote', or 'both'
    this._remoteSessionKey = null;
    this._syncFlags = new Map(
      Object.keys(SYNC_CHANNELS).map((k) => [k, { receive: true, publish: true }])
    );
    this._syncChangeListeners = new Set();
    this._flashListeners = new Set();
    // Bounded set of recently-seen `(sourceId, timestamp, seq)` keys,
    // used to drop duplicate deliveries when a publish fans out across
    // both BroadcastChannel + WebSocket and the receiver gets the same
    // envelope twice. A source whose seq counter resets (module reload,
    // HMR) still has a fresh timestamp on every new publish, so its
    // post-reload messages never collide with pre-reload entries — the
    // monotonic-seq approach we tried first broke after either tab
    // reloaded.
    this._seenMessages = new Map();  // key -> timestamp (insertion order)
    // Latest presence roster, cached so a UI surface that opens AFTER the
    // server's join/leave broadcast can still read the current peers.
    // The Python sync server only emits 'presence' on add/remove events
    // (no sync-request handler), so a dialog mounted later would see an
    // empty list until the next change. Captured by a permanent
    // subscriber at module load (below).
    this._lastPresence = [];
    this.discovery = new TabDiscovery();
  }

  getTabId() { return _tabId; }
  getSessionId() { return this._sessionId; }

  /** Check if this tab is currently in a session. */
  isConnected() { return this._sessionId !== null && this._transports.length > 0; }

  // ── Session management ──────────────────────────────────────────────

  /**
   * Create a new local session and join it.
   * @returns {string} sessionId
   */
  createSession() {
    const sessionId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.joinSession(sessionId);
    return sessionId;
  }

  /**
   * Join an existing session by ID.
   */
  joinSession(sessionId) {
    // Leave current session if any
    this.leaveSession();

    this._sessionId = sessionId;
    this._sessionType = 'local';
    this._remoteSessionKey = null;
    this._transports.push(new SessionBroadcastChannel(sessionId, (msg) => this.receive(msg)));
    this.discovery.setSessionId(sessionId);
    this._notifySyncChange();
  }

  /**
   * Leave the current session.
   */
  leaveSession() {
    for (const t of this._transports) t.destroy();
    this._transports = [];
    this._sessionId = null;
    this._sessionType = null;
    this._remoteSessionKey = null;
    this.discovery.setSessionId(null);
    this._notifySyncChange();
  }

  // ── Remote sessions (WebSocket, cross-machine) ────────────────────────

  /**
   * Start a remote session. Creates a session key on the server and connects via WebSocket.
   * @returns {Promise<string>} the session key to share with other devices
   */
  async startRemoteSession() {
    this.leaveSession();
    // Ask the server to create a session key
    const resp = await fetch('/api/sync/sessions', { method: 'POST', credentials: 'include' });
    if (!resp.ok) throw new Error(`Failed to create remote session: ${resp.status}`);
    const data = await resp.json();
    const sessionKey = data.session_key;
    this._connectRemote(sessionKey);
    return sessionKey;
  }

  /**
   * Join an existing remote session by key.
   * @param {string} sessionKey
   * @param {object} [opts]
   * @param {string} [opts.ticket] — initial WS handshake ticket (guest only)
   * @param {Function} [opts.ticketRefresh] — async () => ticket; invoked on
   *   each (re)connect because tickets are single-use.
   * @param {string} [opts.wsBase] — backend base URL when the session is
   *   hosted on a DIFFERENT backend (e.g. "https://gridsight.example.org" or, in
   *   dev, "http://localhost:5001"). Omit for a same-origin session.
   */
  joinRemoteSession(sessionKey, opts = {}) {
    this.leaveSession();
    this._connectRemote(sessionKey, opts);
  }

  _connectRemote(sessionKey, opts = {}) {
    this._sessionId = `remote-${sessionKey}`;
    this._sessionType = 'remote';
    this._remoteSessionKey = sessionKey;
    this._remoteWsBase = opts.wsBase || null;
    // Add both transports: local BroadcastChannel (for same-machine tabs)
    // and WebSocket (for cross-machine sync)
    this._transports.push(
      new SessionBroadcastChannel(this._sessionId, (msg) => this.receive(msg)),
    );
    this._transports.push(
      new SessionWebSocket(
        sessionKey,
        (msg) => this.receive(msg),
        (status) => this._notifySyncChange(),
        { ticket: opts.ticket, ticketRefresh: opts.ticketRefresh, wsBase: opts.wsBase },
      ),
    );
    this.discovery.setSessionId(this._sessionId);
    this._notifySyncChange();
  }

  /** Get the remote session key (for sharing). Null if not in a remote session. */
  getRemoteSessionKey() {
    return this._remoteSessionKey || null;
  }

  /** Get session type: 'local', 'remote', or null. */
  getSessionType() {
    return this._sessionType || null;
  }

  /** Get the WebSocket transport status: 'connecting', 'connected', 'disconnected', or null. */
  getRemoteStatus() {
    const ws = this._transports.find((t) => t.type === 'remote');
    return ws ? ws.status : null;
  }

  /**
   * Get the session color for visual identification.
   */
  getSessionColor() {
    return this._sessionId ? pickSessionColor(this._sessionId) : null;
  }

  // ── Sync channel control ──────────────────────────────────────────────

  getChannelSync(channel) {
    return this._syncFlags.get(channel) ?? { receive: true, publish: true };
  }

  setChannelSync(channel, flags) {
    const current = this.getChannelSync(channel);
    this._syncFlags.set(channel, { ...current, ...flags });
    this._notifySyncChange();
  }

  getSyncState() {
    return {
      sessionId: this._sessionId,
      connected: this.isConnected(),
      color: this.getSessionColor(),
      sessionType: this.getSessionType(),
      remoteSessionKey: this.getRemoteSessionKey(),
      remoteStatus: this.getRemoteStatus(),
      channels: Object.fromEntries(this._syncFlags),
    };
  }

  onSyncChange(fn) {
    this._syncChangeListeners.add(fn);
    return () => this._syncChangeListeners.delete(fn);
  }

  _notifySyncChange() {
    const state = this.getSyncState();
    for (const fn of this._syncChangeListeners) {
      try { fn(state); } catch (e) { console.warn('[StateBus] syncChange error:', e); }
    }
  }

  // ── Flash / visual identification ─────────────────────────────────────

  onFlash(fn) {
    this._flashListeners.add(fn);
    return () => this._flashListeners.delete(fn);
  }

  _flashBorder() {
    for (const fn of this._flashListeners) {
      try { fn(); } catch (e) { /* */ }
    }
  }

  // ── URL encoding ──────────────────────────────────────────────────────

  /**
   * Build URL params for opening a new tab that auto-joins this session.
   */
  buildPopoutParams(extraParams = {}) {
    const params = new URLSearchParams();
    if (this._sessionId) {
      params.set('join_session', this._sessionId);
    } else {
      // Create a session on-the-fly
      const sid = this.createSession();
      params.set('join_session', sid);
    }
    for (const [ch, flags] of this._syncFlags) {
      const key = ch.replace(':', '_');
      if (!flags.receive) params.set(`sync_${key}_recv`, '0');
      if (!flags.publish) params.set(`sync_${key}_pub`, '0');
    }
    for (const [k, v] of Object.entries(extraParams)) {
      params.set(k, v);
    }
    return params;
  }

  /**
   * Load session and sync state from URL params (called on tab init).
   */
  loadFromURL() {
    const params = new URLSearchParams(window.location.search);

    // Auto-join session if specified (but don't override an existing session)
    const joinSession = params.get('join_session');
    if (joinSession && !this.isConnected()) {
      this.joinSession(joinSession);
    }

    // Load per-channel sync flags
    for (const [ch] of this._syncFlags) {
      const key = ch.replace(':', '_');
      const recvKey = `sync_${key}_recv`;
      const pubKey = `sync_${key}_pub`;
      const flags = { ...this.getChannelSync(ch) };
      if (params.has(recvKey)) flags.receive = params.get(recvKey) !== '0';
      if (params.has(pubKey)) flags.publish = params.get(pubKey) !== '0';
      this._syncFlags.set(ch, flags);
    }
  }

  // ── Pub/Sub ───────────────────────────────────────────────────────────

  subscribe(channel, handler) {
    if (!this._subscribers.has(channel)) {
      this._subscribers.set(channel, new Set());
    }
    this._subscribers.get(channel).add(handler);
    return () => this._subscribers.get(channel)?.delete(handler);
  }

  /**
   * Publish to the session.
   * @param {string} channel
   * @param {any} payload
   * @param {string} [action='update']
   * @param {object} [opts]
   * @param {string} [opts.targetTabId] — if set, only the tab with this ID
   *   will deliver the message to its subscribers; all others filter it out.
   *   Used by cross-window chart transfer to direct a chart to a specific
   *   peer. The envelope is still broadcast; filtering happens on receive.
   */
  publish(channel, payload, action = 'update', opts = {}) {
    if (this._transports.length === 0) return; // not in a session
    const flags = this.getChannelSync(channel);
    // `opts.force` bypasses the per-channel publish flag — used for
    // initial-state broadcasts and sync-responses, where the receiver
    // explicitly asked for the state and the publish-direction policy
    // shouldn't deny it. The flag also rides on the envelope so the
    // RECEIVER can bypass its own receive flag (otherwise an operator
    // configured "publish-only" never gets the requested initial state).
    if (!flags.publish && !opts.force) return;

    const msg = {
      channel,
      action,
      payload,
      sourceId: _tabId,
      targetTabId: opts.targetTabId || null,
      timestamp: Date.now(),
      seq: ++_seq,
      force: !!opts.force,
    };

    const throttleMs = THROTTLE[channel] || 0;
    if (throttleMs > 0) {
      this._throttledSend(channel, msg, throttleMs);
    } else {
      this._send(msg);
    }
  }

  /**
   * Forward a server-injected message (from the local desktop's MCP bridge)
   * out to the joined session. `receive()` only applies a message to local
   * subscribers and useStateBusSync's echo guard suppresses the would-be
   * republish — so a local MCP change never reaches the synced wall on its
   * own. Re-publishing it here pushes it to peers, respecting per-channel
   * publish flags so the sync toggles still gate what propagates. No-op when
   * not in a session.
   */
  forwardInjected(msg) {
    if (this._transports.length === 0) return;
    if (!msg || !msg.channel) return;
    this.publish(msg.channel, msg.payload, msg.action || 'update');
  }

  receive(msg) {
    if (msg.sourceId === _tabId) return;
    // Targeted messages skip any tab that isn't the intended recipient.
    if (msg.targetTabId && msg.targetTabId !== _tabId) return;
    // Drop duplicate deliveries. A publish fans out to every transport
    // (BroadcastChannel + WebSocket), so a peer on the same machine
    // receives the same envelope from both — without this dedup any
    // non-idempotent handler (e.g. chartDAG.registerChart) creates two
    // copies. Key on (source, timestamp, seq): same-publish duplicates
    // collide; a tab whose _seq counter resets after reload still gets
    // through because Date.now() differs on every fresh publish.
    if (msg.sourceId && Number.isFinite(msg.seq) && Number.isFinite(msg.timestamp)) {
      const key = `${msg.sourceId}:${msg.timestamp}:${msg.seq}`;
      if (this._seenMessages.has(key)) return;
      this._seenMessages.set(key, msg.timestamp);
      // Bound the cache. Map preserves insertion order, so dropping the
      // oldest key is O(1). The cap is generous — even at 100 msg/s
      // that's a 10-second window, well past the cross-transport delay.
      if (this._seenMessages.size > 1000) {
        const oldestKey = this._seenMessages.keys().next().value;
        this._seenMessages.delete(oldestKey);
      }
    }
    const flags = this.getChannelSync(msg.channel);
    // `msg.force` carried by sync-responses and initial-state pushes
    // bypasses the receive flag too — without this, a "publish-only"
    // tab can never see initial state in response to its own request.
    if (!flags.receive && !msg.force) return;

    const handlers = this._subscribers.get(msg.channel);
    if (handlers) {
      for (const fn of handlers) {
        try { fn(msg.payload, msg); } catch (e) {
          console.warn(`[StateBus] subscriber error on '${msg.channel}':`, e);
        }
      }
    }
  }

  // ── Transports ────────────────────────────────────────────────────────

  destroy() {
    for (const t of this._transports) t.destroy();
    this._transports = [];
    this.discovery.destroy();
    this._subscribers.clear();
    this._syncChangeListeners.clear();
    for (const [, state] of this._throttleState) {
      if (state.timer) clearTimeout(state.timer);
    }
    this._throttleState.clear();
  }

  _send(msg) {
    for (const t of this._transports) {
      try { t.send(msg); } catch (e) { console.warn('[StateBus] send error:', e); }
    }
  }

  _throttledSend(channel, msg, intervalMs) {
    let state = this._throttleState.get(channel);
    if (!state) {
      state = { timer: null, pending: null };
      this._throttleState.set(channel, state);
    }
    state.pending = msg;
    if (!state.timer) {
      this._send(msg);
      state.pending = null;
      state.timer = setTimeout(() => {
        state.timer = null;
        if (state.pending) {
          this._send(state.pending);
          state.pending = null;
        }
      }, intervalMs);
    }
  }
}

/** Singleton bus instance. */
export const bus = new StateBus();

// Permanent presence cache. The server emits the full roster only on
// join/leave events; a UI subscriber that mounts later would otherwise
// see [] until the next change. This subscriber runs for the lifetime
// of the bus and stores the latest snapshot on `bus._lastPresence`.
bus.subscribe('presence', (payload) => {
  if (Array.isArray(payload?.peers)) {
    bus._lastPresence = payload.peers;
  }
});

/**
 * Open a new browser tab that auto-joins this tab's session.
 * Creates a session if not already in one.
 * @param {object} [options]
 * @param {string} [options.view] - 'chartTray', 'display', or omit for full
 * @param {object} [options.sync] - per-channel overrides: { viewport: false } or { viewport: { receive: true, publish: false } }
 */
export function openSyncedTab(options = {}) {
  const syncOverrides = {};
  if (options.sync) {
    for (const [ch, val] of Object.entries(options.sync)) {
      if (typeof val === 'boolean') {
        syncOverrides[ch] = { receive: val, publish: val };
      } else {
        syncOverrides[ch] = val;
      }
    }
    // Temporarily apply overrides for URL encoding
    for (const [ch, flags] of Object.entries(syncOverrides)) {
      bus.setChannelSync(ch, flags);
    }
  }

  const extraParams = {};
  if (options.view) extraParams.view = options.view;

  const params = bus.buildPopoutParams(extraParams);
  const base = window.location.origin + window.location.pathname;
  const url = `${base}?${params.toString()}`;
  window.open(url, '_blank');

  // Restore overrides on the parent tab
  if (options.sync) {
    for (const [ch] of Object.entries(syncOverrides)) {
      bus.setChannelSync(ch, { receive: true, publish: true });
    }
  }
}

// ── Cross-environment join helpers ──────────────────────────────────────────

/**
 * The backend origin a remote client should connect to when joining THIS
 * page's session — i.e. the Bun proxy that fronts auth, invites, and the WS
 * relay. In prod the page is served by Bun (same origin); in dev the page is
 * on the Vite server (:5173) while Bun is on :3001.
 */
export function wallBackendOrigin() {
  const { protocol, hostname, port, origin } = window.location;
  if (port === '5173') return `${protocol}//${hostname}:3001`;  // dev: Bun proxy
  return origin;                                                 // prod: served by Bun
}

/** Encode { host, token } into a compact base64url join code to share. */
export function encodeJoinCode({ host, token }) {
  const b64 = btoa(JSON.stringify({ h: host, t: token }));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a join code back to { host, token }, or null if it isn't one. */
export function decodeJoinCode(code) {
  try {
    const b64 = String(code).trim().replace(/-/g, '+').replace(/_/g, '/');
    const obj = JSON.parse(atob(b64));
    if (obj && typeof obj.h === 'string' && typeof obj.t === 'string') {
      return { host: obj.h, token: obj.t };
    }
  } catch (_) { /* not a join code */ }
  return null;
}

/**
 * Pull { host, token } out of a scanned control deep-link, e.g.
 * `https://gridsight.example.org/control/AbC123`. The QR shown in Give Control
 * encodes exactly this URL, so a desktop scanner gets host + token for free.
 */
export function parseControlUrl(str) {
  try {
    const u = new URL(String(str).trim());
    const m = u.pathname.match(/\/control\/([^/?#]+)$/);
    if (m && m[1]) return { host: u.origin, token: decodeURIComponent(m[1]) };
  } catch (_) { /* not a URL */ }
  return null;
}

/**
 * Classify whatever the user typed, pasted, or scanned into the remote-join
 * field. `hostHint` is the desktop's "Host" field — used only for the OTP and
 * bare-session-key shapes, which don't carry a host of their own.
 *
 * Returns one of:
 *   { kind: 'cross-env', host, token }   — join code or scanned /control URL
 *   { kind: 'cross-env', host, otp }     — 6-digit code + the host field
 *   { kind: 'session-key', key }         — bare key against the current backend
 *   null                                 — nothing usable
 *
 * A bare session key carries no invite ticket, so it can't authorize a
 * cross-origin WS — it always takes the same-backend path, ignoring the host
 * field. Only invite-bearing shapes (token / OTP) cross environments.
 */
export function parseJoinInput(input, hostHint) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const url = parseControlUrl(raw);
  if (url) return { kind: 'cross-env', host: url.host, token: url.token };

  const code = decodeJoinCode(raw);
  if (code) return { kind: 'cross-env', host: code.host, token: code.token };

  if (/^\d{6}$/.test(raw)) {
    const host = normalizeHost(hostHint);
    if (!host) return null;  // OTP is meaningless without a host to redeem at
    return { kind: 'cross-env', host, otp: raw };
  }

  return { kind: 'session-key', key: raw };
}

// Remember the last wall host the desktop joined so it's pre-filled next time.
const LAST_REMOTE_HOST_KEY = 'gridsight.lastRemoteHost';

export function getLastRemoteHost() {
  try { return localStorage.getItem(LAST_REMOTE_HOST_KEY) || ''; }
  catch (_) { return ''; }
}

export function setLastRemoteHost(host) {
  try {
    if (host) localStorage.setItem(LAST_REMOTE_HOST_KEY, host);
  } catch (_) { /* private mode / no storage */ }
}

/** Normalize a user-typed host into an origin (adds https:// if no scheme). */
export function normalizeHost(host) {
  const raw = String(host || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

// MCP desktop bridge: apply messages pushed from Claude Desktop via the
// SSE inject stream. desktopBridge.js fires this event; we call receive()
// so the message travels through the normal channel dispatch path.
if (typeof window !== 'undefined') {
  window.addEventListener('gridsight:mcp-bus', (e) => {
    const msg = e.detail;
    if (!msg) return;
    bus.receive(msg);          // apply to this client's local UI
    bus.forwardInjected(msg);  // and push to the joined session (e.g. the wall)
  });
}

export default bus;
