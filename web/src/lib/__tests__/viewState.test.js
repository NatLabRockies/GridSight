import { describe, expect, it } from 'vitest';
import { captureViewState, withoutTransientStyle } from '../viewState.js';

describe('withoutTransientStyle', () => {
  it('removes the legend hover and keeps everything else', () => {
    const out = withoutTransientStyle({
      2: { hoverCategory: 'Biopower', filterEnabled: false, radiusScale: 0.02 },
      6: { hoverCategory: null, opacity: 0.5 },
    });
    expect(out).toEqual({
      2: { filterEnabled: false, radiusScale: 0.02 },
      6: { opacity: 0.5 },
    });
  });

  it('does not change its input', () => {
    const input = { 2: { hoverCategory: 'PV' } };
    withoutTransientStyle(input);
    expect(input[2].hoverCategory).toBe('PV');
  });

  it('accepts an empty or missing map', () => {
    expect(withoutTransientStyle(undefined)).toEqual({});
    expect(withoutTransientStyle({})).toEqual({});
  });
});

describe('captureViewState', () => {
  it('does not save a legend hover', () => {
    const blob = captureViewState({
      genericLayerLocalStyle: { 2: { hoverCategory: 'Biopower', radiusScale: 0.02 } },
      genericLayerVisibility: { 2: true },
    });
    expect(blob.layers.localStyle[2]).toEqual({ radiusScale: 0.02 });
  });
});
