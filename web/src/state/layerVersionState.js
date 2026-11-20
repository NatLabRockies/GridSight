/**
 * useLayerVersionState — bumped counters used as React keys/triggers
 * for data refresh paths:
 *   - tsVersion: increment when timeseries values shift (clock tick,
 *     dataset reload). Drives MapView's updateTriggers.
 *   - staticVersion: same idea for static (non-timeseries) datasets.
 *   - inputControlRefreshKey: bumped by AI control changes to
 *     invalidate downstream chart-data fetches.
 *
 * Grouped because they're all "monotonic counter the renderer keys off
 * of" with identical update shape — bump by one.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  tsVersion: 0,
  staticVersion: 0,
  inputControlRefreshKey: 0,
};

export function reducer(state, action) {
  switch (action.type) {
    case 'bumpTs':
      return { ...state, tsVersion: state.tsVersion + 1 };
    case 'bumpStatic':
      return { ...state, staticVersion: state.staticVersion + 1 };
    case 'bumpInputControl':
      return { ...state, inputControlRefreshKey: state.inputControlRefreshKey + 1 };
    // Absolute setters — needed by useStateBusSync, which mirrors a
    // remote counter and expects ``setValue(received)`` semantics.
    case 'setTs':
      return { ...state, tsVersion: action.value };
    case 'setStatic':
      return { ...state, staticVersion: action.value };
    case 'setInputControl':
      return { ...state, inputControlRefreshKey: action.value };
    case 'reset':
      return INITIAL;
    default:
      return state;
  }
}

export function useLayerVersionState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const bumpTs = useCallback(() => dispatch({ type: 'bumpTs' }), []);
  const bumpStatic = useCallback(() => dispatch({ type: 'bumpStatic' }), []);
  const bumpInputControl = useCallback(() => dispatch({ type: 'bumpInputControl' }), []);
  const setTs = useCallback((value) => dispatch({ type: 'setTs', value }), []);
  const setStatic = useCallback((value) => dispatch({ type: 'setStatic', value }), []);
  const setInputControl = useCallback(
    (value) => dispatch({ type: 'setInputControl', value }), [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  return {
    state,
    bumpTs, bumpStatic, bumpInputControl,
    setTs, setStatic, setInputControl,
    reset,
  };
}
