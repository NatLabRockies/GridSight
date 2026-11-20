/**
 * mapCamera — viewport-aware camera constraints shared by the main map
 * (App.jsx) and the control-tab map (MapPanel.jsx).
 *
 * Why this exists: on very tall viewports (e.g. the Insight2D video wall at
 * ~8000+ px high, or Chrome devtools at 9999×8000) zooming out used to lock
 * the camera against the north pole — you could pan east/west but not back
 * south. That's not a MapLibre bug per se: the Web Mercator world is only
 * `TILE_SIZE · 2^zoom` CSS px tall, so once the viewport is taller than the
 * rendered world, MapLibre clamps the center latitude so the map keeps
 * filling the screen vertically. Longitude wraps via world copies (hence the
 * side-to-side panning still works), but there is no vertical world copy, so
 * the camera gets pinned toward the pole.
 *
 * The fix is to enforce a minimum zoom such that the world always fills the
 * viewport vertically. Below that zoom there is genuinely nothing to show
 * above/below the poles, so disallowing it is the correct behaviour.
 */

// MapLibre's default tile size. The full Web Mercator world is
// `TILE_SIZE * 2^zoom` CSS pixels on a side at a given integer zoom.
export const TILE_SIZE = 512;

/**
 * Smallest zoom at which the Mercator world is at least `heightPx` tall, so
 * the camera can pan freely in latitude without being clamped to the pole.
 *
 * @param {number} heightPx  viewport/container height in CSS pixels
 * @param {{ epsilon?: number }} [opts] small margin added so we sit just
 *        above the exact-fill boundary (avoids jitter at the limit)
 * @returns {number} minimum zoom (>= 0)
 */
export function minZoomForHeight(heightPx, { epsilon = 0.02 } = {}) {
  const h = Number.isFinite(heightPx) && heightPx > 0
    ? heightPx
    : (typeof window !== 'undefined' ? window.innerHeight : 1080);
  return Math.max(0, Math.log2(h / TILE_SIZE) + epsilon);
}

/**
 * Read a live MapLibre map's container height and apply the vertical-fill
 * minimum zoom. Idempotent — only calls setMinZoom when the value actually
 * changes. Safe to call on map load and on every 'resize' event.
 *
 * @param {object} map MapLibre GL map handle (from `mapRef.current.getMap()`)
 * @returns {number|undefined} the applied minZoom, or undefined if no map
 */
export function applyVerticalFillMinZoom(map) {
  if (!map || typeof map.getContainer !== 'function') return undefined;
  const container = map.getContainer();
  const heightPx = container?.clientHeight
    || (typeof window !== 'undefined' ? window.innerHeight : 0);
  const maxZoom = typeof map.getMaxZoom === 'function' ? map.getMaxZoom() : 24;
  const minZoom = Math.min(minZoomForHeight(heightPx), maxZoom);
  const current = typeof map.getMinZoom === 'function' ? map.getMinZoom() : null;
  if (current == null || Math.abs(current - minZoom) > 1e-3) {
    map.setMinZoom(minZoom);
  }
  return minZoom;
}

/**
 * Raise the map's render pixel ratio to compensate for CSS scaling.
 *
 * When DisplayScaleProvider applies `body { zoom: S }`, the map element is
 * sized in *logical* px (device / S) so it visually fills the screen, but its
 * GL backing buffer is only `clientSize × devicePixelRatio` — i.e. 1/S of the
 * device resolution, producing soft tiles on a video wall. Setting the
 * pixelRatio to `devicePixelRatio × S` restores a 1:1 device-pixel backing
 * buffer, so the basemap and interleaved deck.gl layers render crisp. The
 * buffer is still clamped by `maxCanvasSize` (16384) at construction.
 *
 * maplibre-gl v4+ only. Idempotent — stashes the last value on the map.
 *
 * @param {object} map MapLibre GL map handle
 * @param {number} displayScale current CSS display scale (1 when unscaled)
 * @returns {number|undefined} the applied pixel ratio
 */
export function applyRenderPixelRatio(map, displayScale) {
  if (!map || typeof map.setPixelRatio !== 'function') return undefined;
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  const ratio = dpr * (displayScale > 0 ? displayScale : 1);
  if (map.__gridsightPixelRatio === ratio) return ratio;
  map.__gridsightPixelRatio = ratio;
  map.setPixelRatio(ratio);
  return ratio;
}
