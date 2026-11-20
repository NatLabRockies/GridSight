/**
 * Tests for the vertical-fill minZoom math. The invariant: at the returned
 * minZoom, the Web Mercator world (TILE_SIZE * 2^zoom px tall) is at least as
 * tall as the viewport, so the camera can pan in latitude without being
 * clamped to the pole. This is the core of the large-display pan-lock fix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { minZoomForHeight, applyVerticalFillMinZoom, applyRenderPixelRatio, TILE_SIZE } from '../mapCamera.js';

describe('minZoomForHeight', () => {
  it('world height at the returned zoom is >= viewport height', () => {
    for (const h of [400, 1080, 2160, 4000, 8000, 16000]) {
      const z = minZoomForHeight(h, { epsilon: 0 });
      const worldPx = TILE_SIZE * 2 ** z;
      expect(worldPx).toBeGreaterThanOrEqual(h - 1e-6);
    }
  });

  it('never returns negative zoom for short viewports', () => {
    expect(minZoomForHeight(300)).toBe(0); // 300 < TILE_SIZE(512) => clamp to 0
    expect(minZoomForHeight(100)).toBe(0);
  });

  it('matches the closed-form for the 8000px video-wall case', () => {
    // log2(8000/512) ≈ 3.966; the lock used to engage just below this.
    expect(minZoomForHeight(8000, { epsilon: 0 })).toBeCloseTo(Math.log2(8000 / 512), 5);
  });

  it('falls back gracefully on bad input', () => {
    expect(minZoomForHeight(0)).toBeGreaterThanOrEqual(0);
    expect(minZoomForHeight(NaN)).toBeGreaterThanOrEqual(0);
    expect(minZoomForHeight(-50)).toBeGreaterThanOrEqual(0);
  });
});

describe('applyVerticalFillMinZoom', () => {
  function fakeMap(clientHeight, { minZoom = 0, maxZoom = 22 } = {}) {
    let currentMin = minZoom;
    const calls = [];
    return {
      getContainer: () => ({ clientHeight }),
      getMinZoom: () => currentMin,
      getMaxZoom: () => maxZoom,
      setMinZoom: (z) => { currentMin = z; calls.push(z); },
      _calls: calls,
    };
  }

  it('sets minZoom from the container height', () => {
    const m = fakeMap(8000);
    const applied = applyVerticalFillMinZoom(m);
    expect(applied).toBeCloseTo(minZoomForHeight(8000), 5);
    expect(m._calls.length).toBe(1);
  });

  it('is idempotent — no setMinZoom when already at target', () => {
    const target = minZoomForHeight(8000);
    const m = fakeMap(8000, { minZoom: target });
    applyVerticalFillMinZoom(m);
    expect(m._calls.length).toBe(0);
  });

  it('never exceeds the map maxZoom', () => {
    const m = fakeMap(1e9, { maxZoom: 5 });
    const applied = applyVerticalFillMinZoom(m);
    expect(applied).toBe(5);
  });

  it('returns undefined for a missing map', () => {
    expect(applyVerticalFillMinZoom(null)).toBeUndefined();
    expect(applyVerticalFillMinZoom({})).toBeUndefined();
  });
});

describe('applyRenderPixelRatio', () => {
  const origWindow = globalThis.window;
  beforeEach(() => { globalThis.window = { devicePixelRatio: 1 }; });
  afterEach(() => { globalThis.window = origWindow; });

  function fakeMap() {
    const calls = [];
    return { setPixelRatio: (r) => calls.push(r), _calls: calls };
  }

  it('sets pixelRatio = devicePixelRatio * displayScale', () => {
    const m = fakeMap();
    expect(applyRenderPixelRatio(m, 3)).toBe(3);
    expect(m._calls).toEqual([3]);
  });

  it('honours a non-1 devicePixelRatio', () => {
    globalThis.window = { devicePixelRatio: 2 };
    const m = fakeMap();
    expect(applyRenderPixelRatio(m, 3)).toBe(6);
  });

  it('is idempotent for the same ratio', () => {
    const m = fakeMap();
    applyRenderPixelRatio(m, 3);
    applyRenderPixelRatio(m, 3);
    expect(m._calls).toEqual([3]);
  });

  it('updates when the scale changes', () => {
    const m = fakeMap();
    applyRenderPixelRatio(m, 3);
    applyRenderPixelRatio(m, 1);
    expect(m._calls).toEqual([3, 1]);
  });

  it('degrades gracefully without setPixelRatio (older maplibre)', () => {
    expect(applyRenderPixelRatio({}, 3)).toBeUndefined();
    expect(applyRenderPixelRatio(null, 3)).toBeUndefined();
  });
});
