/**
 * useCreateScenarioFormState — form fields for the GAT
 * "create scenario" dialog. Upload progress lives in the shared
 * ``useUploadProgress`` hook; this one is just the form values plus
 * the dialog's async-fetched ``spec``.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  spec: null,
  loadingSpec: false,
  projectName: '',
  scenarioName: '',
  description: '',
  systemMode: 'upload',    // 'upload' | 'existing'
  systemFile: null,
  existingSystemPath: '',
  simFiles: [],
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':       return { ...state, ...action.patch };
    case 'reset':     return INITIAL;
    default:          return state;
  }
}

export function useCreateScenarioFormState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const setSpec = useCallback((spec) => patch({ spec }), [patch]);
  const setLoadingSpec = useCallback((loadingSpec) => patch({ loadingSpec: !!loadingSpec }), [patch]);
  const setProjectName = useCallback((projectName) => patch({ projectName }), [patch]);
  const setScenarioName = useCallback((scenarioName) => patch({ scenarioName }), [patch]);
  const setDescription = useCallback((description) => patch({ description }), [patch]);
  const setSystemMode = useCallback((systemMode) => patch({ systemMode }), [patch]);
  const setSystemFile = useCallback((systemFile) => patch({ systemFile }), [patch]);
  const setExistingSystemPath = useCallback(
    (existingSystemPath) => patch({ existingSystemPath }), [patch],
  );
  const setSimFiles = useCallback((simFiles) => patch({ simFiles }), [patch]);

  return {
    state, patch, reset,
    setSpec, setLoadingSpec,
    setProjectName, setScenarioName, setDescription,
    setSystemMode, setSystemFile, setExistingSystemPath, setSimFiles,
  };
}
