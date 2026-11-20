/**
 * GeneratorLayer
 *
 * A domain-specific ScatterplotLayer for power system generators. Each point
 * has an inner radius (generation MW) and an outer radius (capacity/availability MW).
 *
 * Three rendering modes controlled by generationVisible + capacityVisible:
 *   - Both:            inner filled circle (tech color) + outer ring (tech color, reduced alpha)
 *   - Generation only: filled circle at generation radius, tech color
 *   - Capacity only:   filled circle at capacity radius, tech color
 *
 * Uses a shader extension (DualRadiusExtension) that passes an inner/outer
 * ratio to the fragment shader. The ScatterplotLayer quad is always sized to
 * the outer (max) radius. The fragment shader uses distance-from-center to
 * decide between fill color (inner zone) and ring color (outer zone).
 *
 * Zero geometry duplication — one point per generator, one draw call.
 */

import { ScatterplotLayer, LayerExtension } from 'deck.gl';
import { DataFilterExtension } from '@deck.gl/extensions';
import * as WorkerCache from './workers/LayerWorkerCache.js';
import { GpuGeneratorLayer } from './shaders/GeneratorStylesExtension.js';

// ─── Static-geometry cache ──────────────────────────────────────────────────
// Per-feature position + entityId + static-property capacity are invariant
// across clock ticks. Cache by (geoData, joinKey, capacityProperty) so the
// per-tick loop only mutates fields rather than rebuilding N objects.
//
// fillColor/ringColor are pre-allocated as 4-element mutable arrays here
// (rather than aliasing a shared TRANSPARENT_RGBA constant) so the per-tick
// loop can mutate them in place. Eliminates the both-mode per-tick array
// allocation that used to allocate fresh ringColor on every feature, every
// tick (the old `d.ringColor = [...]` assignment on line 270).
const STATIC_CACHE = new WeakMap();

function getStaticGeneratorData(geoData, joinKey, capacityProperty) {
  let entry = STATIC_CACHE.get(geoData);
  if (entry && entry.joinKey === joinKey && entry.capacityProperty === capacityProperty) {
    return entry;
  }
  const features = geoData?.features ?? geoData ?? [];
  const data = [];
  for (const feature of features) {
    const coords = feature.geometry?.coordinates;
    if (!coords) continue;
    let staticCap = -1;
    if (capacityProperty) {
      const v = parseFloat(feature.properties?.[capacityProperty]);
      if (!isNaN(v) && v > 0) staticCap = v;
    }
    data.push({
      position: coords,
      properties: feature.properties,
      geometry: feature.geometry,
      feature,
      _entityId: String(feature.properties?.[joinKey] ?? ''),
      _idx: 0,                                // assigned post-sort below
      _staticCap: staticCap,                  // -1 sentinel = use dynamic capacityIndex
      // Mutated per tick (zero allocations):
      radius: 0,
      innerRatio: 1,
      ringPixels: 0,
      fillColor: [0, 0, 0, 0],
      ringColor: [0, 0, 0, 0],
    });
  }
  // Sort by static capacity (typically nameplate) so smaller-capacity dots
  // paint on top of larger ones at the same location. Stable across ticks
  // since static capacity doesn't change.
  data.sort((a, b) => b._staticCap - a._staticCap);
  // Single post-sort pass: assign _idx and build parallel arrays for the
  // worker (entityIds + capacities). _idx must match the row order in the
  // texture (instanceFeatureIndex on the GPU path indexes by it).
  const n = data.length;
  const entityIds = new Array(n);
  const capacities = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = data[i];
    d._idx = i;
    entityIds[i] = d._entityId;
    capacities[i] = d._staticCap > 0 ? d._staticCap : 0;
  }
  entry = { data, n, entityIds, capacities, joinKey, capacityProperty };
  STATIC_CACHE.set(geoData, entry);
  return entry;
}

// Build per-feature static tech colors (Uint8Array, n*4) by calling the
// caller-supplied colorResolver once per feature. Computed per render rather
// than cached because colorResolver closes over the current catmap/style
// state — its result can change without geoData changing. Cheap (one
// function call per feature; 5–10K features is sub-ms).
const DEFAULT_TECH_COLOR = [100, 149, 237, 220];
function buildStaticTechColors(data, colorResolver) {
  const n = data.length;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = (colorResolver ? colorResolver(data[i].feature) : null) ?? DEFAULT_TECH_COLOR;
    out[i * 4]     = c[0] | 0;
    out[i * 4 + 1] = c[1] | 0;
    out[i * 4 + 2] = c[2] | 0;
    out[i * 4 + 3] = (c[3] ?? 255) | 0;
  }
  return out;
}

// Per-feature flag for "curtailment is physically meaningful here". Backend
// stamps `properties.curtailable: true|false` per feature (e.g. GAT marks
// VRE only). When the property is missing we default to *true* so other
// extensions that don't yet emit the flag keep showing curtailment as
// before. Returned as Uint8Array(n) — 1 = curtailable, 0 = not.
function buildStaticCurtailable(data) {
  const n = data.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = data[i].properties;
    out[i] = (p && p.curtailable === false) ? 0 : 1;
  }
  return out;
}

// 32-bit FNV-1a-style hash of the tech-color bytes. Used as part of the
// worker geomSig — when catmap settings change the colors, the hash flips
// and the cache re-INITs the worker so subsequent partition computes pick
// up the new colors.
function hashBytes(bytes) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

// ─── Dual-radius shader extension ──────────────────────────────────────────
//
// Adds instanceInnerRatio (float, 0–1): the fraction of the total radius
// occupied by the inner (generation) circle. Also adds instanceRingColors.
//
// getRadius on the ScatterplotLayer is set to the OUTER (max) radius.
// The extension's fragment shader then splits the circle into two zones:
//   - dist <= innerRatio * outerRadius → fill color (generation)
//   - dist >  innerRatio * outerRadius → ring color (capacity)

class DualRadiusExtension extends LayerExtension {
  getShaders() {
    return {
      inject: {
        'vs:#decl': `
          in float instanceInnerRatio;
          in float instanceRingPixels;
          in vec4 instanceRingColors;
          out float vInnerRatio;
          out float vRingThickness;
          out vec4 vRingColor;
        `,
        'vs:#main-end': `
          vInnerRatio = instanceInnerRatio;
          // Convert ring stroke width (pixels) to normalized [0,1] of the outer
          // radius. outerRadiusPixels was set by the base scatterplot VS above.
          vRingThickness = outerRadiusPixels > 0.0
            ? clamp(instanceRingPixels / outerRadiusPixels, 0.0, 1.0)
            : 0.0;
          // instanceRingColors is float32 (0-255 range); normalize to 0-1 for
          // GLSL color math (matches the base layer's pre-normalized vFillColor).
          vRingColor = vec4(instanceRingColors.rgb / 255.0, (instanceRingColors.a / 255.0) * layer.opacity);
        `,
        'fs:#decl': `
          in float vInnerRatio;
          in float vRingThickness;
          in vec4 vRingColor;
        `,
        // Three-zone rendering inside the (max-radius) circle:
        //   Inner fill    : 0 .. innerRatio        → keep base fill color
        //   Gap           : innerRatio .. ringEdge → transparent (curtailment / unused capacity)
        //   Ring outline  : ringEdge .. 1.0        → ring color (line stroke at capacity edge)
        // Skipped entirely when ring thickness is 0 (single-circle modes).
        'fs:DECKGL_FILTER_COLOR': `
          if (vRingThickness > 0.0) {
            float normDist = length(geometry.uv);
            float clampedDist = min(normDist, 1.0);
            float ringInnerEdge = max(vInnerRatio, 1.0 - vRingThickness);
            float aaPad = 0.005;

            if (clampedDist <= vInnerRatio + aaPad) {
              // Inner zone — leave fill color untouched
            } else if (clampedDist >= ringInnerEdge - aaPad) {
              // Ring outline zone: paint ring color, antialias outer perimeter
              color.rgb = vRingColor.rgb;
              float outerEdge = 1.0 - smoothstep(0.99, 1.01, normDist);
              color.a = vRingColor.a * outerEdge;
            } else {
              // Gap zone: transparent (no fill, just the ring will be visible)
              color.a = 0.0;
            }
          }
        `,
      },
    };
  }

  initializeState() {
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      attributeManager.addInstanced({
        instanceInnerRatio: {
          size: 1,
          type: 'float32',
          accessor: 'getInnerRatio',
          transition: true,
        },
        instanceRingPixels: {
          size: 1,
          type: 'float32',
          accessor: 'getRingPixels',
          transition: true,
        },
        instanceRingColors: {
          size: 4,
          type: 'float32',
          accessor: 'getRingColor',
          transition: true,
        },
      });
    }
  }
}

DualRadiusExtension.extensionName = 'DualRadiusExtension';
DualRadiusExtension.defaultProps = {
  getInnerRatio: { type: 'accessor', value: 1.0 },
  getRingPixels: { type: 'accessor', value: 0 },
  getRingColor: { type: 'accessor', value: [200, 200, 200, 220] },
};


// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create a GeneratorLayer for power system generators.
 *
 * @param {object} opts
 * @param {string} opts.id - deck.gl layer id
 * @param {object} opts.geoData - GeoJSON FeatureCollection
 * @param {Map<string,number>|null} opts.generationIndex - entityId → generation MW
 * @param {Map<string,number>|null} opts.capacityIndex - entityId → capacity/availability MW
 * @param {string} opts.joinKey - GeoJSON property to join on
 * @param {function} opts.colorResolver - (feature) => [r,g,b,a] tech color
 * @param {boolean} opts.generationVisible - show generation inner circle
 * @param {boolean} opts.capacityVisible - show capacity outer ring/circle
 * @param {number} opts.radiusScale - multiplier applied to MW values
 * @param {number} opts.radiusMinPixels
 * @param {number} opts.radiusMaxPixels
 * @param {string} opts.radiusUnits
 * @param {number} opts.ringAlpha - alpha for the capacity ring (0-255)
 * @param {number} opts.opacity
 * @param {number} opts.transitionDuration
 * @param {function|null} opts.onHover
 * @param {function|null} opts.onClick
 * @param {string|null} opts.filterProperty
 * @param {string[]|null} opts.filterCategories
 */
export function createGeneratorLayer({
  id = 'generator-layer',
  geoData,
  generationIndex,
  capacityIndex,
  capacityProperty = null,   // GeoJSON property name for static capacity (e.g. 'nameplate_mw')
  joinKey = 'name',
  colorResolver = null,
  generationVisible = true,
  capacityVisible = true,
  curtailmentVisible = false,
  radiusScale = 1,
  radiusMinPixels = 0,
  radiusMaxPixels = 100,
  radiusUnits = 'meters',
  // Capacity ring outline (only drawn in "both" mode)
  staticLineWidth = 2,         // base ring stroke width in pixels
  lineWidthScale = 1,          // user-controllable multiplier from layer tray
  lineWidthMinPixels = 1,
  lineWidthMaxPixels = 10,
  ringAlpha = 220,             // opaque by default (gap is transparent, so ring must stand out)
  opacity = 0.8,
  transitionDuration = 0,
  onHover = null,
  onClick = null,
  filterProperty = null,
  filterCategories = null,
  pickable = true,
  tsVersion = 0,
  // Phase 2: optional Web Worker precompute path. When `useWorker` is true
  // and `timeseriesBuffer` is provided, per-(timestep × feature) buffers
  // are computed in a worker once per partition load. Per-tick CPU on the
  // main thread becomes a memcpy from the worker buffer into the cached
  // `data[i]` slots; deck.gl reads via the same function accessors as on
  // the inline path.
  useWorker = false,
  timeseriesBuffer = null,
  // Optional second timeseries buffer for the renewable layer's
  // availability dataset. When supplied (and useWorker is on), the
  // worker pairs per-date partitions from both buffers and writes
  // per-timestep availability into the styles texture's cap channel —
  // making the curtailment band reflect real dispatch curtailment
  // (avail − gen) for VRE features instead of "nameplate − gen".
  availabilityBuffer = null,
  onWorkerUpdate = null,
  // Phase 3: GPU-texture timeseries path. When `useGpuTexture` is true (in
  // addition to `useWorker`), the worker's whole-partition packed style
  // buffer is uploaded as an rgba32float texture and indexed into by
  // `instanceFeatureIndex` + `currentIndex` uniform from the vertex shader.
  // Per-tick CPU becomes a single uniform write — flat with N. Falls back
  // to the Phase 2 path if texture creation fails or the worker frame
  // isn't ready yet.
  useGpuTexture = false,
} = {}) {
  const features = geoData?.features ?? geoData ?? [];
  if (!features.length) return null;

  const filterActive = filterProperty && filterCategories?.length > 0;
  const filterSet = filterActive ? new Set(filterCategories) : null;

  // Effective ring stroke width in pixels (clamped). Only used in "both" mode.
  const ringPixelsBoth = Math.max(
    lineWidthMinPixels,
    Math.min(lineWidthMaxPixels, staticLineWidth * lineWidthScale)
  );

  // Static cache: per-feature geometry + entityId + static-property capacity.
  // These never change across clock ticks — caching them eliminates the bulk
  // of per-tick allocation. Keyed on (geoData identity, joinKey, capacityProperty)
  // to invalidate when the user reloads geometry or remaps capacity.
  const staticData = getStaticGeneratorData(geoData, joinKey, capacityProperty);
  if (!staticData.n) return null;
  const { data, n, entityIds, capacities } = staticData;

  // Per-feature static tech colors. Recomputed each render because
  // colorResolver closes over the current catmap/style state. Used by the
  // worker (passed at INIT) and by the GPU path (instanceTechColor binary
  // attribute).
  const staticTechColors = buildStaticTechColors(data, colorResolver);
  const colorHash = hashBytes(staticTechColors);
  // Per-feature gate for the curtailment band — VRE-only in GAT, but the
  // factory accepts the flag from any backend that stamps it.
  const staticCurtailable = buildStaticCurtailable(data);

  // Optionally pull a precomputed frame from the worker cache. If we get one,
  // the per-tick CPU loop becomes a small memcpy pass; deck.gl receives the
  // colors / radii via function accessors as on the inline path.
  const styleSig = `${generationVisible ? 1 : 0}|${capacityVisible ? 1 : 0}|${curtailmentVisible ? 1 : 0}|${radiusScale}|${ringPixelsBoth}|${ringAlpha}`;
  let workerFrame = null;
  let workerEntry = null;
  if (useWorker && timeseriesBuffer) {
    workerEntry = WorkerCache.getOrCreate({
      layerId: id,
      kind: 'generatorLayer',
      // Include colorHash so catmap changes re-INIT the worker (which
      // rebakes fillColors/ringColors with the new tech palette).
      geomSig: `${joinKey}|${capacityProperty}|${n}|${colorHash}`,
      styleSig,
      geom: { entityIds, capacities, staticTechColors, staticCurtailable, joinKey },
      style: {
        generationVisible, capacityVisible, curtailmentVisible,
        radiusScale, ringPixelsBoth, ringAlpha,
      },
      // Multi-role buffers — primary = generation MW (required), and
      // availability when present (drives time-varying cap channel).
      tsBufs: {
        primary: timeseriesBuffer,
        ...(availabilityBuffer ? { availability: availabilityBuffer } : {}),
      },
      onUpdate: onWorkerUpdate,
    });
    workerFrame = WorkerCache.getFrame(
      workerEntry,
      timeseriesBuffer.currentDate,
      timeseriesBuffer.currentRow,
    );
  }

  if (workerFrame && workerFrame.radii) {
    // Phase 2 fast path. Memcpy the worker's pre-computed RGBA + scalar
    // values into the cached data slots. deck.gl walks these via function
    // accessors as on the slow path — same render shape, same correctness;
    // only the per-(timestep × feature) math moved off-thread.
    const { radii: wR, innerRatios: wIR, ringPixels: wRP, fillColors: wFC, ringColors: wRC,
            gens: wGen, caps: wCap } = workerFrame;
    for (let i = 0; i < n; i++) {
      const d = data[i];
      const j4 = i * 4;
      d.radius     = wR[i];
      d.innerRatio = wIR[i];
      d.ringPixels = wRP[i];
      const fc = d.fillColor;
      fc[0] = wFC[j4]; fc[1] = wFC[j4+1]; fc[2] = wFC[j4+2]; fc[3] = wFC[j4+3];
      const rc = d.ringColor;
      rc[0] = wRC[j4]; rc[1] = wRC[j4+1]; rc[2] = wRC[j4+2]; rc[3] = wRC[j4+3];
      // Picking-popup data: bake current gen/cap into properties so the
      // hover card shows the live numbers.
      if (wGen) d.properties.generation_mw = Math.round(wGen[i] * 100) / 100;
      if (wCap) d.properties.capacity_mw   = Math.round(wCap[i] * 100) / 100;
    }
  } else for (let i = 0; i < n; i++) { // eslint-disable-line
    // Slow path — original inline math. Mutates pre-allocated fillColor /
    // ringColor arrays in place (no per-tick allocation, even in both-mode).
    const d = data[i];
    const genMW = generationIndex?.get(d._entityId) ?? 0;
    // Time-varying availability (when supplied) wins over the static
    // nameplate property. The previous order — static first, dynamic
    // only as a fallback when no `capacityProperty` is set — silently
    // disabled real curtailment for VRE: solar nameplate stays at 100 MW
    // at night, so curt = nameplate − 0 = nameplate. Dynamic-first means
    // night-time avail = 0 → curt = 0 (correct).
    const dynCap = capacityIndex?.get(d._entityId);
    let capMW;
    if (dynCap != null) {
      capMW = dynCap;
    } else if (d._staticCap >= 0) {
      capMW = d._staticCap;
    } else {
      capMW = genMW;
    }
    const tcR = staticTechColors[i * 4];
    const tcG = staticTechColors[i * 4 + 1];
    const tcB = staticTechColors[i * 4 + 2];
    const tcA = staticTechColors[i * 4 + 3];
    const fc = d.fillColor;
    const rc = d.ringColor;

    // Curt-mode model (mirrors worker bake): when curtailment is on AND
    // this feature is curtailable (VRE), draw a grey disc sized by
    // `max(0, capMW − genMW)`. Non-curtailable features (thermal) keep
    // their normal G/C rendering — curtailment toggle is a no-op for
    // them.
    const CURT_GREY_R = 128, CURT_GREY_G = 128, CURT_GREY_B = 128, CURT_GREY_A = 153; // 0.6α
    const curtMW = capMW > genMW ? capMW - genMW : 0;
    const curtMode = curtailmentVisible && staticCurtailable[i];

    if (curtMode) {
      d.radius     = curtMW * radiusScale;
      d.innerRatio = 1.0;
      d.ringPixels = 0;
      fc[0] = CURT_GREY_R; fc[1] = CURT_GREY_G; fc[2] = CURT_GREY_B; fc[3] = CURT_GREY_A;
      rc[0] = 0; rc[1] = 0; rc[2] = 0; rc[3] = 0;
    } else if (generationVisible && capacityVisible) {
      const outerMW = genMW > capMW ? genMW : capMW;
      d.radius     = outerMW * radiusScale;
      d.innerRatio = outerMW > 0 ? genMW / outerMW : 1.0;
      d.ringPixels = ringPixelsBoth;
      fc[0] = tcR; fc[1] = tcG; fc[2] = tcB; fc[3] = tcA;
      rc[0] = tcR; rc[1] = tcG; rc[2] = tcB; rc[3] = ringAlpha;
    } else if (generationVisible) {
      d.radius     = genMW * radiusScale;
      d.innerRatio = 1.0;
      d.ringPixels = 0;
      fc[0] = tcR; fc[1] = tcG; fc[2] = tcB; fc[3] = tcA;
      rc[0] = 0; rc[1] = 0; rc[2] = 0; rc[3] = 0;
    } else if (capacityVisible) {
      d.radius     = capMW * radiusScale;
      d.innerRatio = 1.0;
      d.ringPixels = 0;
      fc[0] = tcR; fc[1] = tcG; fc[2] = tcB; fc[3] = tcA;
      rc[0] = 0; rc[1] = 0; rc[2] = 0; rc[3] = 0;
    } else {
      d.radius     = 0;
      d.innerRatio = 1.0;
      d.ringPixels = 0;
      fc[0] = 0; fc[1] = 0; fc[2] = 0; fc[3] = 0;
      rc[0] = 0; rc[1] = 0; rc[2] = 0; rc[3] = 0;
    }
  }

  // updateTrigger key: tsVersion bumps per tick; visibility/scale/alpha changes
  // are baked into the same string so deck.gl re-walks when those change too.
  // Append 'w' or 'm' so the trigger flips when the worker frame becomes
  // available (or stops being available) — without this, deck.gl could keep
  // reading stale slow-path mutations after the worker arrived for the first
  // time on a tick where tsVersion hadn't changed.
  const tickKey = `${tsVersion}|${generationVisible ? 1 : 0}|${capacityVisible ? 1 : 0}|${curtailmentVisible ? 1 : 0}|${radiusScale}|${ringAlpha}|${ringPixelsBoth}|${workerFrame ? 'w' : 'm'}`;

  // ─── Phase 3 GPU-resident timeseries path ────────────────────────────
  // When the worker has packed style data ready, render with a custom
  // ScatterplotLayer subclass that samples per-feature genMW/capMW from a
  // partition-resident texture in the vertex shader. Per-tick CPU is then
  // a single uniform write — flat with N. Style changes (visibility,
  // ringAlpha, ringPixelsBoth) update via uniforms with no worker
  // recompute.
  if (useGpuTexture && workerFrame?.stylesPacked && workerFrame.numSteps > 0) {
    try {
      return _buildGpuGeneratorLayer();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[GeneratorLayer] GpuGeneratorLayer construction failed; falling back to legacy ScatterplotLayer:', err);
      // fall through to the legacy ScatterplotLayer return below
    }
  }

  // Hoisted for try/catch above. Closes over all the locals.
  function _buildGpuGeneratorLayer() {
    return new GpuGeneratorLayer({
      id,
      data,
      getPosition: d => d.position,
      // Static index attribute. ScatterplotLayer's auto-updater calls this
      // for each feature; we just need the post-sort row index we baked
      // into the static cache as `_idx`.
      getFeatureIndex: d => d._idx,
      // Per-feature static tech color, passed as a binary-via-accessor so
      // catmap changes are picked up via updateTriggers.
      getTechColor: (_, { index }) => {
        const j = index * 4;
        return [staticTechColors[j], staticTechColors[j+1], staticTechColors[j+2], staticTechColors[j+3]];
      },
      // Per-feature curtailable flag (VRE-only in GAT). The shader reads
      // this and zeros out the curtailment band for non-curtailable
      // features, so the layer can host both VRE and non-VRE entities
      // without painting fake "wasted nameplate" rings on thermals.
      getCurtailable: (_, { index }) => staticCurtailable[index],
      // Pin instanceRadius = 1 across all features. The per-feature radius
      // is driven entirely by the shader (vs:#main-start computes a desired
      // pixel size from outerMW × radiusScale + clamp, divides by the
      // default, and stores the ratio in _gpuRadiusScale; DECKGL_FILTER_SIZE
      // multiplies offset by it). Pinning here avoids the earlier bug where
      // staticCap fallbacks (1 for features without a capacity property)
      // collided with ScatterplotLayer's clamp pipeline and produced
      // grossly oversized dots.
      getRadius: 1,
      getFillColor: [0, 0, 0, 0],   // ignored; FS overwrites with techColor + alpha math
      getLineColor: [0, 0, 0, 0],
      radiusScale,
      radiusMinPixels,
      radiusMaxPixels,
      radiusUnits,
      opacity,
      filled: true,
      stroked: false,
      pickable,
      autoHighlight: false,
      antialiasing: true,
      // Phase 3 props consumed by GpuGeneratorLayer.
      stylesTexData:    workerFrame.stylesPacked,
      numFeatures:      n,
      numSteps:         workerFrame.numSteps,
      currentIndex:     workerFrame.step ?? 0,
      transitionDuration,
      generationVisible,
      capacityVisible,
      curtailmentVisible,
      ringPixelsBoth,
      ringAlphaUniform: ringAlpha / 255,
      // Filter via DataFilterExtension. Function accessor still works
      // because data is a real array.
      extensions: [new DataFilterExtension({ filterSize: 1 })],
      getFilterValue: filterActive
        ? d => (filterSet.has(String(d.properties?.[filterProperty] ?? '')) ? 1 : 0)
        : () => 1,
      filterRange: [1, 1],
      filterEnabled: true,
      updateTriggers: {
        // currentIndex is a prop, not an attribute — deck.gl picks up scalar
        // prop changes directly. getTechColor changes when the catmap-derived
        // staticTechColors hash flips.
        getTechColor:   colorHash,
        getFilterValue: [filterProperty, filterCategories],
      },
      ...(onHover && { onHover }),
      ...(onClick && { onClick }),
      parameters: { depthTest: false },
    });
  }

  return new ScatterplotLayer({
    id,
    data,
    getPosition: d => d.position,
    getRadius: d => d.radius,
    getInnerRatio: d => d.innerRatio,
    getRingPixels: d => d.ringPixels,
    getFillColor: d => d.fillColor,
    getRingColor: d => d.ringColor,
    getLineColor: [0, 0, 0, 0],

    radiusScale: 1, // already baked into d.radius
    radiusMinPixels,
    radiusMaxPixels,
    radiusUnits,
    opacity,
    filled: true,
    stroked: false,
    pickable,
    autoHighlight: false,
    antialiasing: true,

    extensions: [
      new DualRadiusExtension(),
      new DataFilterExtension({ filterSize: 1 }),
    ],

    getFilterValue: filterActive
      ? d => (filterSet.has(String(d.properties?.[filterProperty] ?? '')) ? 1 : 0)
      : () => 1,
    filterRange: [1, 1],
    filterEnabled: true,

    updateTriggers: {
      // tickKey changes each call (via tsVersion + visibility/scale signals),
      // so deck.gl re-walks accessors and reads the freshly mutated d.* fields.
      getRadius:     tickKey,
      getInnerRatio: tickKey,
      getRingPixels: tickKey,
      getFillColor:  tickKey,
      getRingColor:  tickKey,
      getFilterValue: [filterProperty, filterCategories],
    },

    transitions: {
      getRadius: { duration: transitionDuration, type: 'interpolation' },
      getInnerRatio: { duration: transitionDuration, type: 'interpolation' },
      getRingPixels: { duration: transitionDuration, type: 'interpolation' },
      getFillColor: { duration: transitionDuration, type: 'interpolation' },
      getRingColor: { duration: transitionDuration, type: 'interpolation' },
    },

    ...(onHover && { onHover }),
    ...(onClick && { onClick }),
    parameters: { depthTest: false },
  });
}
