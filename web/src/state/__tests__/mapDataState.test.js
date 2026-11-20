/**
 * Tests for the map-data reducer — generic layer configs plus the four
 * per-layer maps (geo, data, visibility, localStyle) and the two anchored
 * Sets.
 *
 * The big invariant we pin: removeLayer must clean up entries in EVERY
 * one of the per-layer maps and drop the Set membership. Forgetting one
 * leaves dangling geometry/data that the renderer will try to draw for
 * a layer the user just deleted.
 *
 * Also pinned: patchLayerStyle deep-merges into the existing style
 * (preserves prior fields), unlike setLayerStyle which replaces.
 */
import { describe, it, expect } from 'vitest';
import { reducer, INITIAL } from '../mapDataState.js';

describe('mapDataState reducer', () => {
  it('initial state shape: empty maps, empty Sets, empty configs', () => {
    expect(INITIAL.configs).toEqual([]);
    expect(INITIAL.geo).toEqual({});
    expect(INITIAL.data).toEqual({});
    expect(INITIAL.visibility).toEqual({});
    expect(INITIAL.localStyle).toEqual({});
    expect(INITIAL.anchoredLayers).toBeInstanceOf(Set);
    expect(INITIAL.anchoredLayers.size).toBe(0);
    expect(INITIAL.anchoredCharts).toBeInstanceOf(Set);
    expect(INITIAL.anchoredCharts.size).toBe(0);
  });

  it('set shallow-merges a patch (escape hatch)', () => {
    const next = reducer(INITIAL, { type: 'set', patch: { configs: [{ id: 'a' }] } });
    expect(next.configs).toEqual([{ id: 'a' }]);
    expect(next.geo).toEqual({});
  });

  it('setConfigs accepts a direct value', () => {
    const configs = [{ id: 'a' }, { id: 'b' }];
    const next = reducer(INITIAL, { type: 'setConfigs', configs });
    expect(next.configs).toBe(configs);
  });

  it('setConfigs accepts an updater function (React useState pattern)', () => {
    const prev = { ...INITIAL, configs: [{ id: 'a' }] };
    const next = reducer(prev, {
      type: 'setConfigs',
      configs: (cur) => [...cur, { id: 'b' }],
    });
    expect(next.configs).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('setLayerGeo writes one key without disturbing others', () => {
    const prev = { ...INITIAL, geo: { a: { type: 'FeatureCollection', features: [] } } };
    const fc = { type: 'FeatureCollection', features: [{ id: 1 }] };
    const next = reducer(prev, { type: 'setLayerGeo', layerId: 'b', geo: fc });
    expect(next.geo.a).toBe(prev.geo.a);
    expect(next.geo.b).toBe(fc);
  });

  it('setLayerData writes one key without disturbing others', () => {
    const prev = { ...INITIAL, data: { a: new Map() } };
    const m = new Map([[1, 42]]);
    const next = reducer(prev, { type: 'setLayerData', layerId: 'b', data: m });
    expect(next.data.b).toBe(m);
    expect(next.data.a).toBe(prev.data.a);
  });

  it('setLayerVisibility flips visibility for a single layer', () => {
    const next = reducer(INITIAL, { type: 'setLayerVisibility', layerId: 'a', visible: true });
    expect(next.visibility.a).toBe(true);
    const next2 = reducer(next, { type: 'setLayerVisibility', layerId: 'a', visible: false });
    expect(next2.visibility.a).toBe(false);
  });

  it('setLayerStyle replaces the layer style entirely', () => {
    const prev = { ...INITIAL, localStyle: { a: { opacity: 0.5, radiusScale: 2 } } };
    const next = reducer(prev, {
      type: 'setLayerStyle',
      layerId: 'a',
      style: { opacity: 1 },
    });
    expect(next.localStyle.a).toEqual({ opacity: 1 });
    // radiusScale is gone — setLayerStyle REPLACES
    expect(next.localStyle.a.radiusScale).toBeUndefined();
  });

  it('patchLayerStyle deep-merges into existing style, preserving prior fields', () => {
    const prev = {
      ...INITIAL,
      localStyle: { a: { opacity: 0.5, radiusScale: 2 } },
    };
    const next = reducer(prev, {
      type: 'patchLayerStyle',
      layerId: 'a',
      patch: { opacity: 1 },
    });
    expect(next.localStyle.a.opacity).toBe(1);
    expect(next.localStyle.a.radiusScale).toBe(2); // preserved
  });

  it('patchLayerGeoMapping accumulates mappings across successive calls', () => {
    // The regression this guards: the assistant sizes a layer and colours it
    // in two back-to-back calls. When the geoMappings merge happened outside
    // the reducer, both calls read the same pre-state and the second dropped
    // the first — the layer came out sized OR coloured, never both.
    let s = reducer(INITIAL, {
      type: 'patchLayerGeoMapping',
      layerId: 'a',
      visualProperty: 'getPointRadius',
      mapping: { property: 'total_mw', scale_type: 'linear' },
      patch: { units: 'meters' },
    });
    s = reducer(s, {
      type: 'patchLayerGeoMapping',
      layerId: 'a',
      visualProperty: 'getFillColor',
      mapping: { property: 'stage', scale_type: 'categorical' },
      patch: {},
    });

    expect(Object.keys(s.localStyle.a.geoMappings).sort())
      .toEqual(['getFillColor', 'getPointRadius']);
    expect(s.localStyle.a.geoMappings.getPointRadius.property).toBe('total_mw');
    expect(s.localStyle.a.geoMappings.getFillColor.property).toBe('stage');
    // Non-mapping style knobs from the earlier call survive too.
    expect(s.localStyle.a.units).toBe('meters');
    // Both styled columns stay in the viewport fetch set.
    expect(s.localStyle.a.viewportColumns.sort()).toEqual(['stage', 'total_mw']);
  });

  it('patchLayerGeoMapping re-styling the same property replaces just that mapping', () => {
    let s = reducer(INITIAL, {
      type: 'patchLayerGeoMapping',
      layerId: 'a',
      visualProperty: 'getFillColor',
      mapping: { property: 'stage', scale_type: 'categorical' },
    });
    s = reducer(s, {
      type: 'patchLayerGeoMapping',
      layerId: 'a',
      visualProperty: 'getFillColor',
      mapping: { property: 'company_type', scale_type: 'categorical' },
    });
    expect(s.localStyle.a.geoMappings.getFillColor.property).toBe('company_type');
    expect(Object.keys(s.localStyle.a.geoMappings)).toEqual(['getFillColor']);
  });

  it('patchLayerStyle works when no prior style exists for the layer', () => {
    const next = reducer(INITIAL, {
      type: 'patchLayerStyle',
      layerId: 'a',
      patch: { opacity: 0.8 },
    });
    expect(next.localStyle.a).toEqual({ opacity: 0.8 });
  });

  it('replaceGeoMap / replaceDataMap / replaceVisibilityMap / replaceLocalStyleMap swap whole maps', () => {
    const newGeo = { a: { type: 'FeatureCollection', features: [] } };
    const newData = { a: new Map() };
    const newVis = { a: true };
    const newStyle = { a: { opacity: 0.1 } };
    let s = reducer(INITIAL, { type: 'replaceGeoMap', value: newGeo });
    s = reducer(s, { type: 'replaceDataMap', value: newData });
    s = reducer(s, { type: 'replaceVisibilityMap', value: newVis });
    s = reducer(s, { type: 'replaceLocalStyleMap', value: newStyle });
    expect(s.geo).toBe(newGeo);
    expect(s.data).toBe(newData);
    expect(s.visibility).toBe(newVis);
    expect(s.localStyle).toBe(newStyle);
  });

  it('removeLayer drops the layer from configs and all per-layer maps', () => {
    const anchored = new Set(['a', 'b']);
    const prev = {
      ...INITIAL,
      configs: [{ id: 'a' }, { id: 'b' }],
      geo: { a: 'geoA', b: 'geoB' },
      data: { a: 'dataA', b: 'dataB' },
      visibility: { a: true, b: false },
      localStyle: { a: { opacity: 0.5 }, b: { opacity: 1 } },
      anchoredLayers: anchored,
    };
    const next = reducer(prev, { type: 'removeLayer', layerId: 'a' });
    expect(next.configs).toEqual([{ id: 'b' }]);
    expect(next.geo).toEqual({ b: 'geoB' });
    expect(next.data).toEqual({ b: 'dataB' });
    expect(next.visibility).toEqual({ b: false });
    expect(next.localStyle).toEqual({ b: { opacity: 1 } });
    expect(next.anchoredLayers.has('a')).toBe(false);
    expect(next.anchoredLayers.has('b')).toBe(true);
    // original Set must not be mutated
    expect(anchored.has('a')).toBe(true);
  });

  it('removeLayer on an unknown id is a graceful no-op-shape change', () => {
    const prev = { ...INITIAL, configs: [{ id: 'a' }], geo: { a: 'geoA' } };
    const next = reducer(prev, { type: 'removeLayer', layerId: 'zzz' });
    expect(next.configs).toEqual([{ id: 'a' }]);
    expect(next.geo).toEqual({ a: 'geoA' });
  });

  it('toggleAnchoredLayer adds when absent, removes when present', () => {
    const added = reducer(INITIAL, { type: 'toggleAnchoredLayer', layerId: 'a' });
    expect(added.anchoredLayers.has('a')).toBe(true);
    expect(INITIAL.anchoredLayers.has('a')).toBe(false); // didn't mutate INITIAL
    const removed = reducer(added, { type: 'toggleAnchoredLayer', layerId: 'a' });
    expect(removed.anchoredLayers.has('a')).toBe(false);
  });

  it('toggleAnchoredChart adds when absent, removes when present', () => {
    const added = reducer(INITIAL, { type: 'toggleAnchoredChart', chartId: 'c1' });
    expect(added.anchoredCharts.has('c1')).toBe(true);
    const removed = reducer(added, { type: 'toggleAnchoredChart', chartId: 'c1' });
    expect(removed.anchoredCharts.has('c1')).toBe(false);
  });

  it('reset returns INITIAL identity', () => {
    const dirty = {
      ...INITIAL,
      configs: [{ id: 'a' }],
      geo: { a: 'x' },
      anchoredLayers: new Set(['a']),
    };
    expect(reducer(dirty, { type: 'reset' })).toBe(INITIAL);
  });

  it('unknown action returns the same state reference', () => {
    expect(reducer(INITIAL, { type: 'noop' })).toBe(INITIAL);
  });

  it('happy path: add a layer, style it, anchor it, then remove it cleanly', () => {
    let s = INITIAL;
    s = reducer(s, { type: 'setConfigs', configs: [{ id: 'a' }] });
    s = reducer(s, { type: 'setLayerGeo', layerId: 'a', geo: { type: 'FeatureCollection', features: [] } });
    s = reducer(s, { type: 'setLayerVisibility', layerId: 'a', visible: true });
    s = reducer(s, { type: 'setLayerStyle', layerId: 'a', style: { opacity: 0.5 } });
    s = reducer(s, { type: 'patchLayerStyle', layerId: 'a', patch: { radiusScale: 3 } });
    s = reducer(s, { type: 'toggleAnchoredLayer', layerId: 'a' });
    expect(s.anchoredLayers.has('a')).toBe(true);
    expect(s.localStyle.a).toEqual({ opacity: 0.5, radiusScale: 3 });
    s = reducer(s, { type: 'removeLayer', layerId: 'a' });
    expect(s.configs).toEqual([]);
    expect(s.geo).toEqual({});
    expect(s.visibility).toEqual({});
    expect(s.localStyle).toEqual({});
    expect(s.anchoredLayers.has('a')).toBe(false);
  });
});
