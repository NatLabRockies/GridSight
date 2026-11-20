/**
 * Tests for the layout reducer — tray geometry, the collapsible sidebar
 * list items (keys derived from INITIAL.listItemOpen), and assorted
 * singleton refs (mapLegend, previewSource, activePerspective,
 * activeStory, chatPendingMessage).
 *
 * Pinned:
 *   - setListItemOpen supports BOTH a direct value and an updater fn
 *   - toggleListItem flips a single key without touching its siblings
 *   - closeAllListItems sets every key to false (not just clears the map)
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../layoutState.js';

describe('layoutState reducer', () => {
  it('initial state: tray at 0, all list items closed, all singletons null', () => {
    expect(INITIAL.trayTop).toBe(0);
    expect(INITIAL.trayPoppedOut).toBe(false);
    expect(INITIAL.listItemOpen).toEqual({
      layers: false, data: false, inputControls: false, animation: false,
      display: false, extensions: false, agentIntegration: false, developer: false,
    });
    expect(INITIAL.mapLegend).toBe(null);
    expect(INITIAL.previewSource).toBe(null);
    expect(INITIAL.activePerspective).toBe(null);
    expect(INITIAL.activeStory).toBe(null);
    expect(INITIAL.chatPendingMessage).toBe(null);
  });

  it('set shallow-merges a patch', () => {
    const next = reducer(INITIAL, {
      type: 'set',
      patch: { trayTop: 200, trayPoppedOut: true },
    });
    expect(next.trayTop).toBe(200);
    expect(next.trayPoppedOut).toBe(true);
    expect(next.listItemOpen).toBe(INITIAL.listItemOpen);
  });

  it('set can stash a mapLegend object', () => {
    const legend = { colormap: 'viridis', domainMin: 0, domainMax: 100, label: 'MW' };
    const next = reducer(INITIAL, { type: 'set', patch: { mapLegend: legend } });
    expect(next.mapLegend).toBe(legend);
  });

  it('setListItemOpen accepts a direct value', () => {
    const value = { layers: true, data: false, inputControls: true, animation: false, settings: false };
    const next = reducer(INITIAL, { type: 'setListItemOpen', value });
    expect(next.listItemOpen).toBe(value);
  });

  it('setListItemOpen accepts an updater function (useState pattern)', () => {
    const next = reducer(INITIAL, {
      type: 'setListItemOpen',
      value: (cur) => ({ ...cur, animation: true }),
    });
    expect(next.listItemOpen.animation).toBe(true);
    expect(next.listItemOpen.layers).toBe(false);
  });

  it('toggleListItem flips one key on, then off', () => {
    const opened = reducer(INITIAL, { type: 'toggleListItem', key: 'layers' });
    expect(opened.listItemOpen.layers).toBe(true);
    const closed = reducer(opened, { type: 'toggleListItem', key: 'layers' });
    expect(closed.listItemOpen.layers).toBe(false);
  });

  it('toggleListItem leaves sibling keys untouched', () => {
    const prev = {
      ...INITIAL,
      listItemOpen: { layers: true, data: false, inputControls: true, animation: false, settings: false },
    };
    const next = reducer(prev, { type: 'toggleListItem', key: 'data' });
    expect(next.listItemOpen.data).toBe(true);
    expect(next.listItemOpen.layers).toBe(true);
    expect(next.listItemOpen.inputControls).toBe(true);
    expect(next.listItemOpen.animation).toBe(false);
    expect(next.listItemOpen.settings).toBe(false);
  });

  it('closeAllListItems sets every known key to false', () => {
    // Derive the key set from INITIAL so this test tracks new sidebar
    // list items instead of pinning a stale hardcoded list.
    const allOpen = Object.fromEntries(
      Object.keys(INITIAL.listItemOpen).map((k) => [k, true]),
    );
    const prev = { ...INITIAL, listItemOpen: allOpen };
    const next = reducer(prev, { type: 'closeAllListItems' });
    expect(next.listItemOpen).toEqual(
      Object.fromEntries(Object.keys(INITIAL.listItemOpen).map((k) => [k, false])),
    );
  });

  it('closeAllListItems preserves the rest of the state', () => {
    const prev = { ...INITIAL, trayTop: 300, activeStory: 'story-1' };
    const next = reducer(prev, { type: 'closeAllListItems' });
    expect(next.trayTop).toBe(300);
    expect(next.activeStory).toBe('story-1');
  });

  it('reset returns INITIAL identity', () => {
    const dirty = {
      ...INITIAL,
      trayTop: 99,
      listItemOpen: { layers: true, data: true, inputControls: true, animation: true, settings: true },
      activePerspective: 'p1',
    };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('happy path: open a couple list items via toggle, then close all', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'toggleListItem', key: 'layers' });
    s = reducer(s, { type: 'toggleListItem', key: 'animation' });
    expect(s.listItemOpen.layers).toBe(true);
    expect(s.listItemOpen.animation).toBe(true);
    s = reducer(s, { type: 'closeAllListItems' });
    expect(s.listItemOpen.layers).toBe(false);
    expect(s.listItemOpen.animation).toBe(false);
  });

  it('setListItemOpen updater receives the current listItemOpen object', () => {
    const prev = {
      ...INITIAL,
      listItemOpen: { layers: true, data: false, inputControls: false, animation: false, settings: false },
    };
    let seen = null;
    reducer(prev, {
      type: 'setListItemOpen',
      value: (cur) => { seen = cur; return cur; },
    });
    expect(seen).toBe(prev.listItemOpen);
  });
});
