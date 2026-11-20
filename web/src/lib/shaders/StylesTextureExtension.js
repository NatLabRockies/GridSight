/**
 * StylesTextureExtension / GpuTransmissionLayer — Phase 3 GPU-resident
 * timeseries path for transmission lines.
 *
 * Architecture:
 *   - Static per-instance attribute `instanceFeatureIndex`: float, 0..n-1.
 *     Built once per geometry; never updated.
 *   - 2D texture `stylesTex` (n × numSteps, rgba32float). Cell (i, t) =
 *     [loading, direction, width, alphaFactor] for feature i at step t.
 *     Uploaded once per partition load from the worker's stylesPacked
 *     Float32Array.
 *   - Uniform `currentIndex`: float, the current global step within the
 *     active partition. Bumped per tick — single uniform write, the only
 *     per-tick CPU cost.
 *   - VS samples `stylesTex` via texelFetch(featureIndex, currentIndex)
 *     and outputs varyings (vLoading, vDirection, vWidth, vAlphaFactor).
 *   - FS samples `colormapLUT` (1×256 rgba8 LUT, currently piecewise; baked
 *     once at layer construction) at vLoading → bright RGB. Mixes with
 *     static `dimColor` uniform via direction-flipped t² gradient.
 *
 * What this avoids:
 *   - Per-feature accessor dispatch (was ~20 ms / tick at 100K features)
 *   - Per-tick attribute upload (was 8+ MB / tick of dim/bright/width)
 *   - Per-feature CPU compute on main thread (worker still runs once per
 *     partition, but per-tick CPU is now O(1) regardless of N)
 *
 * Layer lifecycle:
 *   - initializeState: register `instanceFeatureIndex` (static, accessor
 *     just returns the index), bake colormap LUT.
 *   - updateState: when `stylesTexData` prop changes (new partition),
 *     create or update `stylesTex`. When `currentIndex` prop changes (per
 *     tick), forward to model uniforms.
 *   - finalizeState: dispose textures.
 */

import { PathLayer } from '@deck.gl/layers';
import { COLORMAPS, sampleColormap } from '../colormaps.js';

// ─── Style channel layout ────────────────────────────────────────────────
// Each cell of stylesPacked is 4 floats:
//   R: loading (0..1)
//   G: direction (-1, 0, +1)
//   B: width (pixels)
//   A: alphaFactor (0..1)

// ─── Colormap LUT bake ───────────────────────────────────────────────────
// 256-stop 1D LUT mirrors the piecewise renderer's color zones.
// (orange/red thresholds and smooth-band transitions matching
//  TransmissionLayer.js's piecewiseColor.)
const LUT_WIDTH = 256;

function bakeColormapLUT(orangeThreshold, redThreshold, colorMode = 'piecewise', idleColor = [70, 130, 180]) {
  // Continuous (named) colormap → sample directly from the registry.
  // Anything not in COLORMAPS falls through to the piecewise mode below.
  if (colorMode !== 'piecewise' && colorMode in COLORMAPS) {
    const out = new Uint8Array(LUT_WIDTH * 4);
    for (let i = 0; i < LUT_WIDTH; i++) {
      const t = i / (LUT_WIDTH - 1);
      const c = sampleColormap(colorMode, t);
      out[i * 4]     = c[0];
      out[i * 4 + 1] = c[1];
      out[i * 4 + 2] = c[2];
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  // Piecewise grey/orange/red zones with smoothstep transitions at the
  // orange and red thresholds.
  const ZONE_TRANSITION_BAND = 0.02;
  // Idle / low-load base from the layer's lowUsageColor (steel-blue or grey).
  // Name kept for history. Mirrors TransmissionLayer.js / the worker.
  const GREY   = idleColor;
  const ORANGE = [255, 152, 0];
  const RED    = [183, 28, 28];

  function smoothstep(e0, e1, x) {
    if (e0 >= e1) return x < e0 ? 0 : 1;
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  }
  function lerp(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
  function piecewise(loading) {
    if (loading < orangeThreshold - ZONE_TRANSITION_BAND) return GREY;
    if (loading < orangeThreshold + ZONE_TRANSITION_BAND) {
      return lerp(GREY, ORANGE, smoothstep(
        orangeThreshold - ZONE_TRANSITION_BAND,
        orangeThreshold + ZONE_TRANSITION_BAND,
        loading,
      ));
    }
    if (loading < redThreshold - ZONE_TRANSITION_BAND) return ORANGE;
    if (loading < redThreshold + ZONE_TRANSITION_BAND) {
      return lerp(ORANGE, RED, smoothstep(
        redThreshold - ZONE_TRANSITION_BAND,
        redThreshold + ZONE_TRANSITION_BAND,
        loading,
      ));
    }
    return RED;
  }

  const out = new Uint8Array(LUT_WIDTH * 4);
  for (let i = 0; i < LUT_WIDTH; i++) {
    const t = i / (LUT_WIDTH - 1);
    const c = piecewise(t);
    out[i * 4]     = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ─── Shader module ───────────────────────────────────────────────────────
// Defines the uniform block + sampler bindings + injection points that
// override PathLayer's color/width pipeline with texture-sampled values.

const uniformBlock = /* glsl */ `\
uniform stylesUniforms {
  highp float currentIndex;
  highp float numFeatures;
  highp float numSteps;
  vec4 dimColorRGBA;
  vec2 alphaRange;
  // Loading-zone thresholds used to compute alphaFactor in the shader.
  // Baking these here (rather than in the worker) means threshold-slider
  // drags update instantly via uniform write — no worker recompute, no
  // partition cache invalidation, no flash.
  highp float orangeThreshold;
  highp float greyAlphaMax;
  highp float minGreyAlpha;
} styles;
`;

const vsBody = /* glsl */ `
${uniformBlock}
in float instanceFeatureIndex;

uniform highp sampler2D stylesTex;
uniform sampler2D colormapLUT;

// vBrightRGB is the per-instance loading-zone color, computed in the VS
// from per-step LUT samples then mixed by frac(currentIndex). Doing the
// LUT lookup once per step then mixing the RGB outputs (rather than
// mixing loading values and looking up once) matches legacy deck.gl
// accessor-transition semantics: a feature crossing zone boundaries
// transitions directly between the two zone colors instead of walking
// through every intermediate stop in the LUT.
out vec3  vBrightRGB;
out float vDirection;
out float vAlphaFactor;
out float vWidthOverride;
out float vNormalizedPathPos;
`;

const fsBody = /* glsl */ `
${uniformBlock}

in vec3  vBrightRGB;
in float vDirection;
in float vAlphaFactor;
in float vWidthOverride;
in float vNormalizedPathPos;
`;

const inject = {
  // Width override. Samples two adjacent texels (floor / floor+1) and
  // interpolates by frac(currentIndex). We OVERWRITE size directly, mirror-
  // ing PathLayer's own width pipeline:
  //   widthPixels = clamp(project_size_to_pixel(stroke*scale, units), min, max) / 2
  //   billboard=true  → size = (widthPixels, widthPixels, 0)        // half-pixels
  //   billboard=false → size = (project_pixel_size(widthPixels), …, 0)  // common units
  // Doing it this way (rather than ratio-scaling the existing size) keeps
  // per-feature widths correct under non-pixel widthUnits — at meters mode
  // the ratio approach was clamping both sides to widthMaxPixels and losing
  // the per-feature variation entirely.
  'vs:DECKGL_FILTER_SIZE': /* glsl */ `
    {
      int fi = int(instanceFeatureIndex);
      float ci = styles.currentIndex;
      int t0 = int(floor(ci));
      int t1 = min(t0 + 1, int(styles.numSteps) - 1);
      float frac = ci - float(t0);
      float w0 = texelFetch(stylesTex, ivec2(fi, t0), 0).b;
      float w1 = texelFetch(stylesTex, ivec2(fi, t1), 0).b;
      float texWidth = mix(w0, w1, frac);
      float wPx = clamp(
        project_size_to_pixel(texWidth * path.widthScale, path.widthUnits),
        path.widthMinPixels, path.widthMaxPixels);
      float halfPx = wPx * 0.5;
      if (path.billboard) {
        size = vec3(halfPx, halfPx, 0.0);
      } else {
        float halfCommon = project_pixel_size(halfPx);
        size = vec3(halfCommon, halfCommon, 0.0);
      }
    }
  `,
  // Sample two adjacent texels and linearly interpolate by frac(currentIndex).
  // For RGB we sample the LUT TWICE (once per step's loading) then mix the
  // outputs — this matches legacy attribute-transition semantics where a
  // line crossing zone boundaries fades directly between two colors instead
  // of walking through every intermediate LUT stop. Direction, width, and
  // alphaFactor are scalar-mixed.
  'vs:#main-end': /* glsl */ `
    {
      int fi = int(instanceFeatureIndex);
      float ci = styles.currentIndex;
      int t0 = max(0, int(floor(ci)));
      int t1 = min(t0 + 1, int(styles.numSteps) - 1);
      float frac = clamp(ci - float(t0), 0.0, 1.0);
      vec4 s0 = texelFetch(stylesTex, ivec2(fi, t0), 0);
      vec4 s1 = texelFetch(stylesTex, ivec2(fi, t1), 0);

      // alphaFactor is computed shader-side from loading + threshold so
      // threshold sliders update without worker recompute. The math
      // mirrors the worker's previous JS impl exactly:
      //   loading == 0     → 0  (idle / no flow / no capacity)
      //   loading >= ot    → 1
      //   else             → minGrey + (greyAlphaMax - minGrey) * (loading/ot)
      float ot = styles.orangeThreshold;
      float gMax = styles.greyAlphaMax;
      float gMin = styles.minGreyAlpha;
      float a0 = s0.r <= 1e-6
        ? 0.0
        : (s0.r >= ot ? 1.0
                      : gMin + (gMax - gMin) * (ot > 0.0 ? s0.r / ot : 1.0));
      float a1 = s1.r <= 1e-6
        ? 0.0
        : (s1.r >= ot ? 1.0
                      : gMin + (gMax - gMin) * (ot > 0.0 ? s1.r / ot : 1.0));

      vec3 rgb0 = texture(colormapLUT, vec2(s0.r, 0.5)).rgb;
      vec3 rgb1 = texture(colormapLUT, vec2(s1.r, 0.5)).rgb;
      vBrightRGB     = mix(rgb0, rgb1, frac);
      vDirection     = mix(s0.g, s1.g, frac);
      vWidthOverride = mix(s0.b, s1.b, frac);
      vAlphaFactor   = mix(a0, a1, frac);
      // Whole-path position for the directional gradient. vPathPosition.y /
      // vPathLength is PER-SEGMENT (deck exposes no cumulative path distance),
      // which repeats the gradient on every segment of a real multi-vertex path
      // and looks choppy. Interpolate the per-vertex path fraction baked into z
      // (see pathWithFractionZ in TransmissionLayer.js) across this segment so
      // the sweep spans the whole line. instanceStart/EndPositions are aligned
      // to segment endpoints by deck's tessellator.
      float segT = clamp(vPathPosition.y / max(vPathLength, 1e-6), 0.0, 1.0);
      vNormalizedPathPos = mix(instanceStartPositions.z, instanceEndPositions.z, segT);
    }
  `,
  // Color math matching legacy DirectionalLoadingExtension semantic, with
  // a continuous (non-branching) blend between idle and active states so
  // lines crossing the alphaFactor=0 threshold ease smoothly along with
  // their neighbors instead of snapping.
  //
  // styles.alphaRange = (dimAlpha/255, brightAlpha/255).
  // styles.dimColorRGBA = neutralColor when feature has no flow.
  'fs:DECKGL_FILTER_COLOR': /* glsl */ `
    {
      // Direction-driven gradient position. vDirection is a smooth
      // interpolation of ±1 / 0 from the texture mix, so this naturally
      // eases when flow direction flips between timesteps.
      // At +1 we go dim→bright with path direction, at -1 reversed, at 0
      // we get a centered fade (the natural blended state).
      float dirT = clamp((vDirection + 1.0) * 0.5, 0.0, 1.0);
      float gradPos = mix(1.0 - vNormalizedPathPos, vNormalizedPathPos, dirT);
      float t = gradPos * gradPos;

      float activeAlpha = mix(styles.alphaRange.x, styles.alphaRange.y, t) * vAlphaFactor;

      // Smooth blend idle ↔ active by vAlphaFactor instead of branching.
      // alphaFactor=0 → pure dim; alphaFactor=1 → pure bright with full
      // gradient. In between → blended, eliminating the snap at the
      // threshold crossing.
      vec3  finalRGB   = mix(styles.dimColorRGBA.rgb, vBrightRGB, vAlphaFactor);
      float finalAlpha = mix(styles.dimColorRGBA.a, activeAlpha, vAlphaFactor);

      color = vec4(finalRGB, finalAlpha * layer.opacity);
    }
  `,
};

function getStylesUniforms(opts) {
  if (!opts) return {};
  const out = {};
  if ('stylesTex' in opts)        out.stylesTex       = opts.stylesTex;
  if ('colormapLUT' in opts)      out.colormapLUT     = opts.colormapLUT;
  if ('currentIndex' in opts)     out.currentIndex    = opts.currentIndex;
  if ('numFeatures' in opts)      out.numFeatures     = opts.numFeatures;
  if ('numSteps' in opts)         out.numSteps        = opts.numSteps;
  if ('dimColorRGBA' in opts)     out.dimColorRGBA    = opts.dimColorRGBA;
  if ('alphaRange' in opts)       out.alphaRange      = opts.alphaRange;
  if ('orangeThreshold' in opts)  out.orangeThreshold = opts.orangeThreshold;
  if ('greyAlphaMax' in opts)     out.greyAlphaMax    = opts.greyAlphaMax;
  if ('minGreyAlpha' in opts)     out.minGreyAlpha    = opts.minGreyAlpha;
  return out;
}

export const stylesTextureModule = {
  name: 'styles',
  vs: vsBody,
  fs: fsBody,
  inject,
  getUniforms: getStylesUniforms,
  uniformTypes: {
    currentIndex:    'f32',
    numFeatures:     'f32',
    numSteps:        'f32',
    dimColorRGBA:    'vec4<f32>',
    alphaRange:      'vec2<f32>',
    orangeThreshold: 'f32',
    greyAlphaMax:    'f32',
    minGreyAlpha:    'f32',
  },
};

// ─── Layer subclass ─────────────────────────────────────────────────────

const GPU_DEFAULT_PROPS = {
  // n × numSteps × 4 Float32, packed [loading, direction, width, alpha].
  stylesTexData: { type: 'object', value: null, compare: true },
  numFeatures:   { type: 'number', value: 0 },
  numSteps:      { type: 'number', value: 1 },
  // Target step (integer). The layer interpolates from the previous target
  // toward this one over transitionDuration ms; what reaches the shader
  // each frame is a fractional value.
  currentIndex:  { type: 'number', value: 0 },
  // Cross-step interpolation duration in ms. 0 disables (instant snap).
  transitionDuration: { type: 'number', value: 0 },
  // Static dim color rendered when alphaFactor=0 (zero/no-data lines).
  dimColorRGBA:  { type: 'array',  value: [0.5, 0.5, 0.5, 0.4] },
  // Alpha gradient endpoints (normalized 0..1) for active lines:
  //   x = dimAlpha/255  (line start, mostly transparent)
  //   y = brightAlpha/255 (line end, near-opaque)
  // alphaFactor in (0..1] from the styles texture scales these.
  alphaRange:    { type: 'array',  value: [10 / 255, 220 / 255] },
  orangeThreshold: { type: 'number', value: 0.85 },
  redThreshold:    { type: 'number', value: 0.95 },
  // 'piecewise' (grey/orange/red zones), or any key in COLORMAPS for a
  // continuous gradient over [0,1] loading. Drives the LUT bake. Using
  // the shorthand default-value form (deck.gl has no built-in 'string'
  // type validator and will pass strings through transparently this way).
  colorMode:       'piecewise',
  // Sub-orange-threshold alpha ramp: at loading=0 we start at MIN_GREY,
  // ramping to greyAlphaMax at loading=orangeThreshold. Matches the
  // worker's previous JS impl so visual parity holds across mode toggles.
  greyAlphaMax:    { type: 'number', value: 1.0 },
  minGreyAlpha:    { type: 'number', value: 0.12 },
  // Per-feature integer index. `type: 'accessor'` is the load-bearing
  // tag — without it deck.gl treats the function as a constant value
  // and every instance ends up with the same index.
  getFeatureIndex: { type: 'accessor', value: 0 },
};

export class GpuTransmissionLayer extends PathLayer {
  static layerName = 'GpuTransmissionLayer';
  static defaultProps = { ...PathLayer.defaultProps, ...GPU_DEFAULT_PROPS };

  getShaders() {
    const shaders = super.getShaders();
    // The shader module already carries its own `inject` map; deck.gl /
    // luma.gl process module-level injections automatically, so we don't
    // duplicate them at the layer level here. (Earlier versions did,
    // which left two copies of the texelFetch + varying assignments in
    // the assembled VS — harmless but noisy and a debugging hazard.)
    return {
      ...shaders,
      modules: [...(shaders.modules ?? []), stylesTextureModule],
    };
  }

  initializeState() {
    super.initializeState();

    // Static per-segment attribute. Caller passes `getFeatureIndex` as a
    // pre-built Float32Array(totalSegments) binary prop so PathLayer's
    // per-feature→per-segment expansion is bypassed entirely. Each entry
    // already holds the parent feature index (0..n-1) for that segment.
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      attributeManager.addInstanced({
        instanceFeatureIndex: {
          size: 1,
          type: 'float32',
          accessor: 'getFeatureIndex',
          defaultValue: 0,
        },
      });
    }

    this.setState({
      stylesTex: null,
      colormapLUT: null,
      currentStylesData: null,
      currentLUTSig: null,
      // Transition state — see updateState/draw for how these advance.
      _prevStep: null,
      _targetStep: this.props.currentIndex ?? 0,
      _transitionStart: 0,
    });
  }

  finalizeState(context) {
    const { stylesTex, colormapLUT } = this.state;
    if (stylesTex && typeof stylesTex.destroy === 'function') stylesTex.destroy();
    if (colormapLUT && typeof colormapLUT.destroy === 'function') colormapLUT.destroy();
    super.finalizeState?.(context);
  }

  updateState(params) {
    super.updateState(params);
    const { props, oldProps, changeFlags } = params;
    const device = this.context?.device;
    if (!device) return;

    // Track currentIndex (target step) changes for smooth interpolation.
    //
    // We anchor at the DISCRETE oldProps.currentIndex, not the in-flight
    // fractional value. Anchoring at the in-flight value caused lines to
    // walk through whole intermediate steps when the anchor was, e.g., 5.5
    // and the target was 4 — the shader's two-texel mix would sample step
    // 5 and step 6 at the start, then step 4 and step 5 at the end, briefly
    // exposing step 5's data. By anchoring at the discrete oldProps step,
    // the shader only ever mixes two adjacent texels (oldStep, newStep) so
    // a feature that's idle at both endpoints stays idle throughout.
    //
    // Trade-off: if a sequential tick arrives BEFORE the previous transition
    // completes (transitionDuration > tick interval), the layer micro-snaps
    // from the in-flight value to the new oldProps before easing to the
    // next target. At typical 50–200 ms ticks with similar transition
    // durations, this is barely perceptible.
    //
    // Scrubs (chart-click, big jump): if the discrete delta is large, just
    // snap — easing across many steps rapidly looks like fast playback,
    // which is wrong for an explicit jump intent.
    const SNAP_DELTA = 1.5;
    if (
      props.currentIndex !== oldProps.currentIndex
      && oldProps.currentIndex != null
    ) {
      const delta = Math.abs(props.currentIndex - oldProps.currentIndex);
      if (delta > SNAP_DELTA) {
        // Scrub: snap. prevStep == targetStep ⇒ draw() short-circuits to
        // renderIndex = currentIndex (no easing).
        this.setState({
          _prevStep: props.currentIndex,
          _targetStep: props.currentIndex,
          _transitionStart: 0,
        });
      } else {
        const now = (typeof performance !== 'undefined' ? performance : Date).now();
        this.setState({
          _prevStep: oldProps.currentIndex,
          _targetStep: props.currentIndex,
          _transitionStart: now,
        });
      }
    }

    // Bake/update colormap LUT when thresholds OR colormap mode change.
    const lutSig = `${props.orangeThreshold}|${props.redThreshold}|${props.colorMode}|${(props.idleColor || []).join(',')}`;
    if (lutSig !== this.state.currentLUTSig) {
      const data = bakeColormapLUT(props.orangeThreshold, props.redThreshold, props.colorMode, props.idleColor);
      let lut = this.state.colormapLUT;
      if (!lut) {
        lut = device.createTexture({
          width: LUT_WIDTH,
          height: 1,
          format: 'rgba8unorm',
          data,
          sampler: { magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' },
        });
      } else if (typeof lut.copyImageData === 'function') {
        // luma.gl 9 — write the new RGBA bytes to the existing texture.
        // (NOT setImageData, which doesn't exist on Texture and was silently
        // failing — leaving the LUT stuck at its initial bake forever.)
        lut.copyImageData({ data });
      } else {
        // Fallback: rebuild the texture from scratch if the runtime API
        // doesn't expose copyImageData.
        if (typeof lut.destroy === 'function') lut.destroy();
        lut = device.createTexture({
          width: LUT_WIDTH,
          height: 1,
          format: 'rgba8unorm',
          data,
          sampler: { magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' },
        });
      }
      this.setState({ colormapLUT: lut, currentLUTSig: lutSig });
    }

    // Build / replace styles texture when stylesTexData changes (new
    // partition arrived). Compare-by-identity — the worker hands us the
    // same buffer reference for every getFrame within a partition, so
    // identity change == partition rollover.
    const data = props.stylesTexData;
    const dataChanged = data !== this.state.currentStylesData;
    if (dataChanged && data && props.numFeatures > 0 && props.numSteps > 0) {
      let tex = this.state.stylesTex;
      const w = props.numFeatures;
      const h = props.numSteps;
      const recreate = !tex || tex.width !== w || tex.height !== h;
      if (recreate) {
        if (tex && typeof tex.destroy === 'function') tex.destroy();
        try {
          tex = device.createTexture({
            width: w,
            height: h,
            format: 'rgba32float',
            data,
            sampler: { magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' },
          });
        } catch (e) {
          // EXT_color_buffer_float not available, or other GPU constraint.
          // Caller will detect a null stylesTex and fall back.
          console.warn('[GpuTransmissionLayer] rgba32float texture creation failed:', e);
          tex = null;
        }
      } else if (typeof tex.copyImageData === 'function') {
        // Update existing texture in-place (luma.gl 9 API).
        tex.copyImageData({ data });
      } else {
        // Fallback: recreate.
        if (typeof tex.destroy === 'function') tex.destroy();
        try {
          tex = device.createTexture({
            width: w,
            height: h,
            format: 'rgba32float',
            data,
            sampler: { magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' },
          });
        } catch (e) {
          console.warn('[GpuTransmissionLayer] rgba32float texture creation failed:', e);
          tex = null;
        }
      }
      this.setState({ stylesTex: tex, currentStylesData: data });
    }
  }

  draw(opts) {
    const { stylesTex, colormapLUT } = this.state;
    if (!stylesTex || !colormapLUT) {
      // Texture not yet ready (or rgba32float unsupported). Draw with
      // base PathLayer pipeline — caller is responsible for not enabling
      // this subclass without a workable styles buffer.
      super.draw(opts);
      return;
    }
    const {
      numFeatures, numSteps, currentIndex, dimColorRGBA, alphaRange,
      transitionDuration, orangeThreshold, greyAlphaMax, minGreyAlpha,
    } = this.props;

    // Fractional index for cross-step interpolation. While a transition is
    // in flight, we ease prevStep → targetStep over transitionDuration ms;
    // setNeedsRedraw keeps deck.gl drawing each frame. When the transition
    // completes we stop requesting redraws — the layer falls back to the
    // normal lazy redraw path until the next currentIndex change.
    let renderIndex = currentIndex;
    const { _prevStep, _targetStep, _transitionStart } = this.state;
    if (
      transitionDuration > 0
      && _prevStep != null
      && _prevStep !== _targetStep
      && _transitionStart > 0
    ) {
      const now = (typeof performance !== 'undefined' ? performance : Date).now();
      const t = Math.min(1, (now - _transitionStart) / transitionDuration);
      renderIndex = _prevStep + (_targetStep - _prevStep) * t;
      if (t < 1) this.setNeedsRedraw('styles-transition');
    }
    this._lastRenderIndex = renderIndex;

    // deck.gl 9 routes shader-module uniforms (including textures bound
    // to declared samplers) through `setShaderModuleProps({ moduleName:
    // opts })`. Module's `getUniforms(opts)` is invoked with `opts` and
    // returns a flat object whose entries are wired to the corresponding
    // samplers / uniform-block fields by name.
    this.setShaderModuleProps({
      styles: {
        stylesTex,
        colormapLUT,
        currentIndex: renderIndex,
        numFeatures,
        numSteps,
        dimColorRGBA,
        alphaRange,
        orangeThreshold,
        greyAlphaMax,
        minGreyAlpha,
      },
    });
    super.draw(opts);
  }
}

export default GpuTransmissionLayer;
