/**
 * Tests for the system-viewer reducer. Initial state is arg-driven
 * via `makeInitial(initialComponent)`. The componentsSuccess action
 * preserves prior `systemPath` when undefined — pin that branch.
 */
import { describe, it, expect } from 'vitest';
import { reducer, makeInitial } from '../systemViewerState.js';

describe('systemViewerState reducer', () => {
  it('makeInitial respects initialComponent argument', () => {
    const s = makeInitial('myComp');
    expect(s.selected).toBe('myComp');
    expect(s.components).toEqual([]);
    expect(s.loadingComponents).toBe(false);
    expect(s.componentsError).toBe('');
    expect(s.systemPath).toBe('');
    expect(s.systemAvailable).toBe(true);
    expect(s.page).toBe(0);
    expect(s.filter).toBe('');
    expect(s.rows).toEqual([]);
    expect(s.columns).toEqual([]);
    expect(s.total).toBe(0);
    expect(s.loadingRows).toBe(false);
    expect(s.rowsError).toBe('');
  });

  it('makeInitial defaults selected to empty string', () => {
    expect(makeInitial().selected).toBe('');
  });

  it('set merges patch shallowly', () => {
    const initial = makeInitial('x');
    const next = reducer(initial, { type: 'set', patch: { page: 5, filter: 'foo' } });
    expect(next.page).toBe(5);
    expect(next.filter).toBe('foo');
    expect(next.selected).toBe('x');
  });

  it('reset returns whatever initial is in the action payload', () => {
    const initial = makeInitial('comp');
    const dirty = { ...initial, page: 99, filter: 'q' };
    const next = reducer(dirty, { type: 'reset', initial });
    expect(next).toBe(initial);
  });

  it('componentsStart sets loading AND clears prior error', () => {
    const prev = { ...makeInitial(), componentsError: 'stale' };
    const next = reducer(prev, { type: 'componentsStart' });
    expect(next.loadingComponents).toBe(true);
    expect(next.componentsError).toBe('');
  });

  it('componentsSuccess stores components, sets systemPath + systemAvailable when provided', () => {
    const prev = { ...makeInitial(), loadingComponents: true };
    const value = {
      components: [{ name: 'bus', count: 3 }],
      systemPath: '/data/system.json',
      systemAvailable: false,
    };
    const next = reducer(prev, { type: 'componentsSuccess', value });
    expect(next.loadingComponents).toBe(false);
    expect(next.componentsError).toBe('');
    expect(next.components).toEqual([{ name: 'bus', count: 3 }]);
    expect(next.systemPath).toBe('/data/system.json');
    expect(next.systemAvailable).toBe(false);
  });

  it('componentsSuccess preserves prior systemPath when value.systemPath is undefined', () => {
    const prev = { ...makeInitial(), systemPath: '/prior/path', loadingComponents: true };
    const next = reducer(prev, {
      type: 'componentsSuccess',
      value: { components: [] },
    });
    expect(next.systemPath).toBe('/prior/path');
    // systemAvailable falls back to `true` when undefined
    expect(next.systemAvailable).toBe(true);
  });

  it('componentsSuccess systemAvailable defaults to true when undefined', () => {
    const prev = { ...makeInitial(), systemAvailable: false };
    const next = reducer(prev, {
      type: 'componentsSuccess',
      value: { components: [], systemPath: '/p' },
    });
    expect(next.systemAvailable).toBe(true);
  });

  it('componentsError stores error and clears loading', () => {
    const prev = { ...makeInitial(), loadingComponents: true };
    const next = reducer(prev, { type: 'componentsError', error: 'oops' });
    expect(next.loadingComponents).toBe(false);
    expect(next.componentsError).toBe('oops');
  });

  it('rowsStart sets loading AND clears rowsError', () => {
    const prev = { ...makeInitial(), rowsError: 'old' };
    const next = reducer(prev, { type: 'rowsStart' });
    expect(next.loadingRows).toBe(true);
    expect(next.rowsError).toBe('');
  });

  it('rowsSuccess stores rows, columns, total atomically', () => {
    const prev = { ...makeInitial(), loadingRows: true };
    const value = { rows: [{ a: 1 }], columns: ['a'], total: 42 };
    const next = reducer(prev, { type: 'rowsSuccess', value });
    expect(next.loadingRows).toBe(false);
    expect(next.rowsError).toBe('');
    expect(next.rows).toEqual([{ a: 1 }]);
    expect(next.columns).toEqual(['a']);
    expect(next.total).toBe(42);
  });

  it('rowsError clears rows and stores error', () => {
    const prev = { ...makeInitial(), loadingRows: true, rows: [{ stale: true }] };
    const next = reducer(prev, { type: 'rowsError', error: 'query failed' });
    expect(next.loadingRows).toBe(false);
    expect(next.rows).toEqual([]);
    expect(next.rowsError).toBe('query failed');
  });

  it('unknown action returns same state reference', () => {
    const initial = makeInitial();
    expect(reducer(initial, { type: 'noop' })).toBe(initial);
  });

  it('two makeInitial calls produce distinct objects (no shared mutable state)', () => {
    const a = makeInitial('x');
    const b = makeInitial('x');
    expect(a).not.toBe(b);
    expect(a.components).not.toBe(b.components);
  });

  it('happy path: start → success → rowsStart → rowsSuccess', () => {
    const initial = makeInitial('bus');
    let s = reducer(initial, { type: 'componentsStart' });
    s = reducer(s, {
      type: 'componentsSuccess',
      value: { components: [{ name: 'bus' }], systemPath: '/s', systemAvailable: true },
    });
    s = reducer(s, { type: 'rowsStart' });
    s = reducer(s, {
      type: 'rowsSuccess',
      value: { rows: [{ id: 1 }], columns: ['id'], total: 1 },
    });
    expect(s.components).toEqual([{ name: 'bus' }]);
    expect(s.rows).toEqual([{ id: 1 }]);
    expect(s.loadingRows).toBe(false);
    expect(s.loadingComponents).toBe(false);
  });
});
