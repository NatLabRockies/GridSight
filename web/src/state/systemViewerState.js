/**
 * useSystemViewerState — state for the GAT "inspect system" dialog.
 * Two async surfaces (components list, paginated rows) plus shared
 * view state (selected component, page, filter).
 */
import { useCallback, useReducer } from 'react';

export function makeInitial(initialComponent = '') {
  return {
    components: [],            // [{ name, count, columns }]
    loadingComponents: false,
    componentsError: '',
    systemPath: '',
    systemAvailable: true,
    selected: initialComponent,
    page: 0,
    filter: '',
    rows: [],
    columns: [],
    total: 0,
    loadingRows: false,
    rowsError: '',
  };
}

export function reducer(state, action) {
  switch (action.type) {
    case 'set':                  return { ...state, ...action.patch };
    case 'reset':                return action.initial;

    case 'componentsStart':
      return { ...state, loadingComponents: true, componentsError: '' };
    case 'componentsSuccess':
      return {
        ...state,
        loadingComponents: false,
        componentsError: '',
        components: action.value.components,
        systemPath: action.value.systemPath ?? state.systemPath,
        systemAvailable: action.value.systemAvailable ?? true,
      };
    case 'componentsError':
      return { ...state, loadingComponents: false, componentsError: action.error };

    case 'rowsStart':
      return { ...state, loadingRows: true, rowsError: '' };
    case 'rowsSuccess':
      return {
        ...state,
        loadingRows: false,
        rowsError: '',
        rows: action.value.rows,
        columns: action.value.columns,
        total: action.value.total,
      };
    case 'rowsError':
      return { ...state, loadingRows: false, rows: [], rowsError: action.error };

    default:
      return state;
  }
}

export function useSystemViewerState(initialComponent = '') {
  const initial = makeInitial(initialComponent);
  const [state, dispatch] = useReducer(reducer, initial);

  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const reset = useCallback(() => dispatch({ type: 'reset', initial }), [initial]);

  const componentsStart = useCallback(() => dispatch({ type: 'componentsStart' }), []);
  const componentsSuccess = useCallback(
    (value) => dispatch({ type: 'componentsSuccess', value }), [],
  );
  const componentsError = useCallback(
    (err) => dispatch({ type: 'componentsError', error: err }), [],
  );

  const rowsStart = useCallback(() => dispatch({ type: 'rowsStart' }), []);
  const rowsSuccess = useCallback((value) => dispatch({ type: 'rowsSuccess', value }), []);
  const rowsError = useCallback((err) => dispatch({ type: 'rowsError', error: err }), []);

  const setSelected = useCallback((selected) => patch({ selected, page: 0 }), [patch]);
  const setPage = useCallback((page) => patch({ page }), [patch]);
  const setFilter = useCallback((filter) => patch({ filter, page: 0 }), [patch]);

  return {
    state, patch, reset,
    componentsStart, componentsSuccess, componentsError,
    rowsStart, rowsSuccess, rowsError,
    setSelected, setPage, setFilter,
  };
}
