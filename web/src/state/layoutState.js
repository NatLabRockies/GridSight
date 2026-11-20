/**
 * useLayoutState — chart tray + bottom-of-screen panel state, plus
 * the chat pending-message pipe and the active-story / active-
 * perspective ids that travel together over the ``story`` bus channel.
 *
 * Grouping reasons: most of these are toggled in pairs by the same
 * handlers (e.g. opening a perspective also closes any active story,
 * opening preview unsticks the legend). One reducer keeps the
 * "always-on" invariants in one place.
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  trayTop: 0,
  trayPoppedOut: false,
  listItemOpen: {
    layers: false,
    data: false,
    inputControls: false,
    animation: false,
    display: false,
    extensions: false,
    agentIntegration: false,
    developer: false,
  },
  mapLegend: null,                // { colormap, domainMin, domainMax, label, categoryColors } | null
  previewSource: null,            // dataset reference | null
  activePerspective: null,
  activeStory: null,
  chatPendingMessage: null,
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':
      return { ...state, ...action.patch };

    case 'setListItemOpen': {
      const next = typeof action.value === 'function'
        ? action.value(state.listItemOpen)
        : action.value;
      return { ...state, listItemOpen: next };
    }
    case 'toggleListItem':
      return {
        ...state,
        listItemOpen: {
          ...state.listItemOpen,
          [action.key]: !state.listItemOpen[action.key],
        },
      };
    case 'closeAllListItems':
      return {
        ...state,
        listItemOpen: {
          layers: false, data: false, inputControls: false,
          animation: false, display: false, extensions: false,
          agentIntegration: false, developer: false,
        },
      };

    case 'reset':
      return INITIAL;

    default:
      return state;
  }
}

export function useLayoutState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const setTrayTop = useCallback(
    (trayTop) => dispatch({ type: 'set', patch: { trayTop } }), [],
  );
  const setTrayPoppedOut = useCallback(
    (trayPoppedOut) => dispatch({ type: 'set', patch: { trayPoppedOut: !!trayPoppedOut } }), [],
  );
  const setListItemOpen = useCallback(
    (value) => dispatch({ type: 'setListItemOpen', value }), [],
  );
  const toggleListItem = useCallback(
    (key) => dispatch({ type: 'toggleListItem', key }), [],
  );
  const closeAllListItems = useCallback(
    () => dispatch({ type: 'closeAllListItems' }), [],
  );
  const setMapLegend = useCallback(
    (mapLegend) => dispatch({ type: 'set', patch: { mapLegend } }), [],
  );
  const setPreviewSource = useCallback(
    (previewSource) => dispatch({ type: 'set', patch: { previewSource } }), [],
  );
  const setActivePerspective = useCallback(
    (activePerspective) => dispatch({ type: 'set', patch: { activePerspective } }), [],
  );
  const setActiveStory = useCallback(
    (activeStory) => dispatch({ type: 'set', patch: { activeStory } }), [],
  );
  const setChatPendingMessage = useCallback(
    (chatPendingMessage) => dispatch({ type: 'set', patch: { chatPendingMessage } }), [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return {
    state,
    patch,
    setTrayTop,
    setTrayPoppedOut,
    setListItemOpen,
    toggleListItem,
    closeAllListItems,
    setMapLegend,
    setPreviewSource,
    setActivePerspective,
    setActiveStory,
    setChatPendingMessage,
    reset,
  };
}
