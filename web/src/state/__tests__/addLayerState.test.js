/**
 * Tests for the add-layer wizard reducer. The headline invariant is
 * `advanceToStep2`: it atomically saves IDs, clears error/saving,
 * and bumps step — replacing what used to be 4 separate setters.
 * Pin every field it touches.
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../addLayerState.js';

describe('addLayerState reducer', () => {
  it('initial state starts on step 1 with empty fields', () => {
    expect(INITIAL.step).toBe(1);
    expect(INITIAL.saving).toBe(false);
    expect(INITIAL.error).toBe('');
    expect(INITIAL.geometryFiles).toEqual([]);
    expect(INITIAL.layerName).toBe('');
    expect(INITIAL.selectedGeoId).toBe('');
    expect(INITIAL.deckLayerType).toBe('GeoJsonLayer');
    expect(INITIAL.datasets).toEqual([]);
    expect(INITIAL.selectedDatasetId).toBe('');
    expect(INITIAL.geomJoinKey).toBe('');
    expect(INITIAL.dataJoinKey).toBe('');
    expect(INITIAL.dataColumns).toEqual([]);
    expect(INITIAL.styleMappings).toEqual([]);
    expect(INITIAL.createdLayerId).toBe(null);
    expect(INITIAL.createdLayerDatasetId).toBe(null);
  });

  it('INITIAL.newMapping has sensible defaults', () => {
    expect(INITIAL.newMapping).toEqual({
      visual_property: 'getFillColor',
      column: '',
      colormap: 'viridis',
      scale_type: 'linear',
      domain_min: '',
      domain_max: '',
    });
  });

  it('set merges patch shallowly', () => {
    const next = reducer(INITIAL, {
      type: 'set',
      patch: { layerName: 'Roads', deckLayerType: 'ScatterplotLayer' },
    });
    expect(next.layerName).toBe('Roads');
    expect(next.deckLayerType).toBe('ScatterplotLayer');
    expect(next.step).toBe(1);
  });

  it('reset returns INITIAL identity', () => {
    const dirty = { ...INITIAL, step: 2, saving: true, layerName: 'x' };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('setNewMapping with an object merges with current newMapping', () => {
    const next = reducer(INITIAL, {
      type: 'setNewMapping',
      value: { column: 'population', colormap: 'plasma' },
    });
    expect(next.newMapping).toEqual({
      ...INITIAL.newMapping,
      column: 'population',
      colormap: 'plasma',
    });
  });

  it('setNewMapping with a function receives current newMapping and replaces it', () => {
    const prev = { ...INITIAL, newMapping: { ...INITIAL.newMapping, column: 'x' } };
    const next = reducer(prev, {
      type: 'setNewMapping',
      value: (current) => ({ ...current, domain_min: '0', domain_max: '100' }),
    });
    expect(next.newMapping.column).toBe('x');
    expect(next.newMapping.domain_min).toBe('0');
    expect(next.newMapping.domain_max).toBe('100');
  });

  it('setNewMapping function receives the CURRENT newMapping', () => {
    const prev = { ...INITIAL, newMapping: { ...INITIAL.newMapping, column: 'foo' } };
    let seen = null;
    reducer(prev, {
      type: 'setNewMapping',
      value: (current) => {
        seen = current;
        return current;
      },
    });
    expect(seen).toBe(prev.newMapping);
  });

  it('resetNewMapping returns newMapping to INITIAL.newMapping', () => {
    const prev = {
      ...INITIAL,
      newMapping: { ...INITIAL.newMapping, column: 'foo', colormap: 'plasma' },
    };
    const next = reducer(prev, { type: 'resetNewMapping' });
    expect(next.newMapping).toBe(INITIAL.newMapping);
    // Other fields untouched
    expect(next.step).toBe(prev.step);
  });

  it('appendStyleMapping pushes onto styleMappings', () => {
    const mapping = { visual_property: 'getFillColor', column: 'pop' };
    const next = reducer(INITIAL, { type: 'appendStyleMapping', mapping });
    expect(next.styleMappings).toEqual([mapping]);
  });

  it('appendStyleMapping preserves order with multiple calls', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'appendStyleMapping', mapping: { id: 'a' } });
    s = reducer(s, { type: 'appendStyleMapping', mapping: { id: 'b' } });
    s = reducer(s, { type: 'appendStyleMapping', mapping: { id: 'c' } });
    expect(s.styleMappings).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('removeStyleMapping drops the entry at the given index', () => {
    const prev = {
      ...INITIAL,
      styleMappings: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    };
    const next = reducer(prev, { type: 'removeStyleMapping', index: 1 });
    expect(next.styleMappings).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('advanceToStep2 atomically sets step/saving/error/createdLayerId/createdLayerDatasetId', () => {
    const prev = {
      ...INITIAL,
      saving: true,
      error: 'something to clear',
      step: 1,
      layerName: 'Roads',  // unrelated, must persist
    };
    const next = reducer(prev, {
      type: 'advanceToStep2',
      layerId: 42,
      layerDatasetId: 99,
    });
    expect(next.step).toBe(2);
    expect(next.saving).toBe(false);
    expect(next.error).toBe('');
    expect(next.createdLayerId).toBe(42);
    expect(next.createdLayerDatasetId).toBe(99);
    // Unrelated step-1 fields preserved.
    expect(next.layerName).toBe('Roads');
  });

  it('advanceToStep2 from a clean state still produces the full transition', () => {
    const next = reducer(INITIAL, {
      type: 'advanceToStep2',
      layerId: 'L1',
      layerDatasetId: 'D1',
    });
    expect(next.step).toBe(2);
    expect(next.saving).toBe(false);
    expect(next.error).toBe('');
    expect(next.createdLayerId).toBe('L1');
    expect(next.createdLayerDatasetId).toBe('D1');
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('happy path: fill step1 → advanceToStep2 → add style mapping', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'set', patch: { layerName: 'Roads', selectedGeoId: 'g1' } });
    s = reducer(s, { type: 'set', patch: { saving: true } });
    s = reducer(s, { type: 'advanceToStep2', layerId: 10, layerDatasetId: 20 });
    expect(s.step).toBe(2);
    expect(s.saving).toBe(false);
    s = reducer(s, {
      type: 'setNewMapping',
      value: { column: 'pop', colormap: 'magma' },
    });
    s = reducer(s, {
      type: 'appendStyleMapping',
      mapping: { ...s.newMapping },
    });
    expect(s.styleMappings).toHaveLength(1);
    expect(s.styleMappings[0].column).toBe('pop');
  });
});
