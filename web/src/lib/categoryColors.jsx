/**
 * categoryColors — shared categorical color registry.
 *
 * Provides a React Context so that charts (Plotly, Vega-Lite, ChartGPU) and
 * map layers share the same category → color assignments.  When a user edits
 * a color in any panel the change propagates to every consumer.
 */

import { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';

// ── Palette ──────────────────────────────────────────────────────────────────

// matplotlib Category10 as [r, g, b, alpha=220]
export const CATEGORY10 = [
  [31, 119, 180, 220], [255, 127, 14, 220], [44, 160, 44, 220],
  [214, 39,  40, 220], [148, 103,189, 220], [140, 86,  75, 220],
  [227,119, 194, 220], [127,127, 127, 220], [188,189,  34, 220],
  [23, 190, 207, 220],
];

// ── Color conversion helpers ─────────────────────────────────────────────────

export function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** [r, g, b, a] → '#rrggbb' (alpha ignored — for Vega-Lite / ChartGPU). */
export function rgbaToHex([r, g, b]) {
  return rgbToHex(r, g, b);
}

/** [r, g, b, a] → 'rgba(r,g,b,α)' where α ∈ [0,1] (for Plotly). */
export function rgbaToPlotlyCss([r, g, b, a]) {
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

// ── Auto-assignment ──────────────────────────────────────────────────────────

export function autoAssignColors(values) {
  const result = {};
  values.forEach((v, i) => { result[String(v)] = CATEGORY10[i % CATEGORY10.length]; });
  return result;
}

// ── Context ──────────────────────────────────────────────────────────────────

const CategoryColorContext = createContext(null);

export function CategoryColorProvider({ children }) {
  const [colorMap, setColorMap] = useState({});
  // Ref mirrors state so getColor can be called in loops without stale closures.
  const mapRef = useRef(colorMap);

  /** Return the RGBA for `value`, auto-assigning from CATEGORY10 if new. */
  const getColor = useCallback((value) => {
    const key = String(value);
    if (mapRef.current[key]) return mapRef.current[key];
    const idx = Object.keys(mapRef.current).length;
    const color = CATEGORY10[idx % CATEGORY10.length];
    mapRef.current = { ...mapRef.current, [key]: color };
    // Defer the state update so multiple getColor calls in one render batch together.
    setColorMap(prev => ({ ...prev, [key]: color }));
    return color;
  }, []);

  /** Merge partial updates (e.g. from a color picker). */
  const setColors = useCallback((partial) => {
    setColorMap(prev => {
      const next = { ...prev, ...partial };
      mapRef.current = next;
      return next;
    });
  }, []);

  /** Ensure every value in `values` has a color; returns the full map. */
  const registerCategories = useCallback((values) => {
    let changed = false;
    const next = { ...mapRef.current };
    values.forEach((v) => {
      const key = String(v);
      if (!next[key]) {
        const idx = Object.keys(next).length;
        next[key] = CATEGORY10[idx % CATEGORY10.length];
        changed = true;
      }
    });
    if (changed) {
      mapRef.current = next;
      setColorMap(next);
    }
    return next;
  }, []);

  /** Sorted list of all registered category values. */
  const categories = useMemo(() => Object.keys(colorMap).sort(), [colorMap]);

  const ctx = useMemo(() => ({
    colorMap,
    categories,
    getColor,
    setColors,
    registerCategories,
    rgbaToHex,
    rgbaToPlotlyCss,
  }), [colorMap, categories, getColor, setColors, registerCategories]);

  return (
    <CategoryColorContext.Provider value={ctx}>
      {children}
    </CategoryColorContext.Provider>
  );
}

export function useCategoryColors() {
  const ctx = useContext(CategoryColorContext);
  if (!ctx) throw new Error('useCategoryColors must be used within a CategoryColorProvider');
  return ctx;
}
