/**
 * useGpuTimeseries — persisted toggle for the Phase 3 GPU-resident
 * timeseries path on TransmissionLayer (and later GeneratorLayer /
 * generic timeseries layers).
 *
 * When enabled, the worker's whole-partition packed style buffer is
 * uploaded once as an `rgba32float` 2D texture; per-tick CPU is a
 * single `currentIndex` uniform write rather than any per-feature
 * accessor dispatch or attribute upload. This is the only path that
 * keeps per-tick cost flat as feature count scales (10K → 1M).
 *
 * Requires `EXT_color_buffer_float` on WebGL2 — feature detection
 * happens at the layer; if unsupported the layer falls back to the
 * Phase 2 (worker-precompute) path automatically.
 *
 * Persisted in localStorage so operators can A/B against the Phase 2
 * path without losing the choice across reloads.
 */

import { useState, useCallback } from 'react';

const STORAGE_KEY = 'gridsight.useGpuTimeseries';

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function useGpuTimeseries() {
  const [enabled, setEnabledState] = useState(readStored);
  const setEnabled = useCallback((next) => {
    const v = !!next;
    setEnabledState(v);
    try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0'); } catch { /* noop */ }
  }, []);
  return { enabled, setEnabled };
}
