/**
 * useBusGeometryFormState — file selection, column mappings, and
 * preview state for the GAT bus-geometry upload dialog. Upload
 * progress is the shared ``useUploadProgress``.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  spec: null,
  loadingSpec: false,
  file: null,
  preview: null,
  previewing: false,
  previewError: '',
  busIdCol: '',
  latCol: '',
  lonCol: '',
  systemBusIdCol: '',
  reMatching: false,
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':           return { ...state, ...action.patch };
    case 'reset':         return INITIAL;
    case 'clearPreview':  return { ...state, preview: null, previewError: '' };
    default:              return state;
  }
}

export function useBusGeometryFormState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const clearPreview = useCallback(() => dispatch({ type: 'clearPreview' }), []);

  const setSpec = useCallback((spec) => patch({ spec }), [patch]);
  const setLoadingSpec = useCallback((loadingSpec) => patch({ loadingSpec: !!loadingSpec }), [patch]);
  const setFile = useCallback((file) => patch({ file }), [patch]);
  const setPreview = useCallback((preview) => patch({ preview }), [patch]);
  const setPreviewing = useCallback((previewing) => patch({ previewing: !!previewing }), [patch]);
  const setPreviewError = useCallback((previewError) => patch({ previewError }), [patch]);
  const setBusIdCol = useCallback((busIdCol) => patch({ busIdCol }), [patch]);
  const setLatCol = useCallback((latCol) => patch({ latCol }), [patch]);
  const setLonCol = useCallback((lonCol) => patch({ lonCol }), [patch]);
  const setSystemBusIdCol = useCallback((systemBusIdCol) => patch({ systemBusIdCol }), [patch]);
  const setReMatching = useCallback((reMatching) => patch({ reMatching: !!reMatching }), [patch]);

  return {
    state, patch, reset, clearPreview,
    setSpec, setLoadingSpec,
    setFile, setPreview, setPreviewing, setPreviewError,
    setBusIdCol, setLatCol, setLonCol, setSystemBusIdCol, setReMatching,
  };
}
