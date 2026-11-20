/**
 * requestControl.js
 *
 * Small helpers for cancelling superseded requests. The problem they solve:
 * rapid user actions (clicking many entities in a row, flipping scenarios,
 * panning) each kick off a load, and without cancellation every one runs to
 * completion server-side — a queue of work for results the user has already
 * moved past. These utilities let a caller keep only the LATEST request alive.
 *
 * Two shapes:
 *   - createSuperseder(): plain object for refs / non-component code. Call
 *     next() to abort the previous request and get a fresh AbortSignal.
 *   - useSuperseder(): the same, owned by a component and auto-aborted on
 *     unmount.
 *
 * `apiFetch` already forwards `signal` to fetch, so any loader that threads a
 * `signal` option through participates automatically.
 */
import { useEffect, useRef } from 'react';

/** True for the DOMException fetch throws when its AbortSignal fires. */
export function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 20);
}

/**
 * A single-slot request superseder. `next()` aborts whatever was in flight and
 * returns a fresh signal for the new request; `abort()` cancels without
 * starting a new one (e.g. on unmount).
 */
export function createSuperseder() {
  let ctrl = null;
  return {
    next() {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      return ctrl.signal;
    },
    abort() {
      if (ctrl) { ctrl.abort(); ctrl = null; }
    },
  };
}

/**
 * Component-owned superseder. Stable across renders and aborted on unmount so a
 * pending load can't resolve into a torn-down component.
 * @returns {{ next: () => AbortSignal, abort: () => void }}
 */
export function useSuperseder() {
  const ref = useRef(null);
  if (!ref.current) ref.current = createSuperseder();
  useEffect(() => () => ref.current.abort(), []);
  return ref.current;
}
