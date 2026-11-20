/**
 * viewportSyncMode — opt-in "fit to bounds" mode for cross-display viewport
 * sync.
 *
 * Default sync replicates center + zoom. On displays of different size/aspect
 * (a laptop vs the 15k wall), the same zoom shows a different geographic
 * extent — zoom into New Jersey on the laptop and the wall still shows the
 * surrounding states. With this mode ON, the publisher also sends its visible
 * lat/lon BOUNDS and the receiver calls `fitBounds`, so each display frames
 * the same geography regardless of its dimensions.
 *
 * Off by default — most local setups have similar screens and want exact
 * center/zoom replication. Toggle in Sync Settings, via `setViewportFitBounds`,
 * or with `?fitBounds=1` (sticky).
 */

const KEY = 'meridian.viewportFitBounds';

let enabled = false;
try {
  const params = new URLSearchParams(window.location.search);
  if (params.get('fitBounds') === '1') {
    enabled = true;
    localStorage.setItem(KEY, '1');
  } else {
    enabled = localStorage.getItem(KEY) === '1';
  }
} catch { /* SSR / no window */ }

const subscribers = new Set();

export function getViewportFitBounds() {
  return enabled;
}

export function setViewportFitBounds(on) {
  enabled = !!on;
  try {
    if (enabled) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* noop */ }
  for (const fn of subscribers) {
    try { fn(enabled); } catch { /* noop */ }
  }
}

export function subscribeViewportFitBounds(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
