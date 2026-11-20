/**
 * useMapDataState — generic layer configs + their derived geo/data
 * keyed by layer id, plus the two Set<layerId> "anchored" collections.
 *
 * Grouping reasons:
 *   - Adding or removing a layer always touches multiple of these in
 *     lockstep (config, geo, data, visibility). Reducer actions like
 *     ``removeLayer`` make the consistency explicit.
 *   - 7 separate ``useState`` calls all consumed together by MapView.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  configs: [],            // array of layer records from the DB
  geo: {},                // layerId -> GeoJSON FeatureCollection
  data: {},               // layerId -> Map(entityId -> row|number)
  visibility: {},         // layerId -> boolean
  localStyle: {},         // layerId -> { opacity, radiusScale, mappingOverrides }
  anchoredLayers: new Set(),
  anchoredCharts: new Set(),
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':
      return { ...state, ...action.patch };

    case 'setConfigs':
      return {
        ...state,
        configs: typeof action.configs === 'function'
          ? action.configs(state.configs)
          : action.configs,
      };

    case 'setLayerGeo':
      return { ...state, geo: { ...state.geo, [action.layerId]: action.geo } };
    case 'setLayerData':
      return { ...state, data: { ...state.data, [action.layerId]: action.data } };
    case 'setLayerVisibility':
      return { ...state, visibility: { ...state.visibility, [action.layerId]: action.visible } };
    case 'setLayerStyle':
      return { ...state, localStyle: { ...state.localStyle, [action.layerId]: action.style } };

    case 'patchLayerStyle':
      return {
        ...state,
        localStyle: {
          ...state.localStyle,
          [action.layerId]: { ...(state.localStyle[action.layerId] ?? {}), ...action.patch },
        },
      };

    // Merge ONE visual property into a layer's geoMappings. Callers must not
    // pre-merge geoMappings into a patchLayerStyle patch: that merge reads
    // state outside the reducer, so two styling calls arriving in the same
    // tick (the assistant sizing and colouring a layer back-to-back) both
    // read the same pre-state and the second drops the first's mapping —
    // the layer ends up sized OR coloured, never both. Merging here means
    // the reducer's own current state is always the base.
    case 'patchLayerGeoMapping': {
      const cur = state.localStyle[action.layerId] ?? {};
      const next = { ...cur, ...(action.patch ?? {}) };
      if (action.visualProperty && action.mapping) {
        next.geoMappings = { ...(cur.geoMappings ?? {}), [action.visualProperty]: action.mapping };
        // Viewport-served layers prune feature properties to the columns they
        // are told to fetch; keep every styled column in that set or a mapping
        // reads undefined.
        const cols = new Set(cur.viewportColumns ?? []);
        if (action.mapping.property) cols.add(action.mapping.property);
        next.viewportColumns = [...cols];
      }
      return {
        ...state,
        localStyle: { ...state.localStyle, [action.layerId]: next },
      };
    }

    case 'replaceGeoMap':
      return { ...state, geo: action.value };
    case 'replaceDataMap':
      return { ...state, data: action.value };
    case 'replaceVisibilityMap':
      return { ...state, visibility: action.value };
    case 'replaceLocalStyleMap':
      return { ...state, localStyle: action.value };

    case 'removeLayer': {
      const { [action.layerId]: _g, ...geo } = state.geo;
      const { [action.layerId]: _d, ...data } = state.data;
      const { [action.layerId]: _v, ...visibility } = state.visibility;
      const { [action.layerId]: _s, ...localStyle } = state.localStyle;
      const anchoredLayers = new Set(state.anchoredLayers);
      anchoredLayers.delete(action.layerId);
      return {
        ...state,
        configs: state.configs.filter((c) => c.id !== action.layerId),
        geo, data, visibility, localStyle,
        anchoredLayers,
      };
    }

    case 'toggleAnchoredLayer': {
      const next = new Set(state.anchoredLayers);
      if (next.has(action.layerId)) next.delete(action.layerId);
      else next.add(action.layerId);
      return { ...state, anchoredLayers: next };
    }

    case 'toggleAnchoredChart': {
      const next = new Set(state.anchoredCharts);
      if (next.has(action.chartId)) next.delete(action.chartId);
      else next.add(action.chartId);
      return { ...state, anchoredCharts: next };
    }

    case 'reset':
      return INITIAL;

    default:
      return state;
  }
}

export function useMapDataState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);

  // setConfigs supports BOTH a value and an updater function, matching
  // the React ``useState`` setter API so existing call sites
  // ``setGenericLayerConfigs((prev) => …)`` migrate cleanly.
  const setConfigs = useCallback(
    (configs) => dispatch({ type: 'setConfigs', configs }), [],
  );
  // Whole-map replacers for callers that build a new object themselves
  // (e.g. updater function pattern: ``setGenericLayerGeo(prev =>
  // { ...prev, [id]: g })``). For per-key set, use ``setLayerGeo``.
  const replaceGeoMap = useCallback(
    (value) => dispatch({ type: 'replaceGeoMap', value }), [],
  );
  const replaceDataMap = useCallback(
    (value) => dispatch({ type: 'replaceDataMap', value }), [],
  );
  const replaceVisibilityMap = useCallback(
    (value) => dispatch({ type: 'replaceVisibilityMap', value }), [],
  );
  const replaceLocalStyleMap = useCallback(
    (value) => dispatch({ type: 'replaceLocalStyleMap', value }), [],
  );

  const setLayerGeo = useCallback(
    (layerId, geo) => dispatch({ type: 'setLayerGeo', layerId, geo }), [],
  );
  const setLayerData = useCallback(
    (layerId, data) => dispatch({ type: 'setLayerData', layerId, data }), [],
  );
  const setLayerVisibility = useCallback(
    (layerId, visible) => dispatch({ type: 'setLayerVisibility', layerId, visible }), [],
  );
  const setLayerStyle = useCallback(
    (layerId, style) => dispatch({ type: 'setLayerStyle', layerId, style }), [],
  );
  const patchLayerStyle = useCallback(
    (layerId, p) => dispatch({ type: 'patchLayerStyle', layerId, patch: p }), [],
  );
  const patchLayerGeoMapping = useCallback(
    (layerId, visualProperty, mapping, patch) => dispatch({
      type: 'patchLayerGeoMapping', layerId, visualProperty, mapping, patch,
    }), [],
  );
  const removeLayer = useCallback(
    (layerId) => dispatch({ type: 'removeLayer', layerId }), [],
  );
  const toggleAnchoredLayer = useCallback(
    (layerId) => dispatch({ type: 'toggleAnchoredLayer', layerId }), [],
  );
  const toggleAnchoredChart = useCallback(
    (chartId) => dispatch({ type: 'toggleAnchoredChart', chartId }), [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return {
    state,
    patch,
    setConfigs,
    replaceGeoMap,
    replaceDataMap,
    replaceVisibilityMap,
    replaceLocalStyleMap,
    setLayerGeo,
    setLayerData,
    setLayerVisibility,
    setLayerStyle,
    patchLayerStyle,
    patchLayerGeoMapping,
    removeLayer,
    toggleAnchoredLayer,
    toggleAnchoredChart,
    reset,
  };
}
