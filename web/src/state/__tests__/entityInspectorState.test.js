/**
 * Tests for the entity-inspector reducer. The whole point of using a
 * reducer (vs 11 separate useState calls) is the atomic trio
 * invariants: start sets loading; success/error clear loading and
 * update data together. Pin every triplet.
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../entityInspectorState.js';

describe('entityInspectorState reducer', () => {
  it('initial state: empty data, no loading, infocard starts collapsed', () => {
    expect(INITIAL.fullTimeseries).toBe(null);
    expect(INITIAL.loadingFull).toBe(false);
    expect(INITIAL.windowedTimeseries).toBe(null);
    expect(INITIAL.loadingWindow).toBe(false);
    expect(INITIAL.loadedRange).toBe(null);
    expect(INITIAL.controls).toEqual([]);
    expect(INITIAL.controlsLoading).toBe(false);
    expect(INITIAL.controlsError).toBe(null);
    expect(INITIAL.chartSpecs).toEqual([]);
    expect(INITIAL.chartsLoading).toBe(false);
    // Pin: infocard starts collapsed (not empty map).
    expect(INITIAL.collapsedSections).toEqual({ infocard: true });
  });

  it('set merges patch shallowly', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { loadingFull: true } });
    expect(next.loadingFull).toBe(true);
    expect(next.loadingWindow).toBe(false);
  });

  it('reset returns INITIAL identity', () => {
    const dirty = { ...INITIAL, loadingFull: true, controls: [{ name: 'x' }] };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('fullStart sets loadingFull true (data preserved until cleared)', () => {
    const prev = { ...INITIAL, fullTimeseries: { old: true } };
    const next = reducer(prev, { type: 'fullStart' });
    expect(next.loadingFull).toBe(true);
    expect(next.fullTimeseries).toEqual({ old: true });
  });

  it('fullSuccess clears loading AND stores value (atomic)', () => {
    const prev = { ...INITIAL, loadingFull: true };
    const value = { series: [1, 2, 3] };
    const next = reducer(prev, { type: 'fullSuccess', value });
    expect(next.loadingFull).toBe(false);
    expect(next.fullTimeseries).toBe(value);
  });

  it('fullError clears loading AND nulls out data', () => {
    const prev = { ...INITIAL, loadingFull: true, fullTimeseries: { stale: true } };
    const next = reducer(prev, { type: 'fullError' });
    expect(next.loadingFull).toBe(false);
    expect(next.fullTimeseries).toBe(null);
  });

  it('clearFull nulls fullTimeseries without touching loading flag', () => {
    const prev = { ...INITIAL, fullTimeseries: { x: 1 }, loadingFull: true };
    const next = reducer(prev, { type: 'clearFull' });
    expect(next.fullTimeseries).toBe(null);
    expect(next.loadingFull).toBe(true);
  });

  it('windowStart / windowSuccess / windowError follow the same trio pattern', () => {
    let s = reducer(INITIAL, { type: 'windowStart' });
    expect(s.loadingWindow).toBe(true);

    const value = { window: [1] };
    s = reducer(s, { type: 'windowSuccess', value });
    expect(s.loadingWindow).toBe(false);
    expect(s.windowedTimeseries).toBe(value);

    s = reducer({ ...s, loadingWindow: true }, { type: 'windowError' });
    expect(s.loadingWindow).toBe(false);
    expect(s.windowedTimeseries).toBe(null);
  });

  it('clearWindow nulls windowedTimeseries only', () => {
    const prev = { ...INITIAL, windowedTimeseries: { x: 1 }, loadingWindow: true };
    const next = reducer(prev, { type: 'clearWindow' });
    expect(next.windowedTimeseries).toBe(null);
    expect(next.loadingWindow).toBe(true);
  });

  it('setLoadedRange stores the range object', () => {
    const range = { fromMs: 0, toMs: 1000 };
    const next = reducer(INITIAL, { type: 'setLoadedRange', value: range });
    expect(next.loadedRange).toBe(range);
  });

  it('controlsStart sets loading AND clears prior error', () => {
    const prev = { ...INITIAL, controlsError: 'previously broken' };
    const next = reducer(prev, { type: 'controlsStart' });
    expect(next.controlsLoading).toBe(true);
    expect(next.controlsError).toBe(null);
  });

  it('controlsSuccess stores controls AND clears loading + error', () => {
    const prev = { ...INITIAL, controlsLoading: true, controlsError: 'x' };
    const value = [{ name: 'foo', value: 1 }];
    const next = reducer(prev, { type: 'controlsSuccess', value });
    expect(next.controls).toBe(value);
    expect(next.controlsLoading).toBe(false);
    expect(next.controlsError).toBe(null);
  });

  it('controlsError stores error, clears loading, blanks controls', () => {
    const prev = { ...INITIAL, controlsLoading: true, controls: [{ name: 'x' }] };
    const next = reducer(prev, { type: 'controlsError', error: 'fetch failed' });
    expect(next.controlsLoading).toBe(false);
    expect(next.controlsError).toBe('fetch failed');
    expect(next.controls).toEqual([]);
  });

  it('controlsPatch updates only the matching entry; others untouched', () => {
    const prev = {
      ...INITIAL,
      controls: [
        { name: 'a', value: 1 },
        { name: 'b', value: 2 },
        { name: 'c', value: 3 },
      ],
    };
    const next = reducer(prev, { type: 'controlsPatch', name: 'b', patch: { value: 42 } });
    expect(next.controls[0]).toEqual({ name: 'a', value: 1 });
    expect(next.controls[1]).toEqual({ name: 'b', value: 42 });
    expect(next.controls[2]).toEqual({ name: 'c', value: 3 });
  });

  it('controlsPatch on non-matching name leaves all entries unchanged', () => {
    const prev = { ...INITIAL, controls: [{ name: 'a', value: 1 }] };
    const next = reducer(prev, { type: 'controlsPatch', name: 'missing', patch: { value: 99 } });
    expect(next.controls).toEqual([{ name: 'a', value: 1 }]);
  });

  it('chartSpecsStart sets chartsLoading true', () => {
    const next = reducer(INITIAL, { type: 'chartSpecsStart' });
    expect(next.chartsLoading).toBe(true);
  });

  it('chartSpecsSuccess stores specs and clears loading', () => {
    const prev = { ...INITIAL, chartsLoading: true };
    const value = [{ id: 'c1' }];
    const next = reducer(prev, { type: 'chartSpecsSuccess', value });
    expect(next.chartSpecs).toBe(value);
    expect(next.chartsLoading).toBe(false);
  });

  it('chartSpecsError clears loading and blanks specs', () => {
    const prev = { ...INITIAL, chartsLoading: true, chartSpecs: [{ id: 'old' }] };
    const next = reducer(prev, { type: 'chartSpecsError' });
    expect(next.chartsLoading).toBe(false);
    expect(next.chartSpecs).toEqual([]);
  });

  it('toggleSection flips one key, leaving others alone', () => {
    const prev = { ...INITIAL, collapsedSections: { infocard: true, chart: false } };
    const next = reducer(prev, { type: 'toggleSection', name: 'chart' });
    expect(next.collapsedSections).toEqual({ infocard: true, chart: true });
  });

  it('toggleSection on undefined key sets it to true', () => {
    const next = reducer(INITIAL, { type: 'toggleSection', name: 'histogram' });
    expect(next.collapsedSections.histogram).toBe(true);
    // infocard preserved
    expect(next.collapsedSections.infocard).toBe(true);
  });

  it('setCollapsedSections replaces the whole map', () => {
    const value = { foo: true, bar: false };
    const next = reducer(INITIAL, { type: 'setCollapsedSections', value });
    expect(next.collapsedSections).toBe(value);
  });

  it('unknown action returns same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });
});
