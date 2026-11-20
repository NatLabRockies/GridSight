/**
 * useUiPanelState — boolean dialog flags, sidebar/drawer mode, and a
 * handful of ephemeral panel toggles that all live near the top of
 * ``App.jsx``. None of these have async logic or invariants — they're
 * just on/off + a few small enums.
 *
 * Grouping reasons:
 *   - 11 separate ``useState(false)`` calls hurt scannability
 *   - panel close handlers often need to flip several at once
 *     (closing the drawer should also collapse expandedExt) — easy
 *     to forget when each is a separate setter
 */
import { useCallback, useReducer } from 'react';

export const INITIAL = {
  syncSettingsOpen: false,
  sidebarMode: 'icons',           // 'icons' | 'full'
  drawerHovered: false,
  deckControl: true,              // map interaction (false during clock drag)
  expandedExt: null,              // currently expanded extension name
  chartsMenu: null,               // { extName, anchorEl } | null
  colorPanelOpen: false,
  quickStyleOpen: false,
  giveControlOpen: false,
  legendCollapsed: false,
  chatOpen: false,
};

export function reducer(state, action) {
  switch (action.type) {
    case 'set':           return { ...state, ...action.patch };
    case 'reset':         return INITIAL;
    case 'collapseDrawer':
      // Closing the drawer should also close anything that visually
      // depends on the drawer being open. Wrapping that as one action
      // is the whole point of having a reducer.
      return { ...state, sidebarMode: 'icons', expandedExt: null };
    default:              return state;
  }
}

export function useUiPanelState() {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const patch = useCallback((p) => dispatch({ type: 'set', patch: p }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const collapseDrawer = useCallback(() => dispatch({ type: 'collapseDrawer' }), []);

  // Named setters for the most common single-field updates. Keep this
  // list short — anything one-off goes through ``patch``.
  const setSyncSettingsOpen = useCallback(
    (v) => dispatch({ type: 'set', patch: { syncSettingsOpen: !!v } }), [],
  );
  const setSidebarMode = useCallback(
    (v) => dispatch({ type: 'set', patch: { sidebarMode: v } }), [],
  );
  const setDrawerHovered = useCallback(
    (v) => dispatch({ type: 'set', patch: { drawerHovered: !!v } }), [],
  );
  const setDeckControl = useCallback(
    (v) => dispatch({ type: 'set', patch: { deckControl: !!v } }), [],
  );
  const setExpandedExt = useCallback(
    (v) => dispatch({ type: 'set', patch: { expandedExt: v } }), [],
  );
  const setChartsMenu = useCallback(
    (v) => dispatch({ type: 'set', patch: { chartsMenu: v } }), [],
  );
  const setColorPanelOpen = useCallback(
    (v) => dispatch({ type: 'set', patch: { colorPanelOpen: !!v } }), [],
  );
  const setQuickStyleOpen = useCallback(
    (v) => dispatch({ type: 'set', patch: { quickStyleOpen: !!v } }), [],
  );
  const setGiveControlOpen = useCallback(
    (v) => dispatch({ type: 'set', patch: { giveControlOpen: !!v } }), [],
  );
  const setLegendCollapsed = useCallback(
    (v) => dispatch({ type: 'set', patch: { legendCollapsed: !!v } }), [],
  );
  const setChatOpen = useCallback(
    (v) => dispatch({ type: 'set', patch: { chatOpen: !!v } }), [],
  );

  return {
    state,
    patch,
    reset,
    collapseDrawer,
    setSyncSettingsOpen,
    setSidebarMode,
    setDrawerHovered,
    setDeckControl,
    setExpandedExt,
    setChartsMenu,
    setColorPanelOpen,
    setQuickStyleOpen,
    setGiveControlOpen,
    setLegendCollapsed,
    setChatOpen,
  };
}
