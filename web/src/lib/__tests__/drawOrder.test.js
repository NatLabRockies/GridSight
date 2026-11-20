import { describe, expect, it } from 'vitest';
import { drawRank, sortForDrawing } from '../drawOrder.js';

const fc = (type) => ({ features: [{ geometry: null }, { geometry: { type } }] });

describe('drawRank', () => {
  it('ranks by deck layer type', () => {
    expect(drawRank({ deck_layer_type: 'GeneratorLayer' })).toBe(2);
    expect(drawRank({ deck_layer_type: 'TransmissionLayer' })).toBe(1);
    expect(drawRank({ deck_layer_type: 'PolygonLayer' })).toBe(0);
  });

  it('ranks GeoJSON layers by their first geometry', () => {
    expect(drawRank({ deck_layer_type: 'GeoJsonLayer' }, fc('MultiPolygon'))).toBe(0);
    expect(drawRank({ deck_layer_type: 'GeoJsonLayer' }, fc('LineString'))).toBe(1);
    expect(drawRank({ deck_layer_type: 'GeoJsonLayer' }, fc('Point'))).toBe(2);
  });

  it('treats unknown layers as lines', () => {
    expect(drawRank({ deck_layer_type: 'GeoJsonLayer' }, null)).toBe(1);
    expect(drawRank({})).toBe(1);
  });
});

describe('sortForDrawing', () => {
  it('draws areas, then lines, then points, keeping order within a kind', () => {
    const configs = [
      { id: 2, deck_layer_type: 'GeneratorLayer' },
      { id: 3, deck_layer_type: 'GeneratorLayer' },
      { id: 4, deck_layer_type: 'TransmissionLayer' },
      { id: 6, deck_layer_type: 'GeoJsonLayer' },
      { id: 7, deck_layer_type: 'GeoJsonLayer' },
    ];
    const geo = { 6: fc('MultiPolygon'), 7: fc('Polygon') };
    expect(sortForDrawing(configs, geo).map((c) => c.id)).toEqual([6, 7, 4, 2, 3]);
  });
});
