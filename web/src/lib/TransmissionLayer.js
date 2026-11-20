/**
 * TransmissionLayer
 *
 * A domain-specific PathLayer for power system transmission lines. Each line
 * has a thermal capacity (MW) and a time-varying flow (MW). Loading is
 * computed as abs(flow / capacity) and mapped to a color ramp:
 *
 *   0%  →  green    (no stress)
 *   50% →  yellow   (moderate)
 *  100% →  red      (fully loaded / overloaded)
 *
 * Flow direction is encoded via color intensity:
 *   - Positive flow: bright color (full alpha)
 *   - Negative flow: dim color (reduced alpha)
 *   - Zero flow:     neutral gray
 *
 * Line width scales with loading percentage.
 *
 * Colors are computed CPU-side during tessellation and passed via getColor.
 * No custom shader extension — uses plain PathLayer for maximum compatibility.
 */

import { PathLayer, LayerExtension } from 'deck.gl';
import { DataFilterExtension } from '@deck.gl/extensions';
import { sampleColormap, COLORMAPS } from './colormaps.js';
import * as WorkerCache from './workers/LayerWorkerCache.js';
import { GpuTransmissionLayer } from './shaders/StylesTextureExtension.js';

// ─── Directional gradient shader extension ───────────────────────────────────
//
// Injects two instanced color attributes (dimColor, brightColor) and
// interpolates between them along the path using vPathPosition.y / vPathLength.
// For positive flow the gradient goes dim→bright (start→end), for negative
// flow the caller swaps the colors so it goes bright→dim.
//
// This runs AFTER the core PathLayer vertex shader has computed vPathPosition
// and vPathLength, so the fragment shader can do per-pixel interpolation.

class DirectionalLoadingExtension extends LayerExtension {
  getShaders() {
    return {
      inject: {
        'vs:#decl': `
          in vec4 instanceDimColors;
          in vec4 instanceBrightColors;
          out vec4 vDimColor;
          out vec4 vBrightColor;
          out float vNormalizedPathPos;
        `,
        // PathLayer's VS has already computed vPathPosition and vPathLength
        // by the time #main-end runs. Compute the normalized 0→1 position here
        // so the FS doesn't need to reference PathLayer internals.
        'vs:#main-end': `
          vDimColor = instanceDimColors;
          vBrightColor = instanceBrightColors;
          // Whole-path position: vPathPosition.y/vPathLength is per-SEGMENT
          // (deck exposes no cumulative distance), so it repeats the gradient on
          // every segment. Instead interpolate the per-vertex path fraction
          // baked into z (see pathWithFractionZ) across this segment — a single
          // smooth dim→bright sweep over the entire line.
          float segT = clamp(vPathPosition.y / max(vPathLength, 1e-6), 0.0, 1.0);
          vNormalizedPathPos = mix(instanceStartPositions.z, instanceEndPositions.z, segT);
        `,
        'fs:#decl': `
          in vec4 vDimColor;
          in vec4 vBrightColor;
          in float vNormalizedPathPos;
        `,
        'fs:DECKGL_FILTER_COLOR': `
          vec4 dimNorm = vDimColor / 255.0;
          vec4 brightNorm = vBrightColor / 255.0;
          float t = vNormalizedPathPos * vNormalizedPathPos;
          vec4 dirColor = mix(dimNorm, brightNorm, t);
          color = vec4(dirColor.rgb, dirColor.a * layer.opacity);
        `,
      },
    };
  }

  initializeState() {
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      attributeManager.addInstanced({
        instanceDimColors: {
          size: 4,
          type: 'float32',
          accessor: 'getDimColor',
          transition: true,
        },
        instanceBrightColors: {
          size: 4,
          type: 'float32',
          accessor: 'getBrightColor',
          transition: true,
        },
      });
    }
  }
}

DirectionalLoadingExtension.extensionName = 'DirectionalLoadingExtension';
DirectionalLoadingExtension.defaultProps = {
  getDimColor: { type: 'accessor', value: [70, 130, 180, 40], transition: true },
  getBrightColor: { type: 'accessor', value: [70, 130, 180, 220], transition: true },
};

// ─── Loading color ramp ──────────────────────────────────────────────────────
// Each stop is [fraction_0_to_1, [r, g, b]].
// Configurable via localStyle.loadingRamp (array of [fraction, [r,g,b]]).
const DEFAULT_LOADING_RAMP = [
  [0,    [46, 125, 50]],     // 0%   — dark green (idle)
  [0.3,  [76, 175, 80]],     // 30%  — green (normal)
  [0.6,  [139, 195, 74]],    // 60%  — light green (moderate)
  [0.75, [255, 235, 59]],    // 75%  — yellow (elevated)
  [0.85, [255, 152, 0]],     // 85%  — orange (high)
  [0.95, [244, 67, 54]],     // 95%  — red (near limit)
  [1.0,  [183, 28, 28]],     // 100% — dark red (at/over limit)
];

// Loading domain: [min, max] fraction. Loading values are mapped into this
// range before sampling the ramp. Default [0, 1] = 0-100%.
// Set to e.g. [0, 0.5] to make the ramp saturate at 50% loading.
const DEFAULT_LOADING_DOMAIN = [0, 1.0];

const DEFAULT_NEUTRAL_COLOR = [70, 130, 180, 100]; // steel-blue idle tint (see GREY_COLOR)
const DEFAULT_DIM_ALPHA = 10;
const DEFAULT_BRIGHT_ALPHA = 220;

/**
 * Sample a color ramp at a given loading fraction.
 * @param {number} loading - raw loading fraction (0 = idle, 1 = 100%)
 * @param {Array} ramp - color ramp stops [[fraction, [r,g,b]], ...]
 * @param {number[]} domain - [min, max] loading range mapped to ramp [0,1]
 * @returns {number[]} [r, g, b]
 */
function sampleLoadingColor(loading, ramp = DEFAULT_LOADING_RAMP, domain = DEFAULT_LOADING_DOMAIN) {
  // Map loading into [0,1] based on domain
  const [dMin, dMax] = domain;
  const range = dMax - dMin || 1;
  const t = Math.max(0, Math.min(1, (loading - dMin) / range));

  for (let i = 1; i < ramp.length; i++) {
    const [t1, c1] = ramp[i];
    if (t <= t1) {
      const [t0, c0] = ramp[i - 1];
      const f = (t - t0) / (t1 - t0);
      return c0.map((v, j) => Math.round(v + f * (c1[j] - v)));
    }
  }
  return ramp[ramp.length - 1][1];
}

// ─── Tessellation ─────────────────────────────────────────────────────────────

/**
 * Build path data for a single transmission line feature.
 *
 * @param {number[][]} coordinates - LineString coordinate array
 * @param {number} flow - Current flow in MW (signed)
 * @param {number} capacity - Thermal capacity in MW
 * @param {object} opts - Color/style options
 * @returns {object} { path, color, width }
 */
// ─── Piecewise loading colormap ──────────────────────────────────────────────
//
// Three discrete bands with adjustable boundaries:
//   loading <  orangeThreshold : GREY  (alpha grows linearly with loading)
//   loading <  redThreshold    : ORANGE
//   loading >= redThreshold    : RED
//
// In the grey zone, alpha ramps from MIN_GREY_ALPHA_RATIO (at loading=0) to
// 1.0 (at loading=orangeThreshold), so heavier lines show through more
// strongly without using colour. The dim→bright direction encoding is
// preserved across all zones (both endpoint alphas scale together).
//
// Small smooth transition bands at the zone boundaries avoid visible banding
// when scrubbing the threshold sliders.

// Idle / low-load tint. A muted steel-blue rather than grey so barely-loaded
// (or de-energized) lines stay distinct from grey basemap streets — the cool
// end also reads intuitively as "unstressed" against the orange/red stress
// zones. Name kept as GREY_COLOR for history. Mirror this value in
// workers/transmissionLayer.worker.js and shaders/StylesTextureExtension.js.
const GREY_COLOR   = [70, 130, 180];

// Selectable low-usage (idle / low-load) palettes, chosen per layer via
// localStyle.lowUsageColor. 'steel' (default) keeps idle lines distinct from
// grey basemap streets; 'grey' restores the classic neutral. Each drives BOTH
// the piecewise low-load zone (idle) and the zero-flow color (neutral). Mirror
// these values in transmissionLayer.worker.js and StylesTextureExtension.js.
export const LOW_USAGE_PALETTES = {
  steel: { idle: [70, 130, 180], neutral: [70, 130, 180, 100] },
  grey: { idle: [120, 120, 120], neutral: [128, 128, 128, 100] },
};
export function resolveLowUsagePalette(mode) {
  return LOW_USAGE_PALETTES[mode] || LOW_USAGE_PALETTES.steel;
}
const ORANGE_COLOR = [255, 152, 0];
const RED_COLOR    = [183, 28, 28];

// Min alpha multiplier when loading=0 in the grey zone (very faint but visible).
const MIN_GREY_ALPHA_RATIO = 0.12;
// Smooth-transition band width (in loading fraction) at each colour boundary.
const ZONE_TRANSITION_BAND = 0.02;

function smoothstep(edge0, edge1, x) {
  if (edge0 >= edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function piecewiseColor(loading, orangeThreshold, redThreshold, idleColor = GREY_COLOR) {
  // Smooth transition at each boundary; pure colours in between. `idleColor`
  // is the low-load base (steel-blue or grey per layer config).
  if (loading < orangeThreshold - ZONE_TRANSITION_BAND) return idleColor;
  if (loading < orangeThreshold + ZONE_TRANSITION_BAND) {
    const t = smoothstep(
      orangeThreshold - ZONE_TRANSITION_BAND,
      orangeThreshold + ZONE_TRANSITION_BAND,
      loading,
    );
    return lerpColor(idleColor, ORANGE_COLOR, t);
  }
  if (loading < redThreshold - ZONE_TRANSITION_BAND) return ORANGE_COLOR;
  if (loading < redThreshold + ZONE_TRANSITION_BAND) {
    const t = smoothstep(
      redThreshold - ZONE_TRANSITION_BAND,
      redThreshold + ZONE_TRANSITION_BAND,
      loading,
    );
    return lerpColor(ORANGE_COLOR, RED_COLOR, t);
  }
  return RED_COLOR;
}

function buildTransmissionPath(coordinates, flow, capacity, opts = {}) {
  const neutralColor = opts.neutralColor ?? DEFAULT_NEUTRAL_COLOR;
  const dimAlpha = opts.dimAlpha ?? DEFAULT_DIM_ALPHA;
  const brightAlpha = opts.brightAlpha ?? DEFAULT_BRIGHT_ALPHA;
  const orangeThreshold = opts.orangeThreshold ?? 0.85;
  const redThreshold = opts.redThreshold ?? 0.95;
  // colorMode: 'piecewise' (grey/orange/red zones) | a key in COLORMAPS
  // (e.g. 'plasma', 'viridis') for a continuous gradient over [0, 1] loading.
  const colorMode = opts.colorMode ?? 'piecewise';
  // Max alpha multiplier for sub-threshold lines. Lower = more faded
  // unstressed network. The alpha ramp goes from MIN_GREY_ALPHA_RATIO at
  // loading=0 up to greyAlphaMax at loading=orangeThreshold.
  const greyAlphaMax = opts.greyAlphaMax ?? 1.0;
  const absFlow = Math.abs(flow);

  // Zero flow or zero capacity → neutral color, minimum width
  if (absFlow < 1e-6 || !capacity || capacity <= 0) {
    return {
      path: coordinates, width: 0.5, loading: 0, flow: 0,
      dimColor: neutralColor, brightColor: neutralColor,
    };
  }

  const loading = absFlow / capacity;

  // Alpha ramp: grows in [0, orangeThreshold] from MIN→greyAlphaMax, then
  // saturates to 1.0 above orangeThreshold (sub-threshold lines never exceed
  // greyAlphaMax, even right at the threshold).
  let alphaFactor;
  if (loading >= orangeThreshold) {
    alphaFactor = 1.0;
  } else {
    const t = orangeThreshold > 0 ? loading / orangeThreshold : 1.0;
    alphaFactor = MIN_GREY_ALPHA_RATIO + (greyAlphaMax - MIN_GREY_ALPHA_RATIO) * t;
  }

  // Color: piecewise zones OR a sampled continuous colormap.
  let rgb;
  if (colorMode === 'piecewise' || !(colorMode in COLORMAPS)) {
    rgb = piecewiseColor(loading, orangeThreshold, redThreshold);
  } else {
    // Clamp loading to [0, 1] for colormap sampling — overload >1 maps to top.
    rgb = sampleColormap(colorMode, Math.min(1, loading)).slice(0, 3);
  }

  // Both endpoints scale by alphaFactor so the dim→bright direction encoding
  // is preserved across all zones (relative ratio dimAlpha:brightAlpha intact).
  const dimColor = [...rgb, Math.round(dimAlpha * alphaFactor)];
  const brightColor = [...rgb, Math.round(brightAlpha * alphaFactor)];

  // Width driven by abs(flow) — sqrt scaling for visual balance.
  const width = Math.sqrt(absFlow) * 0.3;

  // Positive flow: gradient goes dim→bright (start→end of path).
  // Negative flow: swap so gradient goes bright→dim.
  return {
    path: coordinates, width, loading, flow: absFlow,
    dimColor:    flow > 0 ? dimColor : brightColor,
    brightColor: flow > 0 ? brightColor : dimColor,
  };
}

// ─── Static-geometry cache ──────────────────────────────────────────────────
// Tessellated path data + per-feature constants (capacity, entityId, properties)
// are invariant across clock ticks. Cache them by geoData identity so we only
// pay this cost once per geometry load. Per tick, only the typed-array
// attribute buffers (dimColors / brightColors / widths) are rebuilt.
const STATIC_CACHE = new WeakMap();

// One-time warn (per layer id) when the GPU-texture path is requested but the
// geometry is multi-vertex — see the fallback guard in createTransmissionLayer.
const _gpuMultiVertexWarned = new Set();

/**
 * Return path coordinates with each vertex's normalized distance along the
 * whole path (0 at start → 1 at end) written into its z component.
 *
 * deck.gl's PathLayer only exposes PER-SEGMENT distance to the shader
 * (vPathPosition.y / vPathLength), so a dim→bright directional gradient repeats
 * on every segment and looks choppy on real multi-vertex paths. By carrying the
 * cumulative fraction in z, the shader can read the segment's start/end fraction
 * from instanceStartPositions.z / instanceEndPositions.z (which deck's
 * tessellator aligns for us) and interpolate a smooth WHOLE-path gradient. The
 * z value (0..1 "metres") is a negligible elevation on a map and doesn't move
 * the line visibly. Computed once at cache build, not per tick.
 */
function pathWithFractionZ(coords) {
  const n = coords?.length ?? 0;
  if (n < 2) return coords;
  let total = 0;
  const cum = new Array(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    const dx = coords[i][0] - coords[i - 1][0];
    const dy = coords[i][1] - coords[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
    cum[i] = total;
  }
  const inv = total > 0 ? 1 / total : 0;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = [coords[i][0], coords[i][1], cum[i] * inv];
  }
  return out;
}

function getStaticTransmissionData(geoData, joinKey, capacityProperty) {
  let entry = STATIC_CACHE.get(geoData);
  if (entry && entry.joinKey === joinKey && entry.capacityProperty === capacityProperty) {
    return entry;
  }
  const features = geoData?.features ?? (Array.isArray(geoData) ? geoData : []);
  // First pass: count valid features and total segment count so we can
  // pre-allocate the per-segment featureIndices buffer for the GPU path.
  let validCount = 0;
  let totalSegments = 0;
  for (const f of features) {
    const c = f.geometry?.coordinates;
    if (!c || f.geometry?.type !== 'LineString') continue;
    validCount++;
    totalSegments += Math.max(0, c.length - 1);
  }

  const paths = new Array(validCount);
  const capacities = new Float32Array(validCount);
  const entityIds = new Array(validCount);
  // GPU-path attribute: one entry per PathLayer instance (= one per
  // segment), holding the parent feature's index. Built once at cache
  // construction; never updated. PathLayer reads this as a binary
  // attribute, the shader uses int(instanceFeatureIndex) as the column
  // into the styles texture.
  const featureIndices = new Float32Array(totalSegments);

  let n = 0;
  let segOff = 0;
  for (const feature of features) {
    const coords = feature.geometry?.coordinates;
    if (!coords || feature.geometry?.type !== 'LineString') continue;
    capacities[n] = parseFloat(feature.properties?.[capacityProperty]) || 0;
    entityIds[n] = String(feature.properties?.[joinKey] ?? '');
    const segCount = Math.max(0, coords.length - 1);
    for (let s = 0; s < segCount; s++) featureIndices[segOff + s] = n;
    segOff += segCount;
    // Reusable per-tick mutation targets. All slots pre-allocated once at
    // cache build; per-tick loop mutates these in place to keep allocation
    // out of the hot path entirely.
    const propsObj = { ...feature.properties, flow: 0, loading_pct: 0 };
    paths[n] = {
      path: pathWithFractionZ(coords),
      properties: propsObj,
      geometry: feature.geometry,
      feature,
      _idx: n,
      dimColor: [70, 130, 180, 100],   // steel-blue idle seed (see GREY_COLOR)
      brightColor: [70, 130, 180, 100],
      width: 1,
    };
    n++;
  }
  entry = {
    paths,
    capacities,
    entityIds,
    n,
    totalSegments,
    featureIndices,
    joinKey,
    capacityProperty,
  };
  STATIC_CACHE.set(geoData, entry);
  return entry;
}

// ─── Layer factory ────────────────────────────────────────────────────────────

/**
 * Create a TransmissionLayer from GeoJSON LineString features.
 *
 * @param {object} options
 * @param {string} options.id - Layer ID
 * @param {object} options.geoData - GeoJSON FeatureCollection
 * @param {Map|null} options.dataIndex - Map<entityId → flowValue | { flow, ... }>
 * @param {string} options.joinKey - GeoJSON property to join on
 * @param {string} options.flowColumn - Column in dataIndex for flow
 * @param {string} options.capacityProperty - GeoJSON property for capacity
 * @param {number[]} options.neutralColor - RGBA for zero-flow lines
 * @param {number} options.dimAlpha - Alpha for negative-flow lines
 * @param {number} options.brightAlpha - Alpha for positive-flow lines
 * @param {number} options.widthScale
 * @param {number} options.widthMinPixels
 * @param {number} options.widthMaxPixels
 * @param {number} options.opacity
 * @param {boolean} options.pickable
 * @param {function} options.onHover
 * @param {function} options.onClick
 * @param {number} options.transitionDuration
 * @returns {PathLayer|null}
 */
export function createTransmissionLayer({
  id = 'transmission-lines',
  geoData,
  dataIndex,
  joinKey = 'name',
  flowColumn = '__timeseries__',
  capacityProperty = 'capacity',
  neutralColor = DEFAULT_NEUTRAL_COLOR,
  idleColor = GREY_COLOR,               // low-load piecewise base (steel/grey)
  dimAlpha = DEFAULT_DIM_ALPHA,
  brightAlpha = DEFAULT_BRIGHT_ALPHA,
  loadingRamp = DEFAULT_LOADING_RAMP,    // legacy (no longer used by piecewise renderer)
  loadingDomain = DEFAULT_LOADING_DOMAIN, // legacy (no longer used by piecewise renderer)
  orangeThreshold = 0.85,
  redThreshold = 0.95,
  colorMode = 'piecewise',
  greyAlphaMax = 1.0,
  widthScale = 1,
  widthMinPixels = 1,
  widthMaxPixels = 12,
  widthUnits = 'pixels',
  opacity = 0.85,
  pickable = true,
  onHover = null,
  onClick = null,
  transitionDuration = 0,
  filterProperty = null,
  filterCategories = null,
  tsVersion = 0,
  // Phase 2: optional Web Worker precompute path. When `useWorker` is true
  // and `timeseriesBuffer` is provided, per-(timestep × feature) buffers
  // are computed in a worker once per partition load. Per-tick CPU on the
  // main thread becomes a memcpy from the worker buffer into the cached
  // path RGBA + width slots; deck.gl reads via function accessors as on
  // the inline path.
  useWorker = false,
  timeseriesBuffer = null,
  onWorkerUpdate = null,
  // Phase 3: GPU-texture timeseries path. When `useGpuTexture` is true
  // (in addition to `useWorker`), the worker's whole-partition packed
  // style buffer is uploaded as an rgba32float texture and indexed into
  // by `instanceFeatureIndex` + `currentIndex` uniform from the vertex
  // shader. Per-tick CPU becomes a single uniform write — flat with N.
  // Falls back to the Phase 2 path if texture creation fails or the
  // worker frame isn't ready yet.
  useGpuTexture = false,
} = {}) {
  if (!geoData) return null;

  const staticData = getStaticTransmissionData(geoData, joinKey, capacityProperty);
  if (!staticData.n) return null;

  const { paths, capacities, entityIds, n, totalSegments, featureIndices } = staticData;

  // Optionally pull a precomputed frame from the worker cache. If we get
  // one, the per-tick CPU loop becomes a small properties-mutation pass for
  // picking; deck.gl receives the colors/widths directly as typed arrays.
  const styleSig = `${neutralColor.join(',')}|${dimAlpha}|${brightAlpha}|${orangeThreshold}|${redThreshold}|${colorMode}|${greyAlphaMax}|${idleColor.join(',')}`;
  let workerFrame = null;
  let workerEntry = null;
  if (useWorker && timeseriesBuffer) {
    workerEntry = WorkerCache.getOrCreate({
      layerId: id,
      kind: 'transmissionLayer',
      geomSig: `${joinKey}|${capacityProperty}|${n}`,
      styleSig,
      geom: { entityIds, capacities, joinKey },
      style: {
        neutralColor, idleColor, dimAlpha, brightAlpha,
        orangeThreshold, redThreshold, colorMode, greyAlphaMax,
      },
      tsBuf: timeseriesBuffer,
      onUpdate: onWorkerUpdate,
    });
    workerFrame = WorkerCache.getFrame(
      workerEntry,
      timeseriesBuffer.currentDate,
      timeseriesBuffer.currentRow,
    );
  }

  // Per-tick CPU work falls into two paths:
  //   • Worker fast path — bind the precomputed Float32 buffers as binary
  //     attributes on PathLayer's `data:{length, startIndices, attributes}`
  //     form. PathLayer expands per-feature values to per-segment
  //     internally, so this works for multi-point LineStrings and avoids
  //     the per-feature accessor dispatch. Only the per-feature
  //     `properties.flow` / `loading_pct` slots are updated for picking.
  //   • Slow path — original inline math with allocation-free mutation of
  //     the cached path objects' RGBA arrays.
  const tickKey = `${tsVersion}|${styleSig}|${workerFrame ? 'w' : 'm'}`;
  const usePiecewise = colorMode === 'piecewise' || !(colorMode in COLORMAPS);

  if (workerFrame) {
    // Worker fast path. Memcpy the pre-computed RGBA + width into the
    // cached path object slots, plus picking properties. deck.gl walks
    // these via function accessors as on the slow path — same render
    // shape, same correctness; only the per-(timestep × feature) math
    // moved off-thread.
    const { dimColors: wDim, brightColors: wBri, widths: wW, flows: wFlows, loadings: wLoadings } = workerFrame;
    for (let i = 0; i < n; i++) {
      const p = paths[i];
      const j = i * 4;
      const dim = p.dimColor;
      const bri = p.brightColor;
      dim[0] = wDim[j];   dim[1] = wDim[j+1];   dim[2] = wDim[j+2];   dim[3] = wDim[j+3];
      bri[0] = wBri[j];   bri[1] = wBri[j+1];   bri[2] = wBri[j+2];   bri[3] = wBri[j+3];
      p.width = wW[i];
      const flow = wFlows[i];
      p.properties.flow        = Math.round(flow * 100) / 100;
      p.properties.loading_pct = Math.round(wLoadings[i] * 1000) / 10;
    }
  } else for (let i = 0; i < n; i++) { // eslint-disable-line
    const p = paths[i];
    const capacity = capacities[i];
    let flow = 0;
    if (dataIndex) {
      const entry = dataIndex.get(entityIds[i]);
      if (entry != null) {
        flow = typeof entry === 'number'
          ? entry
          : (entry[flowColumn] ?? entry['flow'] ?? 0);
      }
    }
    const absFlow = flow < 0 ? -flow : flow;
    const dim = p.dimColor;
    const bri = p.brightColor;

    if (absFlow < 1e-6 || capacity <= 0) {
      dim[0] = bri[0] = neutralColor[0];
      dim[1] = bri[1] = neutralColor[1];
      dim[2] = bri[2] = neutralColor[2];
      dim[3] = bri[3] = neutralColor[3];
      p.width = 0.5;
      p.properties.flow = 0;
      p.properties.loading_pct = 0;
      continue;
    }

    const loading = absFlow / capacity;
    let alphaFactor;
    if (loading >= orangeThreshold) {
      alphaFactor = 1.0;
    } else {
      const t = orangeThreshold > 0 ? loading / orangeThreshold : 1.0;
      alphaFactor = MIN_GREY_ALPHA_RATIO + (greyAlphaMax - MIN_GREY_ALPHA_RATIO) * t;
    }

    let rgb;
    if (usePiecewise) {
      rgb = piecewiseColor(loading, orangeThreshold, redThreshold, idleColor);
    } else {
      rgb = sampleColormap(colorMode, loading > 1 ? 1 : loading);
    }

    const dimA    = (dimAlpha * alphaFactor + 0.5) | 0;
    const brightA = (brightAlpha * alphaFactor + 0.5) | 0;
    const r = rgb[0], g = rgb[1], b = rgb[2];

    if (flow > 0) {
      dim[0] = r; dim[1] = g; dim[2] = b; dim[3] = dimA;
      bri[0] = r; bri[1] = g; bri[2] = b; bri[3] = brightA;
    } else {
      dim[0] = r; dim[1] = g; dim[2] = b; dim[3] = brightA;
      bri[0] = r; bri[1] = g; bri[2] = b; bri[3] = dimA;
    }

    p.width = Math.sqrt(absFlow) * 0.3;
    p.properties.flow        = Math.round(flow * 100) / 100;
    p.properties.loading_pct = Math.round(loading * 1000) / 10;
  }

  // Category filter setup
  const filterActive = filterProperty && filterCategories && filterCategories.length > 0;
  const filterSet = filterActive ? new Set(filterCategories.map(String)) : null;

  // ─── Phase 3 GPU-resident timeseries path ────────────────────────────
  // When the worker has packed style data ready, render with a custom
  // PathLayer subclass that samples the data from a partition-resident
  // texture in the vertex shader. Per-tick CPU is then a single uniform
  // write; per-feature accessor dispatch and per-tick attribute upload
  // both go to zero. This is the only path that scales sublinearly to
  // CONUS-class systems.
  // The GPU-texture path indexes the styles texture via a per-SEGMENT
  // `instanceFeatureIndex`, but supplies it through the per-PATH accessor
  // `getFeatureIndex: d => d._idx`. deck.gl does not expand that custom
  // attribute across a path's segments (unlike built-in getColor/getWidth), so
  // on multi-vertex real paths every segment reads feature 0's column → grey /
  // synchronized flashes / no per-line variation. Until the GPU layer feeds the
  // pre-built per-segment `featureIndices` buffer, fall back to the Web Worker
  // path (which uses expandable color accessors and renders correctly) whenever
  // any feature has more than one segment.
  const gpuSegmentsAligned = totalSegments === n;
  if (useGpuTexture && !gpuSegmentsAligned && !_gpuMultiVertexWarned.has(id)) {
    _gpuMultiVertexWarned.add(id);
    console.warn(
      `[TransmissionLayer] GPU-texture path disabled for '${id}': multi-vertex ` +
      `paths (${totalSegments} segments / ${n} features) don't align with its ` +
      `per-segment feature index; using the Web Worker path instead.`,
    );
  }
  if (useGpuTexture && gpuSegmentsAligned && workerFrame?.stylesPacked && workerFrame.numSteps > 0) {
    // PathLayer auto-expands per-feature accessor results across each
    // path's segments — `getFeatureIndex: d => d._idx` returns the
    // pre-computed index 0..n-1 we stored in the static cache.
    const dimRGBA01 = [
      (neutralColor[0] ?? 128) / 255,
      (neutralColor[1] ?? 128) / 255,
      (neutralColor[2] ?? 128) / 255,
      (neutralColor[3] ?? 100) / 255,
    ];
    // Alpha gradient endpoints — match legacy Phase 2 path's per-feature
    // baked dim/bright alphas, but applied shader-side instead of CPU-side.
    const alphaRange01 = [dimAlpha / 255, brightAlpha / 255];
    // For continuous colormaps the threshold/unstressed-alpha knobs don't
    // apply (the colormap defines colors directly across the full range).
    // We force orangeThreshold≈0 and greyAlphaMax=1 so any active line
    // (loading > 0) saturates alphaFactor to 1, letting the colormap drive
    // the visual outright. The piecewise path still uses user thresholds.
    const isPiecewise = colorMode === 'piecewise' || !(colorMode in COLORMAPS);
    const effectiveOrangeThreshold = isPiecewise ? orangeThreshold : 1e-6;
    const effectiveGreyAlphaMax = isPiecewise ? greyAlphaMax : 1.0;
    return new GpuTransmissionLayer({
      id,
      data: paths,
      getPath: d => d.path,
      // Static index attribute. PathLayer's auto-updater calls this for each
      // path object, then replicates the value across all of that path's
      // segments using the path tesselator's startIndices. (Binary `{value,
      // size}` form fails the auto-updater's `accessor must be function`
      // assert in deck.gl 9, so we have to use a function accessor.)
      getFeatureIndex: d => d._idx,
      // Default getColor as fallback if shader injection isn't reached
      // (e.g. before texture binds on first frame).
      getColor: [0, 0, 0, 0],
      // Width is read from the styles texture inside the shader; the
      // accessor is unused at runtime but PathLayer requires a value.
      getWidth: 1,
      widthScale,
      widthMinPixels,
      widthMaxPixels,
      widthUnits,
      opacity,
      pickable,
      autoHighlight: true,
      jointRounded: true,
      capRounded: true,
      // Phase 3 props consumed by the subclass.
      stylesTexData: workerFrame.stylesPacked,
      numFeatures:   n,
      numSteps:      workerFrame.numSteps,
      currentIndex:  workerFrame.step ?? 0,
      // Cross-step easing — replaces deck.gl's accessor-based attribute
      // transitions which don't apply to texture-driven layers.
      transitionDuration,
      dimColorRGBA:  dimRGBA01,
      alphaRange:    alphaRange01,
      orangeThreshold: effectiveOrangeThreshold,
      redThreshold,
      colorMode,
      idleColor,
      greyAlphaMax:    effectiveGreyAlphaMax,
      minGreyAlpha:    isPiecewise ? MIN_GREY_ALPHA_RATIO : 1.0,
      // Picking gets the path object via the static data array — no
      // index-adapter shim needed since `data: paths` matches the legacy
      // shape exactly. info.object resolves naturally.
      ...(onHover && { onHover }),
      ...(onClick && { onClick }),
      // Filter via DataFilterExtension. Function accessor still works
      // because data is a real array.
      extensions: [new DataFilterExtension({ filterSize: 1 })],
      getFilterValue: filterActive
        ? d => (filterSet.has(String(d.properties?.[filterProperty] ?? '')) ? 1 : 0)
        : () => 1,
      filterRange: [1, 1],
      filterEnabled: true,
      updateTriggers: {
        // currentIndex is a prop, not an attribute, so a tickKey trigger
        // isn't needed; deck.gl picks up scalar prop changes directly.
        getFilterValue: [filterProperty, (filterCategories || []).join(',')],
      },
      parameters: { depthTest: false },
    });
  }

  const baseProps = {
    id,
    widthScale,
    widthMinPixels,
    widthMaxPixels,
    widthUnits: 'pixels',
    opacity,
    pickable,
    autoHighlight: true,
    jointRounded: true,
    capRounded: true,
    extensions: [new DirectionalLoadingExtension(), new DataFilterExtension({ filterSize: 1 })],
    filterRange: [1, 1],
    filterEnabled: true,
    transitions: transitionDuration > 0 ? {
      getColor:       { duration: transitionDuration, type: 'interpolation' },
      getDimColor:    { duration: transitionDuration, type: 'interpolation' },
      getBrightColor: { duration: transitionDuration, type: 'interpolation' },
      getWidth:       { duration: transitionDuration, type: 'interpolation' },
    } : undefined,
    updateTriggers: {
      getColor:       tickKey,
      getDimColor:    tickKey,
      getBrightColor: tickKey,
      getWidth:       tickKey,
      getFilterValue: [filterProperty, (filterCategories || []).join(',')],
    },
    parameters: { depthTest: false },
  };

  return new PathLayer({
    ...baseProps,
    data: paths,
    getPath: d => d.path,
    getColor: d => d.dimColor,  // fallback; overridden by DirectionalLoadingExtension
    getDimColor: d => d.dimColor,
    getBrightColor: d => d.brightColor,
    getWidth: d => d.width ?? 1,
    getFilterValue: filterActive
      ? d => (filterSet.has(String(d.properties?.[filterProperty] ?? '')) ? 1 : 0)
      : () => 1,
    ...(onHover && { onHover }),
    ...(onClick && { onClick }),
  });
}

export { sampleLoadingColor, DEFAULT_LOADING_RAMP, DEFAULT_LOADING_DOMAIN };
export default createTransmissionLayer;
