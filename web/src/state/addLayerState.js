/**
 * useAddLayerState — two-step Add Layer wizard. Grouped into logical
 * sub-objects (step1, step2, join, style, submission) inside one
 * reducer for atomic transitions like "step 1 saved → store created
 * IDs → advance to step 2".
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  step: 1,
  saving: false,
  error: '',

  // Step 1: geometry + layer name
  geometryFiles: [],
  layerName: '',
  selectedGeoId: '',
  deckLayerType: 'GeoJsonLayer',

  // Step 2: dataset + join
  datasets: [],
  selectedDatasetId: '',
  geomJoinKey: '',
  dataJoinKey: '',
  dataColumns: [],

  // Style mappings being assembled
  styleMappings: [],
  newMapping: {
    visual_property: 'getFillColor',
    column: '',
    colormap: 'viridis',
    scale_type: 'linear',
    domain_min: '',
    domain_max: '',
  },

  // Server-assigned IDs after step 1 save
  createdLayerId: null,
  createdLayerDatasetId: null,
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':                  return { ...state, ...action.patch };
    case 'reset':                return INITIAL;

    case 'setNewMapping':
      return {
        ...state,
        newMapping: typeof action.value === 'function'
          ? action.value(state.newMapping)
          : { ...state.newMapping, ...action.value },
      };
    case 'resetNewMapping':
      return { ...state, newMapping: INITIAL.newMapping };

    case 'appendStyleMapping':
      return { ...state, styleMappings: [...state.styleMappings, action.mapping] };
    case 'removeStyleMapping':
      return {
        ...state,
        styleMappings: state.styleMappings.filter((_, i) => i !== action.index),
      };

    case 'advanceToStep2':
      // Atomically: save IDs, clear error, advance step. Replaces a
      // sequence of setSaving/setStep/setCreatedLayerId/setError
      // calls that were easy to get out of order.
      return {
        ...state,
        saving: false,
        error: '',
        step: 2,
        createdLayerId: action.layerId,
        createdLayerDatasetId: action.layerDatasetId,
      };

    default:
      return state;
  }
}

export function useAddLayerState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const setStep = useCallback((step) => patch({ step }), [patch]);
  const setSaving = useCallback((saving) => patch({ saving: !!saving }), [patch]);
  const setError = useCallback((error) => patch({ error }), [patch]);
  const setGeometryFiles = useCallback((geometryFiles) => patch({ geometryFiles }), [patch]);
  const setLayerName = useCallback((layerName) => patch({ layerName }), [patch]);
  const setSelectedGeoId = useCallback((selectedGeoId) => patch({ selectedGeoId }), [patch]);
  const setDeckLayerType = useCallback((deckLayerType) => patch({ deckLayerType }), [patch]);
  const setDatasets = useCallback((datasets) => patch({ datasets }), [patch]);
  const setSelectedDatasetId = useCallback((selectedDatasetId) => patch({ selectedDatasetId }), [patch]);
  const setGeomJoinKey = useCallback((geomJoinKey) => patch({ geomJoinKey }), [patch]);
  const setDataJoinKey = useCallback((dataJoinKey) => patch({ dataJoinKey }), [patch]);
  const setDataColumns = useCallback((dataColumns) => patch({ dataColumns }), [patch]);

  const setNewMapping = useCallback(
    (value) => dispatch({ type: 'setNewMapping', value }), [],
  );
  const resetNewMapping = useCallback(() => dispatch({ type: 'resetNewMapping' }), []);
  const appendStyleMapping = useCallback(
    (mapping) => dispatch({ type: 'appendStyleMapping', mapping }), [],
  );
  const removeStyleMapping = useCallback(
    (index) => dispatch({ type: 'removeStyleMapping', index }), [],
  );

  const advanceToStep2 = useCallback(
    (layerId, layerDatasetId) =>
      dispatch({ type: 'advanceToStep2', layerId, layerDatasetId }),
    [],
  );

  return {
    state, patch, reset,
    setStep, setSaving, setError,
    setGeometryFiles, setLayerName, setSelectedGeoId, setDeckLayerType,
    setDatasets, setSelectedDatasetId, setGeomJoinKey, setDataJoinKey, setDataColumns,
    setNewMapping, resetNewMapping, appendStyleMapping, removeStyleMapping,
    advanceToStep2,
  };
}
