/**
 * useUploadProgress — shared state-machine hook for the
 * CreateScenarioDialog and BusGeometryDialog upload flows.
 *
 * Phases:
 *   null        — idle (initial + post-reset)
 *   'uploading' — bytes flowing browser→server; ``loaded`` + ``total`` valid
 *   'pending'   — server accepted the upload, job queued
 *   'running'   — extension background ingest in progress
 *   'success'   — terminal, ingest complete
 *   'error'     — terminal, ``error`` field populated
 *
 * Why a reducer: the previous shape was 7 separate useState calls
 * (phase + loaded + total + rate + message + error + saving), updated
 * across multiple call sites for what is fundamentally one state
 * machine. Setting ``error`` while forgetting to clear ``saving`` was
 * a real bug class. The reducer enforces valid transitions in one
 * place — e.g. ``startUploading`` always zeros byte counts AND clears
 * the previous error AND flips ``saving`` true.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  phase: null,
  loaded: 0,
  total: 0,
  rateBytesPerSec: 0,
  message: '',
  error: '',
  saving: false,
};

export function reducer(state, action) {
  switch (action.type) {
    case 'reset':
      return INITIAL;

    case 'startUploading':
      return {
        ...INITIAL,
        phase: 'uploading',
        message: action.message ?? 'Uploading files…',
        saving: true,
      };

    case 'uploadProgress':
      return {
        ...state,
        phase: 'uploading',
        loaded: action.loaded,
        total: action.total,
      };

    case 'rate':
      return { ...state, rateBytesPerSec: action.rateBytesPerSec };

    case 'pending':
      return {
        ...state,
        phase: 'pending',
        message: action.message ?? 'Queued on server…',
      };

    case 'running':
      return {
        ...state,
        phase: 'running',
        message: action.message ?? 'Ingesting on server…',
      };

    case 'success':
      return {
        ...state,
        phase: 'success',
        message: '',
        error: '',
        saving: false,
      };

    case 'error':
      return {
        ...state,
        phase: 'error',
        error: action.error || 'Upload failed.',
        message: '',
        saving: false,
      };

    case 'message':
      return { ...state, message: action.message ?? '' };

    case 'set':  // escape hatch for one-off multi-field updates
      return { ...state, ...action.patch };

    default:
      return state;
  }
}

export function useUploadProgress() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const startUploading = useCallback(
    (message) => dispatch({ type: 'startUploading', message }), [],
  );
  const uploadProgress = useCallback(
    (loaded, total) => dispatch({ type: 'uploadProgress', loaded, total }), [],
  );
  const setRate = useCallback(
    (rateBytesPerSec) => dispatch({ type: 'rate', rateBytesPerSec }), [],
  );
  const pending = useCallback(
    (message) => dispatch({ type: 'pending', message }), [],
  );
  const running = useCallback(
    (message) => dispatch({ type: 'running', message }), [],
  );
  const success = useCallback(() => dispatch({ type: 'success' }), []);
  const error = useCallback((err) => dispatch({ type: 'error', error: err }), []);
  const setMessage = useCallback(
    (message) => dispatch({ type: 'message', message }), [],
  );
  return {
    state,
    reset,
    startUploading,
    uploadProgress,
    setRate,
    pending,
    running,
    success,
    error,
    setMessage,
  };
}
