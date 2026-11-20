/**
 * useExtensionDialogState — tracks which extension dialog (Create
 * Scenario, Bus Geometry, Inspect System) is currently open and for
 * which extension. Each holds the extension manifest object that the
 * dialog needs to call back into.
 *
 * Only one of these is open at a time in practice; closing one is a
 * no-op on the others so the API stays per-field.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  createScenario: null,   // extension manifest | null
  busGeo: null,
  inspectSystem: null,
  displayGroups: null,    // GAT-only: per-project / per-scenario category overrides
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':                  return { ...state, ...action.patch };
    case 'openCreateScenario':   return { ...state, createScenario: action.ext };
    case 'closeCreateScenario':  return { ...state, createScenario: null };
    case 'openBusGeo':           return { ...state, busGeo: action.ext };
    case 'closeBusGeo':          return { ...state, busGeo: null };
    case 'openInspectSystem':    return { ...state, inspectSystem: action.ext };
    case 'closeInspectSystem':   return { ...state, inspectSystem: null };
    case 'openDisplayGroups':    return { ...state, displayGroups: action.ext };
    case 'closeDisplayGroups':   return { ...state, displayGroups: null };
    case 'closeAll':             return INITIAL;
    case 'reset':                return INITIAL;
    default:                     return state;
  }
}

export function useExtensionDialogState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const openCreateScenario = useCallback(
    (ext) => dispatch({ type: 'openCreateScenario', ext }), [],
  );
  const closeCreateScenario = useCallback(
    () => dispatch({ type: 'closeCreateScenario' }), [],
  );
  const openBusGeo = useCallback(
    (ext) => dispatch({ type: 'openBusGeo', ext }), [],
  );
  const closeBusGeo = useCallback(
    () => dispatch({ type: 'closeBusGeo' }), [],
  );
  const openInspectSystem = useCallback(
    (ext) => dispatch({ type: 'openInspectSystem', ext }), [],
  );
  const closeInspectSystem = useCallback(
    () => dispatch({ type: 'closeInspectSystem' }), [],
  );
  const openDisplayGroups = useCallback(
    (ext) => dispatch({ type: 'openDisplayGroups', ext }), [],
  );
  const closeDisplayGroups = useCallback(
    () => dispatch({ type: 'closeDisplayGroups' }), [],
  );
  const closeAll = useCallback(() => dispatch({ type: 'closeAll' }), []);
  return {
    state,
    openCreateScenario, closeCreateScenario,
    openBusGeo, closeBusGeo,
    openInspectSystem, closeInspectSystem,
    openDisplayGroups, closeDisplayGroups,
    closeAll,
  };
}
