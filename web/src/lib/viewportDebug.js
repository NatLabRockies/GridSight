/**
 * viewportDebug — opt-in instrumentation for the map camera + viewport sync.
 *
 * Motivated by hard-to-reproduce large-display bugs (camera locking at the
 * pole, lat/lon drifting out of sync between displays) that don't reproduce
 * on a normal monitor and where the affected machine may not have devtools
 * open. Enable with `?debugViewport=1` in the URL (sticky via localStorage)
 * or by calling `setViewportDebug(true)` from the console.
 *
 * When enabled it (a) console.logs structured camera/sync events and (b)
 * publishes a live snapshot to `window.__gridsightViewport` and notifies
 * subscribers, which the on-screen ViewportDebugHUD renders.
 */

const STORAGE_KEY = 'gridsight.debugViewport';

let enabled = false;
try {
  const params = new URLSearchParams(window.location.search);
  if (params.get('debugViewport') === '1') {
    enabled = true;
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* noop */ }
  } else if (localStorage.getItem(STORAGE_KEY) === '1') {
    enabled = true;
  }
} catch { /* SSR / no window */ }

const subscribers = new Set();
const snapshot = {};

export function viewportDebugEnabled() {
  return enabled;
}

export function setViewportDebug(on) {
  enabled = !!on;
  try {
    if (enabled) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* noop */ }
  emit();
}

/** Subscribe to snapshot changes. Returns an unsubscribe fn. */
export function subscribeViewportDebug(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit() {
  for (const fn of subscribers) {
    try { fn(snapshot); } catch { /* noop */ }
  }
}

/**
 * Record a viewport/camera event. No-op unless debug is enabled.
 *
 * @param {string} tag  short event name, e.g. 'publish', 'receive', 'moveEnd'
 * @param {object} data structured payload (lat/lon/zoom/minZoom/size/…)
 */
export function logViewport(tag, data) {
  if (!enabled) return;
  const entry = { ...data, t: tag };
  snapshot[tag] = entry;
  snapshot.last = entry;
  try {
    if (typeof window !== 'undefined') window.__gridsightViewport = snapshot;
  } catch { /* noop */ }
  // eslint-disable-next-line no-console
  console.log(`[viewport:${tag}]`, data);
  emit();
}
