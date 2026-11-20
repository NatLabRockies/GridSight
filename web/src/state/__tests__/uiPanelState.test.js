/**
 * Tests for the UI panel reducer — boolean dialog flags + drawer/sidebar mode.
 *
 * The interesting invariant is collapseDrawer: it must close the sidebar AND
 * clear expandedExt as a single transaction, otherwise the UI will leave an
 * orphan extension panel visible after the drawer animates shut.
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../uiPanelState.js';

describe('uiPanelState reducer', () => {
  it('initial state shape: drawer collapsed, deck control enabled, all dialogs closed', () => {
    expect(INITIAL.syncSettingsOpen).toBe(false);
    expect(INITIAL.sidebarMode).toBe('icons');
    expect(INITIAL.drawerHovered).toBe(false);
    expect(INITIAL.deckControl).toBe(true);
    expect(INITIAL.expandedExt).toBe(null);
    expect(INITIAL.chartsMenu).toBe(null);
    expect(INITIAL.colorPanelOpen).toBe(false);
    expect(INITIAL.quickStyleOpen).toBe(false);
    expect(INITIAL.giveControlOpen).toBe(false);
    expect(INITIAL.legendCollapsed).toBe(false);
    expect(INITIAL.chatOpen).toBe(false);
  });

  it('set is an escape hatch that shallow-merges the patch', () => {
    const next = reducer(INITIAL, {
      type: 'set',
      patch: { chatOpen: true, sidebarMode: 'full' },
    });
    expect(next.chatOpen).toBe(true);
    expect(next.sidebarMode).toBe('full');
    expect(next.deckControl).toBe(true); // untouched
  });

  it('set with empty patch preserves all fields', () => {
    const next = reducer(INITIAL, { type: 'set', patch: {} });
    expect(next).toEqual(INITIAL);
    expect(next).not.toBe(INITIAL); // new object even on empty patch
  });

  it('set can null out a field (expandedExt)', () => {
    const prev = { ...INITIAL, expandedExt: 'demand-tldr' };
    const next = reducer(prev, { type: 'set', patch: { expandedExt: null } });
    expect(next.expandedExt).toBe(null);
  });

  it('collapseDrawer sets sidebarMode to icons AND clears expandedExt as one action', () => {
    const prev = { ...INITIAL, sidebarMode: 'full', expandedExt: 'gat' };
    const next = reducer(prev, { type: 'collapseDrawer' });
    expect(next.sidebarMode).toBe('icons');
    expect(next.expandedExt).toBe(null);
  });

  it('collapseDrawer preserves unrelated flags', () => {
    const prev = {
      ...INITIAL,
      sidebarMode: 'full',
      expandedExt: 'gat',
      chatOpen: true,
      legendCollapsed: true,
    };
    const next = reducer(prev, { type: 'collapseDrawer' });
    expect(next.chatOpen).toBe(true);
    expect(next.legendCollapsed).toBe(true);
  });

  it('collapseDrawer is idempotent when already collapsed with no expanded ext', () => {
    const next = reducer(INITIAL, { type: 'collapseDrawer' });
    expect(next.sidebarMode).toBe('icons');
    expect(next.expandedExt).toBe(null);
  });

  it('reset returns the INITIAL constant identity', () => {
    const dirty = {
      ...INITIAL, chatOpen: true, expandedExt: 'x', sidebarMode: 'full',
    };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('chartsMenu can carry an arbitrary object via set', () => {
    const menu = { extName: 'gat', anchorEl: { tag: 'fake-el' } };
    const next = reducer(INITIAL, { type: 'set', patch: { chartsMenu: menu } });
    expect(next.chartsMenu).toBe(menu);
  });

  it('happy path: expand sidebar, open extension, collapse drawer clears both', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'set', patch: { sidebarMode: 'full' } });
    s = reducer(s, { type: 'set', patch: { expandedExt: 'demand-tldr' } });
    expect(s.sidebarMode).toBe('full');
    expect(s.expandedExt).toBe('demand-tldr');
    s = reducer(s, { type: 'collapseDrawer' });
    expect(s.sidebarMode).toBe('icons');
    expect(s.expandedExt).toBe(null);
  });

  it('multiple sequential set actions accumulate', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'set', patch: { chatOpen: true } });
    s = reducer(s, { type: 'set', patch: { colorPanelOpen: true } });
    s = reducer(s, { type: 'set', patch: { quickStyleOpen: true } });
    expect(s.chatOpen).toBe(true);
    expect(s.colorPanelOpen).toBe(true);
    expect(s.quickStyleOpen).toBe(true);
  });
});
