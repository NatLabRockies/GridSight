import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';

// CSS `zoom` on body scales every rendered pixel — typography, MUI components,
// and the deck.gl/MapLibre canvas alike. Used to make the UI legible on the
// Insight2D video wall (9–12 4K displays, ~15000×6000+).

const STORAGE_KEY = 'gridsight-display-scale';

export const SCALE_MODES = ['auto', '1x', '1.25x', '1.5x', '2x', '3x'];
const MODE_TO_SCALE = { '1x': 1, '1.25x': 1.25, '1.5x': 1.5, '2x': 2, '3x': 3 };

function autoScaleFor(width, height) {
  // Auto-scale is for the NREL viz wall (9–12 4K displays at ~15000×6000+).
  // Personal monitors — including 5K Apple Studio Displays and 5K2K
  // ultrawides — stay at 1x because CSS `body { zoom: scale }` upscales
  // the MapLibre canvas display size without growing the GL backing
  // buffer, producing soft tiles. Users on individual large displays who
  // want bigger UI can still pick 1.25×/1.5×/2× manually in Settings.
  const w = width ?? 0;
  const h = height ?? 0;
  if (w >= 15000 || h >= 6000) return 3;
  if (w >= 10000) return 2;
  if (w >= 7680) return 1.5;
  return 1;
}

function loadSavedMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SCALE_MODES.includes(saved)) return saved;
  } catch {}
  return 'auto';
}

const DisplayScaleContext = createContext({
  mode: 'auto',
  scale: 1,
  autoScale: 1,
  setMode: () => {},
});

export function useDisplayScale() {
  return useContext(DisplayScaleContext);
}

export function DisplayScaleProvider({ children }) {
  const [mode, setModeRaw] = useState(loadSavedMode);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 0,
    height: typeof window !== 'undefined' ? window.innerHeight : 0,
  }));

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const autoScale = useMemo(
    () => autoScaleFor(viewport.width, viewport.height),
    [viewport.width, viewport.height],
  );
  const scale = mode === 'auto' ? autoScale : (MODE_TO_SCALE[mode] ?? 1);

  useEffect(() => {
    // `zoom` is non-standard but well-supported (Chromium, WebKit, Firefox 126+)
    // and is the only CSS property that scales layout + hit-testing + fonts
    // together without breaking deck.gl pointer coordinates.
    document.body.style.zoom = scale === 1 ? '' : String(scale);
    // Counter-zoom rule for internally-anchored MUI menus (Select dropdowns,
    // tagged `zoom-counter-menu` via the theme) so they don't double-apply the
    // body zoom and drift off their control. Undoes the zoom on their portal
    // root → correct position (at normal size). Menus with an explicit
    // anchorEl use zoomAnchorProps instead and are not tagged.
    let counterEl = document.getElementById('gridsight-menu-counter-zoom');
    if (!counterEl) {
      counterEl = document.createElement('style');
      counterEl.id = 'gridsight-menu-counter-zoom';
      document.head.appendChild(counterEl);
    }
    counterEl.textContent = scale === 1 ? '' : `.zoom-counter-menu { zoom: ${1 / scale}; }`;
    return () => {
      // Clear BOTH together so the counter rule can never outlive the body
      // zoom (a stale counter without the matching zoom mis-positions menus).
      document.body.style.zoom = '';
      if (counterEl) counterEl.textContent = '';
    };
  }, [scale]);

  const setMode = useCallback((next) => {
    if (!SCALE_MODES.includes(next)) return;
    setModeRaw(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  }, []);

  const ctx = useMemo(
    () => ({ mode, scale, autoScale, setMode }),
    [mode, scale, autoScale, setMode],
  );

  return (
    <DisplayScaleContext.Provider value={ctx}>
      {children}
    </DisplayScaleContext.Provider>
  );
}
