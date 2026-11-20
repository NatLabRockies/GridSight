/**
 * useForceDpr1 — persisted toggle to force deck.gl's `useDevicePixelRatio={1}`.
 *
 * On high-DPR displays (especially the 100 MP video wall at the NREL viz
 * center), rendering at native DPR can be 4× the fragment work of rendering
 * at 1×. This toggle lets operators switch deck.gl into 1:1 pixel rendering
 * for fragment-bound scenes; markers and lines lose a touch of edge crispness
 * but the GPU has 4× the headroom to maintain 60 fps. Stored in localStorage
 * so the choice survives reloads.
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'gridsight.forceDpr1';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function useForceDpr1() {
  const [enabled, setEnabledState] = useState(readStored);
  const setEnabled = useCallback((next) => {
    const v = !!next;
    setEnabledState(v);
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* noop */ }
  }, []);
  return { enabled, setEnabled };
}
