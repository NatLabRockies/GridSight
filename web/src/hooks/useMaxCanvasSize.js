/**
 * useMaxCanvasSize — persisted [width, height] cap for MapLibre's drawing canvas.
 *
 * `maxCanvasSize` is a CEILING, not an allocation. MapLibre sizes its
 * backing buffer to `min(viewport × devicePixelRatio, maxCanvasSize)` —
 * setting a larger cap doesn't reserve memory until the viewport actually
 * needs it. The desktop app can't reload itself easily, so we default to
 * WebGL's max texture size on every modern GPU (16384 × 16384). That
 * covers a maximized 6K Pro Display XDR on retina (12032 × 6768 backing
 * pixels) and the 100 MP viz wall in one stroke.
 *
 * Users can still pin a smaller value via Settings → Apply (e.g. to
 * deliberately limit GPU memory on a constrained machine). The pinned
 * value wins until Reset clears the localStorage entry.
 *
 * Note: maplibre-gl reads `maxCanvasSize` at map construction, so changing
 * this value while the app is open requires a reload to take effect.
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'gridsight.maxCanvasSize';
// WebGL's typical MAX_TEXTURE_SIZE on desktop GPUs. Apple Silicon, recent
// AMD/NVIDIA, and recent Intel iGPUs all report 16384.
const DEFAULT_WIDTH = 16384;
const DEFAULT_HEIGHT = 16384;

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    const parsed = JSON.parse(raw);
    const w = Number.isFinite(parsed.width)  && parsed.width  > 0 ? parsed.width  : DEFAULT_WIDTH;
    const h = Number.isFinite(parsed.height) && parsed.height > 0 ? parsed.height : DEFAULT_HEIGHT;
    return { width: w, height: h };
  } catch {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  }
}

export default function useMaxCanvasSize() {
  const [{ width, height }, setSize] = useState(readStored);

  const setBoth = useCallback((w, h) => {
    const nw = Number.isFinite(w) && w > 0 ? Math.floor(w) : DEFAULT_WIDTH;
    const nh = Number.isFinite(h) && h > 0 ? Math.floor(h) : DEFAULT_HEIGHT;
    setSize({ width: nw, height: nh });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: nw, height: nh })); } catch { /* noop */ }
  }, []);

  // Reset clears the storage entry too, so the next reload picks up any
  // future change to DEFAULT_WIDTH/HEIGHT.
  const reset = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* noop */ }
    setSize({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  }, []);

  return {
    width, height,
    setSize: setBoth,
    reset,
    defaultWidth: DEFAULT_WIDTH,
    defaultHeight: DEFAULT_HEIGHT,
  };
}
