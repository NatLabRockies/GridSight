/**
 * Tests for the layer-version reducer — three monotonic counters used
 * as React keys / updateTrigger inputs for cache invalidation.
 *
 * Pinned:
 *   - bumpX increments by exactly 1
 *   - bumping one counter does not touch the others
 *   - setX takes an absolute value (used by the bus-sync mirror path)
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../layerVersionState.js';

describe('layerVersionState reducer', () => {
  it('initial state: all three counters at 0', () => {
    expect(INITIAL.tsVersion).toBe(0);
    expect(INITIAL.staticVersion).toBe(0);
    expect(INITIAL.inputControlRefreshKey).toBe(0);
  });

  it('bumpTs increments tsVersion by 1', () => {
    const next = reducer(INITIAL, { type: 'bumpTs' });
    expect(next.tsVersion).toBe(1);
  });

  it('bumpStatic increments staticVersion by 1', () => {
    const next = reducer(INITIAL, { type: 'bumpStatic' });
    expect(next.staticVersion).toBe(1);
  });

  it('bumpInputControl increments inputControlRefreshKey by 1', () => {
    const next = reducer(INITIAL, { type: 'bumpInputControl' });
    expect(next.inputControlRefreshKey).toBe(1);
  });

  it('bumpTs leaves staticVersion and inputControlRefreshKey untouched', () => {
    const prev = { tsVersion: 5, staticVersion: 7, inputControlRefreshKey: 9 };
    const next = reducer(prev, { type: 'bumpTs' });
    expect(next.tsVersion).toBe(6);
    expect(next.staticVersion).toBe(7);
    expect(next.inputControlRefreshKey).toBe(9);
  });

  it('bumpStatic leaves the other two counters untouched', () => {
    const prev = { tsVersion: 5, staticVersion: 7, inputControlRefreshKey: 9 };
    const next = reducer(prev, { type: 'bumpStatic' });
    expect(next.tsVersion).toBe(5);
    expect(next.staticVersion).toBe(8);
    expect(next.inputControlRefreshKey).toBe(9);
  });

  it('bumpInputControl leaves the other two counters untouched', () => {
    const prev = { tsVersion: 5, staticVersion: 7, inputControlRefreshKey: 9 };
    const next = reducer(prev, { type: 'bumpInputControl' });
    expect(next.tsVersion).toBe(5);
    expect(next.staticVersion).toBe(7);
    expect(next.inputControlRefreshKey).toBe(10);
  });

  it('setTs writes an absolute value', () => {
    const next = reducer({ ...INITIAL, tsVersion: 99 }, { type: 'setTs', value: 3 });
    expect(next.tsVersion).toBe(3);
  });

  it('setStatic writes an absolute value', () => {
    const next = reducer({ ...INITIAL, staticVersion: 99 }, { type: 'setStatic', value: 3 });
    expect(next.staticVersion).toBe(3);
  });

  it('setInputControl writes an absolute value', () => {
    const next = reducer({ ...INITIAL, inputControlRefreshKey: 99 }, { type: 'setInputControl', value: 3 });
    expect(next.inputControlRefreshKey).toBe(3);
  });

  it('setTs to the same value still produces a new state object (pure reducer)', () => {
    const prev = { ...INITIAL, tsVersion: 5 };
    const next = reducer(prev, { type: 'setTs', value: 5 });
    expect(next).not.toBe(prev);
    expect(next.tsVersion).toBe(5);
  });

  it('reset returns INITIAL identity', () => {
    const dirty = { tsVersion: 10, staticVersion: 20, inputControlRefreshKey: 30 };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('happy path: bump each counter, then reset', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'bumpTs' });
    s = reducer(s, { type: 'bumpTs' });
    s = reducer(s, { type: 'bumpStatic' });
    s = reducer(s, { type: 'bumpInputControl' });
    expect(s.tsVersion).toBe(2);
    expect(s.staticVersion).toBe(1);
    expect(s.inputControlRefreshKey).toBe(1);
    s = reducer(s, { type: 'reset' });
    expect(s).toBe(INITIAL);
  });

  it('bus-sync pattern: setTs(received) mirrors a remote counter', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'setTs', value: 17 });
    s = reducer(s, { type: 'setStatic', value: 4 });
    s = reducer(s, { type: 'setInputControl', value: 99 });
    expect(s.tsVersion).toBe(17);
    expect(s.staticVersion).toBe(4);
    expect(s.inputControlRefreshKey).toBe(99);
  });
});
