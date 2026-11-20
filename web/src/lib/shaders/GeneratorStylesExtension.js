/**
 * GeneratorStylesExtension / GpuGeneratorLayer — Phase 3 GPU-resident
 * timeseries path for generator points.
 *
 * Architecture mirrors TransmissionLayer's StylesTextureExtension. Differences:
 *
 *   - Base layer is ScatterplotLayer, not PathLayer. ScatterplotLayer's
 *     DECKGL_FILTER_SIZE injection receives `vec3 offset` (already
 *     multiplied by outerRadiusPixels), not a half-pixel width vec3 — so
 *     we override radius via ratio scaling rather than direct overwrite.
 *     The reference scale is `instanceRadius` (which the caller wires to
 *     the static-capacity value); the ratio is the current-step's
 *     outerMW divided by that reference. Falls back gracefully when a
 *     feature has no static capacity (instanceRadius=1) — legacy parity.
 *
 *   - Texture channels are RAW gen/cap (R=genMW, G=capMW); visibility
 *     mode (gen-only / cap-only / both) is interpreted via uniforms in
 *     the shader. Mode-toggle sliders update without worker recompute.
 *
 *   - Tech color is per-feature STATIC, passed as `instanceTechColor`
 *     binary attribute. Eliminates the both-mode per-tick ringColor
 *     allocation that the legacy CPU path had — ring color is now
 *     vTechColor with a uniform alpha multiplier.
 *
 *   - No colormap LUT — generator color is per-feature static, no zone
 *     mapping by loading.
 */

import { ScatterplotLayer } from '@deck.gl/layers';

// ─── Shader module ───────────────────────────────────────────────────────

const uniformBlock = /* glsl */ `\
uniform generatorUniforms {
  highp float currentIndex;
  highp float numFeatures;
  highp float numSteps;
  // Visibility floats — 1.0 if mode active, 0.0 otherwise. Lets the
  // shader mode-select between gen / cap / curt / combinations via uniform.
  highp float generationVisible;
  highp float capacityVisible;
  highp float curtailmentVisible;
  // Ring stroke width in pixels (only used when capacity is visible).
  highp float ringPixelsBoth;
  // Ring outline alpha (0..1). Multiplied by per-feature techColor.a.
  highp float ringAlphaUniform;
  // Curtailment band fill (RGBA ∈ [0,1]). Packed as vec4 (instead of
  // vec3 + float) because vec3 in std140 uniform blocks has surprising
  // padding rules across luma.gl backends — vec4 is always safe.
  highp vec4 curtColorRGBA;
} generator;
`;

const vsBody = /* glsl */ `
${uniformBlock}
in float instanceFeatureIndex;
in vec4 instanceTechColor;
in float instanceCurtailable;

uniform highp sampler2D stylesTex;

out vec4  vTechColor;
out float vInnerRatio;
out float vCurtEdge;
out float vRingThickness;
out float vAlphaFactor;
out float vCurtVisible;
out float vGenVisible;

// File-scope mutable global. Written by vs:#main-start (which runs inside
// main(), where ScatterplotLayer's instanceRadius is in scope), read by
// vs:DECKGL_FILTER_SIZE. This indirection is required because GLSL parses
// function bodies at definition time -- and the DECKGL_FILTER_SIZE function
// is defined BEFORE ScatterplotLayer's instanceRadius declaration in the
// assembled shader, so referencing instanceRadius inside that function
// would be a forward-reference compile error. Going through a file-scope
// global declared in OUR module (before any function defs) sidesteps that.
float _gpuRadiusScale = 1.0;
`;

const fsBody = /* glsl */ `
${uniformBlock}

in vec4  vTechColor;
in float vInnerRatio;
in float vCurtEdge;
in float vRingThickness;
in float vAlphaFactor;
in float vCurtVisible;       // 1.0 if curtailment overlay is on, else 0.0
in float vGenVisible;        // 1.0 if generation inner fill is on
`;

const inject = {
  // Single texelFetch per step (two for cross-step easing); compute mode-
  // dependent outerMW + innerRatio + alpha; output as varyings. Same
  // fractional-currentIndex two-texel-mix pattern TransmissionLayer uses.
  // All mode math is inlined — function definitions can't appear inside
  // main() in GLSL ES 3.0.
  'vs:#main-end': /* glsl */ `
    {
      int fi = int(instanceFeatureIndex);
      float ci = generator.currentIndex;
      int t0 = max(0, int(floor(ci)));
      int t1 = min(t0 + 1, int(generator.numSteps) - 1);
      float frac = clamp(ci - float(t0), 0.0, 1.0);
      vec4 s0 = texelFetch(stylesTex, ivec2(fi, t0), 0);
      vec4 s1 = texelFetch(stylesTex, ivec2(fi, t1), 0);

      float gen0 = s0.r;
      float cap0 = s0.g;
      float gen1 = s1.r;
      float cap1 = s1.g;

      // Mode selection from uniforms.
      // genV / capV / curtV are 1.0/0.0 floats from the JS-side prop
      // conversion in getGeneratorUniforms.
      float genV  = generator.generationVisible;
      float capV  = generator.capacityVisible;
      bool genOn  = genV  > 0.5;
      bool capOn  = capV  > 0.5;
      // Curt-mode is per-feature: curtailment toggle ON *and* this
      // feature is curtailable (VRE). When in curt-mode, the feature
      // is rendered as a solid grey disc sized by curtMW = max(0,
      // cap-gen). Other features (thermal) ignore the toggle and fall
      // through to standard G/C rendering — the user can see grey VRE
      // dots side-by-side with tech-colored thermal dots and tell at a
      // glance whether curtailment is co-located with committed
      // thermal capacity (a different signal than transmission limits).
      bool curtMode = (generator.curtailmentVisible > 0.5 && instanceCurtailable > 0.5);

      float curt0 = max(0.0, cap0 - gen0);
      float curt1 = max(0.0, cap1 - gen1);

      float outer0;
      float outer1;
      float inner0;
      float inner1;
      float a0;
      float a1;
      if (curtMode) {
        outer0 = curt0;
        outer1 = curt1;
        inner0 = 0.0;
        inner1 = 0.0;
        a0 = (curt0 > 0.0) ? 1.0 : 0.0;
        a1 = (curt1 > 0.0) ? 1.0 : 0.0;
      } else {
        outer0 = max(genOn ? gen0 : 0.0, capOn ? cap0 : 0.0);
        outer1 = max(genOn ? gen1 : 0.0, capOn ? cap1 : 0.0);
        inner0 = (genOn && outer0 > 0.0) ? min(gen0 / outer0, 1.0) : 0.0;
        inner1 = (genOn && outer1 > 0.0) ? min(gen1 / outer1, 1.0) : 0.0;
        a0 = (gen0 > 0.0 || cap0 > 0.0) ? 1.0 : 0.0;
        a1 = (gen1 > 0.0 || cap1 > 0.0) ? 1.0 : 0.0;
      }

      float outerMW = mix(outer0, outer1, frac);
      vInnerRatio   = mix(inner0, inner1, frac);
      // Legacy varying — unused under the curt-mode model. Pin to
      // vInnerRatio so any stale FS branch evaluates to a no-op.
      vCurtEdge     = vInnerRatio;
      vAlphaFactor  = mix(a0, a1, frac);

      // Cap-ring outline only in normal mode (curt-mode is a solid
      // grey disc with no outline).
      vRingThickness = (!curtMode && capOn)
        ? clamp(generator.ringPixelsBoth / max(outerRadiusPixels, 1e-6), 0.0, 1.0)
        : 0.0;

      // vCurtVisible is now the per-feature curt-mode flag (NOT the
      // global uniform). When set, FS paints a solid grey disc.
      vCurtVisible = curtMode ? 1.0 : 0.0;
      vGenVisible  = genOn  ? 1.0 : 0.0;

      // Tech color passes through verbatim (instanceTechColor is uint8 0-255
      // upgraded to float by deck.gl, so divide by 255 to get GLSL color
      // math range; multiply by layer.opacity to match the base layer's
      // pre-multiplied vFillColor convention).
      vTechColor = vec4(instanceTechColor.rgb / 255.0, (instanceTechColor.a / 255.0) * layer.opacity);
    }
  `,
  // Compute the per-feature radius scale BEFORE ScatterplotLayer's main()
  // multiplies positions by outerRadiusPixels. Runs inside main() so
  // scatterplot.* uniforms and our texture are all in scope. Stores the
  // ratio in the file-scope `_gpuRadiusScale` global; vs:DECKGL_FILTER_SIZE
  // reads that global to scale `size` (= the offset main() will use to
  // expand the quad).
  //
  // We compute BOTH the desired pixel radius (from currentOuterMW) and the
  // default pixel radius (from instanceRadius=1, which the caller pins via
  // getRadius: 1) using the same project_size_to_pixel + clamp pipeline
  // ScatterplotLayer's main() applies. The ratio cancels out the default,
  // so the final on-screen radius lands at clamp(outerMW * radiusScale, min,
  // max) — visual parity with the legacy CPU path's d.radius = outerMW *
  // radiusScale. Decoupling from instanceRadius (instead of using it as
  // the reference scale) avoids the fallback-divides-by-1 bug where
  // features with no static-capacity property got grossly oversized.
  'vs:#main-start': /* glsl */ `
    {
      int _gfi = int(instanceFeatureIndex);
      float _gci = generator.currentIndex;
      int _gt0 = max(0, int(floor(_gci)));
      int _gt1 = min(_gt0 + 1, int(generator.numSteps) - 1);
      float _gfrac = clamp(_gci - float(_gt0), 0.0, 1.0);
      vec4 _gs0 = texelFetch(stylesTex, ivec2(_gfi, _gt0), 0);
      vec4 _gs1 = texelFetch(stylesTex, ivec2(_gfi, _gt1), 0);
      float _ggen0 = _gs0.r;
      float _gcap0 = _gs0.g;
      float _ggen1 = _gs1.r;
      float _gcap1 = _gs1.g;
      float _ggenV  = generator.generationVisible;
      float _gcapV  = generator.capacityVisible;
      // Curt-mode = per-feature gate. When on, this feature's outer
      // radius is curtMW = max(0, cap-gen) — it's no longer a band
      // overlay around the gen disc, it's the disc itself. Non-VRE
      // features ignore the toggle and fall through to standard sizing.
      bool _gcurtMode = (generator.curtailmentVisible > 0.5 && instanceCurtailable > 0.5);
      float _gcurt0 = max(0.0, _gcap0 - _ggen0);
      float _gcurt1 = max(0.0, _gcap1 - _ggen1);
      float _gouter0;
      float _gouter1;
      if (_gcurtMode) {
        _gouter0 = _gcurt0;
        _gouter1 = _gcurt1;
      } else {
        _gouter0 = max(_ggenV > 0.5 ? _ggen0 : 0.0, _gcapV > 0.5 ? _gcap0 : 0.0);
        _gouter1 = max(_ggenV > 0.5 ? _ggen1 : 0.0, _gcapV > 0.5 ? _gcap1 : 0.0);
      }
      float _gouterMW = mix(_gouter0, _gouter1, _gfrac);

      // Desired on-screen radius for this step, mirroring ScatterplotLayer's
      // own pipeline (project_size_to_pixel + clamp).
      float _gdesiredPx = clamp(
        project_size_to_pixel(scatterplot.radiusScale * _gouterMW, scatterplot.radiusUnits),
        scatterplot.radiusMinPixels, scatterplot.radiusMaxPixels);
      // Default that ScatterplotLayer's main() will compute when instanceRadius=1
      // (caller pins getRadius: 1 for the GPU branch). We floor at 1 px to
      // keep the divisor well-conditioned: when the user sets
      // radiusMinPixels = 0, deck.gl's clamp loses its floor and at low
      // zooms project_size_to_pixel(radiusScale) shrinks to a fraction
      // of a pixel — division precision then inflates _gpuRadiusScale and
      // some dots saturate at radiusMaxPixels. The floor is invisible at
      // sub-pixel scales (sub-1px features aren't visible anyway) but
      // keeps the ratio stable when min=0.
      float _gdefaultPx = max(clamp(
        project_size_to_pixel(scatterplot.radiusScale, scatterplot.radiusUnits),
        scatterplot.radiusMinPixels, scatterplot.radiusMaxPixels), 1.0);
      // Ratio: scaling 'size' (which is positions × default × edgePadding)
      // by this factor gives positions × desired × edgePadding — matching
      // legacy d.radius = outerMW × radiusScale visually.
      _gpuRadiusScale = _gdesiredPx / _gdefaultPx;
    }
  `,
  // Apply the precomputed radius ratio. ScatterplotLayer already scaled
  // 'size' by outerRadiusPixels (which uses instanceRadius); multiplying
  // by _gpuRadiusScale lands at clamp(currentOuterMW * radiusScale, …)
  // pixels — visual parity with the legacy CPU path that took
  // d.radius = outerMW * radiusScale.
  'vs:DECKGL_FILTER_SIZE': /* glsl */ `
    {
      size *= _gpuRadiusScale;
    }
  `,
  // Curt-mode-or-normal color logic:
  //   curt mode (vCurtVisible > 0.5): solid grey disc. The disc is
  //     already sized by curtMW upstream, so we just paint it.
  //   normal mode: tech-color fill + optional cap-ring outline.
  'fs:DECKGL_FILTER_COLOR': /* glsl */ `
    {
      if (vAlphaFactor <= 0.0) {
        color = vec4(0.0);
      } else if (vCurtVisible > 0.5) {
        // Per-feature curt-mode (VRE with curtailment toggle on).
        // Solid grey disc — no inner ratio, no ring.
        color = vec4(generator.curtColorRGBA.rgb,
                     generator.curtColorRGBA.a * vAlphaFactor);
      } else {
        // Normal: tech color fill, optional cap-ring outline.
        color = vec4(vTechColor.rgb, vTechColor.a * vAlphaFactor);
        if (vRingThickness > 0.0) {
          float normDist = length(geometry.uv);
          float clampedDist = min(normDist, 1.0);
          float ringInnerEdge = max(vInnerRatio, 1.0 - vRingThickness);
          float aaPad = 0.005;
          if (clampedDist <= vInnerRatio + aaPad) {
            // Inner zone — keep tech fill.
          } else if (clampedDist >= ringInnerEdge - aaPad) {
            // Cap outline.
            float outerEdge = 1.0 - smoothstep(0.99, 1.01, normDist);
            color = vec4(vTechColor.rgb,
                         vTechColor.a * generator.ringAlphaUniform * outerEdge * vAlphaFactor);
          } else {
            // Transparent gap between inner disc and outer ring.
            color.a = 0.0;
          }
        }
      }
    }
  `,
};

function getGeneratorUniforms(opts) {
  if (!opts) return {};
  const out = {};
  if ('stylesTex' in opts)           out.stylesTex           = opts.stylesTex;
  if ('currentIndex' in opts)        out.currentIndex        = opts.currentIndex;
  if ('numFeatures' in opts)         out.numFeatures         = opts.numFeatures;
  if ('numSteps' in opts)            out.numSteps            = opts.numSteps;
  if ('generationVisible' in opts)   out.generationVisible   = opts.generationVisible ? 1 : 0;
  if ('capacityVisible' in opts)     out.capacityVisible     = opts.capacityVisible ? 1 : 0;
  if ('curtailmentVisible' in opts)  out.curtailmentVisible  = opts.curtailmentVisible ? 1 : 0;
  if ('ringPixelsBoth' in opts)      out.ringPixelsBoth      = opts.ringPixelsBoth;
  if ('ringAlphaUniform' in opts)    out.ringAlphaUniform    = opts.ringAlphaUniform;
  if ('curtColorRGBA' in opts)       out.curtColorRGBA       = opts.curtColorRGBA;
  return out;
}

export const generatorStylesModule = {
  name: 'generator',
  vs: vsBody,
  fs: fsBody,
  inject,
  getUniforms: getGeneratorUniforms,
  uniformTypes: {
    currentIndex:       'f32',
    numFeatures:        'f32',
    numSteps:           'f32',
    generationVisible:  'f32',
    capacityVisible:    'f32',
    curtailmentVisible: 'f32',
    ringPixelsBoth:     'f32',
    ringAlphaUniform:   'f32',
    curtColorRGBA:      'vec4<f32>',
  },
};

// ─── Layer subclass ─────────────────────────────────────────────────────

const GPU_DEFAULT_PROPS = {
  // n × numSteps × 4 Float32, packed [genMW, capMW, _, _].
  stylesTexData:    { type: 'object', value: null, compare: true },
  numFeatures:      { type: 'number', value: 0 },
  numSteps:         { type: 'number', value: 1 },
  currentIndex:     { type: 'number', value: 0 },
  transitionDuration: { type: 'number', value: 0 },
  generationVisible:  true,
  capacityVisible:    true,
  curtailmentVisible: false,
  ringPixelsBoth:     { type: 'number', value: 2 },
  ringAlphaUniform:   { type: 'number', value: 220 / 255 },
  // Curtailment band fill color (RGBA, normalized). Grey by default —
  // distinguishable from tech colors so the band reads as "wasted/idle"
  // capacity. Packed RGBA so the uniform block layout is std140-safe.
  curtColorRGBA:      { type: 'array',  value: [0.5, 0.5, 0.5, 0.6] },
  // Per-feature integer index. type:'accessor' is load-bearing.
  getFeatureIndex:  { type: 'accessor', value: 0 },
  // Per-feature static tech color. RGBA 0-255 (deck.gl auto-converts to
  // float in the attribute buffer; shader divides by 255).
  getTechColor:     { type: 'accessor', value: [100, 149, 237, 220] },
  // Per-feature curtailment gate (1 = curtailable, 0 = not).
  getCurtailable:   { type: 'accessor', value: 1 },
};

export class GpuGeneratorLayer extends ScatterplotLayer {
  static layerName = 'GpuGeneratorLayer';
  static defaultProps = { ...ScatterplotLayer.defaultProps, ...GPU_DEFAULT_PROPS };

  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      modules: [...(shaders.modules ?? []), generatorStylesModule],
    };
  }

  initializeState() {
    super.initializeState();
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      attributeManager.addInstanced({
        instanceFeatureIndex: {
          size: 1,
          type: 'float32',
          accessor: 'getFeatureIndex',
          defaultValue: 0,
        },
        instanceTechColor: {
          size: 4,
          type: 'float32',
          accessor: 'getTechColor',
          defaultValue: [100, 149, 237, 220],
        },
        // Per-feature curtailment gate. 1 = the feature physically
        // curtails (VRE in GAT), 0 = curtailment band suppressed even
        // when the global toggle is on.
        instanceCurtailable: {
          size: 1,
          type: 'float32',
          accessor: 'getCurtailable',
          defaultValue: 1,
        },
      });
    }
    this.setState({
      stylesTex: null,
      currentStylesData: null,
      _prevStep: null,
      _targetStep: this.props.currentIndex ?? 0,
      _transitionStart: 0,
    });
  }

  finalizeState(context) {
    const { stylesTex } = this.state;
    if (stylesTex && typeof stylesTex.destroy === 'function') stylesTex.destroy();
    super.finalizeState?.(context);
  }

  updateState(params) {
    super.updateState(params);
    const { props, oldProps, changeFlags } = params;
    const device = this.context?.device;
    if (!device) return;

    // Cross-step transition state machine (anchor at discrete oldProps,
    // snap on >1.5 step deltas — same heuristic as GpuTransmissionLayer).
    const SNAP_DELTA = 1.5;
    if (
      props.currentIndex !== oldProps.currentIndex
      && oldProps.currentIndex != null
    ) {
      const delta = Math.abs(props.currentIndex - oldProps.currentIndex);
      if (delta > SNAP_DELTA) {
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

    // Build / replace styles texture when stylesTexData changes (new partition).
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
          console.warn('[GpuGeneratorLayer] rgba32float texture creation failed:', e);
          tex = null;
        }
      } else if (typeof tex.copyImageData === 'function') {
        tex.copyImageData({ data });
      } else {
        if (typeof tex.destroy === 'function') tex.destroy();
        try {
          tex = device.createTexture({
            width: w, height: h, format: 'rgba32float', data,
            sampler: { magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' },
          });
        } catch (e) {
          console.warn('[GpuGeneratorLayer] rgba32float texture creation failed:', e);
          tex = null;
        }
      }
      this.setState({ stylesTex: tex, currentStylesData: data });
    }
  }

  draw(opts) {
    const { stylesTex } = this.state;
    if (!stylesTex) {
      super.draw(opts);
      return;
    }
    const {
      numFeatures, numSteps, currentIndex, transitionDuration,
      generationVisible, capacityVisible, curtailmentVisible,
      ringPixelsBoth, ringAlphaUniform,
      curtColorRGBA,
    } = this.props;

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
      if (t < 1) this.setNeedsRedraw('generator-styles-transition');
    }
    this._lastRenderIndex = renderIndex;

    this.setShaderModuleProps({
      generator: {
        stylesTex,
        currentIndex: renderIndex,
        numFeatures,
        numSteps,
        generationVisible,
        capacityVisible,
        curtailmentVisible,
        ringPixelsBoth,
        ringAlphaUniform,
        curtColorRGBA,
      },
    });
    super.draw(opts);
  }
}

export default GpuGeneratorLayer;
