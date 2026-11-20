/**
 * useWorkerPrecompute — persisted toggle for the Phase 2 Web Worker
 * precompute path on TransmissionLayer / GeneratorLayer.
 *
 * When enabled, per-(timestep × feature) style buffers are computed once
 * per partition load in a Web Worker and bound as typed-array prop values
 * each tick (the "binary attribute escape hatch"). This bypasses deck.gl's
 * per-feature accessor dispatch — the dominant ~25 ms `updateAttributesTime`
 * cost at the 200 ms tick rate.
 *
 * Persisted in localStorage so operators can A/B against the inline path
 * without losing the choice across reloads.
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'meridian.useWorkerPrecompute';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function useWorkerPrecompute() {
  const [enabled, setEnabledState] = useState(readStored);
  const setEnabled = useCallback((next) => {
    const v = !!next;
    setEnabledState(v);
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* noop */ }
  }, []);
  return { enabled, setEnabled };
}
