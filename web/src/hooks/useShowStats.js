/**
 * useShowStats — persisted toggle for deck.gl's StatsWidget overlay.
 *
 * Used by the renderer/debug section in Settings. Stored in
 * localStorage so the choice survives reloads — handy when running
 * an A/B comparison after toggling the WebGPU preference.
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'meridian.showStatsWidget';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function useShowStats() {
  const [show, setShowState] = useState(readStored);
  const setShow = useCallback((next) => {
    const v = !!next;
    setShowState(v);
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* noop */ }
  }, []);
  return { show, setShow };
}
