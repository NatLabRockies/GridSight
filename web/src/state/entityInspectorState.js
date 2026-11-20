/**
 * useEntityInspectorState — async fetch state for the entity tooltip /
 * inspector panel. Three async surfaces (full year for histogram +
 * heatmap, windowed for the line chart, extension controls + charts)
 * each have data + loading + error fields that should be updated
 * together.
 *
 * Grouping reasons: previously 11 separate ``useState`` calls. Setting
 * ``data`` without clearing ``error`` (and vice versa) was easy to
 * forget; reducer actions ``fullStart``/``fullSuccess``/``fullError``
 * make the trio atomic.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  // Full-year timeseries (consumed by heatmap + histogram).
  fullTimeseries: null,
  loadingFull: false,
  // Rolling-window timeseries (consumed by the LineScrubber chart).
  windowedTimeseries: null,
  loadingWindow: false,
  loadedRange: null,        // { fromMs, toMs } | null — the cache window
  // Extension data-controls.
  controls: [],
  controlsLoading: false,
  controlsError: null,
  // Extension chart specs.
  chartSpecs: [],
  chartsLoading: false,
  // Section collapse map — keyed by section name.
  // ``infocard`` starts collapsed so the timeseries chart isn't pushed
  // off-screen by sparse generator metadata.
  collapsedSections: { infocard: true },
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':                  return { ...state, ...action.patch };
    case 'reset':                return INITIAL;

    case 'fullStart':            return { ...state, loadingFull: true };
    case 'fullSuccess':          return { ...state, loadingFull: false, fullTimeseries: action.value };
    case 'fullError':            return { ...state, loadingFull: false, fullTimeseries: null };
    case 'clearFull':            return { ...state, fullTimeseries: null };

    case 'windowStart':          return { ...state, loadingWindow: true };
    case 'windowSuccess':        return { ...state, loadingWindow: false, windowedTimeseries: action.value };
    case 'windowError':          return { ...state, loadingWindow: false, windowedTimeseries: null };
    case 'clearWindow':          return { ...state, windowedTimeseries: null };

    case 'setLoadedRange':       return { ...state, loadedRange: action.value };

    case 'controlsStart':
      return { ...state, controlsLoading: true, controlsError: null };
    case 'controlsSuccess':
      return { ...state, controlsLoading: false, controls: action.value, controlsError: null };
    case 'controlsError':
      return { ...state, controlsLoading: false, controls: [], controlsError: action.error };
    case 'controlsPatch':
      // Used when a single control's value changes; rewrite the matching
      // entry in-place to avoid an extra round-trip.
      return {
        ...state,
        controls: state.controls.map((c) =>
          c.name === action.name ? { ...c, ...action.patch } : c,
        ),
      };
    case 'clearControls':
      return { ...state, controls: [], controlsError: null };

    case 'chartSpecsStart':
      return { ...state, chartsLoading: true };
    case 'chartSpecsSuccess':
      return { ...state, chartsLoading: false, chartSpecs: action.value };
    case 'chartSpecsError':
      return { ...state, chartsLoading: false, chartSpecs: [] };
    case 'clearChartSpecs':
      return { ...state, chartSpecs: [] };

    case 'toggleSection':
      return {
        ...state,
        collapsedSections: {
          ...state.collapsedSections,
          [action.name]: !state.collapsedSections[action.name],
        },
      };
    case 'setCollapsedSections':
      return { ...state, collapsedSections: action.value };

    default:
      return state;
  }
}

export function useEntityInspectorState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const fullStart = useCallback(() => dispatch({ type: 'fullStart' }), []);
  const fullSuccess = useCallback((value) => dispatch({ type: 'fullSuccess', value }), []);
  const fullError = useCallback(() => dispatch({ type: 'fullError' }), []);
  const clearFull = useCallback(() => dispatch({ type: 'clearFull' }), []);

  const windowStart = useCallback(() => dispatch({ type: 'windowStart' }), []);
  const windowSuccess = useCallback((value) => dispatch({ type: 'windowSuccess', value }), []);
  const windowError = useCallback(() => dispatch({ type: 'windowError' }), []);
  const clearWindow = useCallback(() => dispatch({ type: 'clearWindow' }), []);

  const setLoadedRange = useCallback(
    (value) => dispatch({ type: 'setLoadedRange', value }), [],
  );

  const controlsStart = useCallback(() => dispatch({ type: 'controlsStart' }), []);
  const controlsSuccess = useCallback(
    (value) => dispatch({ type: 'controlsSuccess', value }), [],
  );
  const controlsError = useCallback(
    (err) => dispatch({ type: 'controlsError', error: err }), [],
  );
  const controlsPatch = useCallback(
    (name, p) => dispatch({ type: 'controlsPatch', name, patch: p }), [],
  );
  const clearControls = useCallback(() => dispatch({ type: 'clearControls' }), []);

  const chartSpecsStart = useCallback(() => dispatch({ type: 'chartSpecsStart' }), []);
  const chartSpecsSuccess = useCallback(
    (value) => dispatch({ type: 'chartSpecsSuccess', value }), [],
  );
  const chartSpecsError = useCallback(() => dispatch({ type: 'chartSpecsError' }), []);
  const clearChartSpecs = useCallback(() => dispatch({ type: 'clearChartSpecs' }), []);

  const toggleSection = useCallback(
    (name) => dispatch({ type: 'toggleSection', name }), [],
  );
  const setCollapsedSections = useCallback(
    (value) => dispatch({ type: 'setCollapsedSections', value }), [],
  );

  return {
    state, patch, reset,
    fullStart, fullSuccess, fullError, clearFull,
    windowStart, windowSuccess, windowError, clearWindow,
    setLoadedRange,
    controlsStart, controlsSuccess, controlsError, controlsPatch, clearControls,
    chartSpecsStart, chartSpecsSuccess, chartSpecsError, clearChartSpecs,
    toggleSection, setCollapsedSections,
  };
}
