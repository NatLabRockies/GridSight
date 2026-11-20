/**
 * DirectionalLineLayer
 *
 * Replaces the legacy ArcLayer for transmission flow visualization. ArcLayer only
 * supported 2-point arcs; this uses PathLayer to render actual multi-segment
 * LineString geometries (transmission paths with intermediate waypoints).
 *
 * ## Design Intent
 *
 * The core idea: use a color gradient to indicate flow direction on each line.
 * A dim, low-alpha origin color transitions to a bright terminus color, so
 * the "bright end" tells you where power (or any flow) is going. When flow
 * reverses (negative value), the gradient flips. This is the same sourceColor /
 * targetColor concept as ArcLayer but generalized to multi-segment paths.
 *
 * ## Shader Approach
 *
 * Rather than assigning a single flat color per path, we inject custom GLSL
 * into PathLayer via deck.gl's LayerExtension API. The extension adds two
 * instanced attributes (instanceSourceColors, instanceTargetColors) and
 * interpolates between them in the fragment shader using `positions.x`
 * (0.0 at segment start, 1.0 at segment end). This gives smooth per-pixel
 * gradients within each segment — not stepped/banded colors.
 *
 * ## Gradient Modes
 *
 * gradientMode: "segment" (default)
 *   The dim→bright gradient repeats on every segment (vertex pair).
 *   Creates a repeating directional pulse pattern — good for long paths
 *   where a single gradient would be too subtle to read direction.
 *
 * gradientMode: "path"
 *   The gradient spans the entire path from origin to terminus.
 *   Better for shorter paths or when you want a single sweep of color.
 *
 * ## TODO / Testing Notes
 *
 * - This has not been visually tested yet. The shader injection approach
 *   needs to be validated with actual GeoJSON LineString data on the map.
 * - If `positions.x` doesn't behave as expected in deck.gl v9's PathLayer,
 *   we may need to use `vPathPosition.y / vPathLength` in the fragment
 *   shader instead (those are PathLayer internal varyings for position
 *   along the path).
 * - The tessellation (breaking LineStrings into 2-point segments on the CPU)
 *   may need performance tuning for datasets with very dense geometries.
 *   A future optimization could keep full paths intact and use a per-vertex
 *   attribute for the interpolation factor instead of per-instance colors.
 * - Width is currently driven by sqrt(|flow|). This may need tuning or
 *   a configurable scaling function.
 * - Animated "marching ants" or particle flow along paths would be a strong
 *   future enhancement to make direction even more visually obvious.
 *
 * ## Usage with the Generic Layer System
 *
 * Register as deck_layer_type = "DirectionalLineLayer" in the layer config.
 * The layer expects:
 *   - GeoJSON LineString geometries (multi-segment paths)
 *   - A "flow" column in the dataset that drives direction and magnitude
 *   - localStyle.gradientMode: "segment" or "path"
 *   - localStyle.originColor / terminusColor: RGBA arrays for gradient endpoints
 */

import { PathLayer, LayerExtension } from 'deck.gl';
import { NO_DEPTH } from './drawParams.js';

// Default colors
const DEFAULT_SOURCE_COLOR = [80, 80, 80, 60];     // dim gray, low alpha (origin)
const DEFAULT_TARGET_COLOR = [0, 200, 255, 220];    // bright cyan (terminus)
const DEFAULT_NEUTRAL_COLOR = [128, 128, 128, 80];  // neutral gray for zero flow

/**
 * DirectionalColorExtension
 *
 * Injects custom GLSL into PathLayer to get per-pixel color interpolation
 * between a sourceColor and targetColor, similar to how ArcLayer handles
 * its gradient. Without this, PathLayer only supports a single flat color
 * per path instance (getColor).
 *
 * How it works:
 *   1. Two instanced attributes (instanceSourceColors, instanceTargetColors)
 *      are added via the attribute manager — one RGBA pair per path instance.
 *   2. The vertex shader passes these colors + `positions.x` (a PathLayer
 *      built-in: 0 at segment start, 1 at segment end) to the fragment shader.
 *   3. The fragment shader does mix(source, target, t) for smooth interpolation.
 *
 * Modeled after PathStyleExtension in @deck.gl/extensions as a reference for
 * how to add instanced attributes and inject into PathLayer's shader pipeline.
 */
class DirectionalColorExtension extends LayerExtension {
  getShaders() {
    return {
      inject: {
        'vs:#decl': `
          in vec4 instanceSourceColors;
          in vec4 instanceTargetColors;
          out vec4 vDirectionalSourceColor;
          out vec4 vDirectionalTargetColor;
          out float vSegmentPosition;
        `,
        'vs:#main-end': `
          vDirectionalSourceColor = instanceSourceColors;
          vDirectionalTargetColor = instanceTargetColors;
          vSegmentPosition = positions.x;
        `,
        'fs:#decl': `
          in vec4 vDirectionalSourceColor;
          in vec4 vDirectionalTargetColor;
          in float vSegmentPosition;
        `,
        'fs:DECKGL_FILTER_COLOR': `
          vec4 dirColor = mix(vDirectionalSourceColor, vDirectionalTargetColor, vSegmentPosition);
          color = vec4(dirColor.rgb, dirColor.a * layer.opacity);
        `,
      },
    };
  }

  initializeState() {
    const attributeManager = this.getAttributeManager();
    if (attributeManager) {
      attributeManager.addInstanced({
        instanceSourceColors: {
          size: 4,
          type: 'unorm8',
          accessor: 'getSourceColor',
          defaultValue: DEFAULT_SOURCE_COLOR,
        },
        instanceTargetColors: {
          size: 4,
          type: 'unorm8',
          accessor: 'getTargetColor',
          defaultValue: DEFAULT_TARGET_COLOR,
        },
      });
    }
  }
}

/**
 * Linearly interpolate between two RGBA color arrays.
 */
function lerpColor(c1, c2, t) {
  return c1.map((v, i) => Math.round(v + t * (c2[i] - v)));
}

/**
 * Tessellate for "path" mode: gradient spans the entire path.
 *
 * Each segment's sourceColor/targetColor is computed from its fractional
 * position along the full path, so the gradient is continuous end-to-end.
 */
function tessellatePathGradient(coordinates, flowValue, originColor, terminusColor) {
  if (!coordinates || coordinates.length < 2) return [];

  const n = coordinates.length - 1;
  const isReversed = flowValue < 0;
  const startColor = isReversed ? terminusColor : originColor;
  const endColor = isReversed ? originColor : terminusColor;

  const segments = [];
  for (let i = 0; i < n; i++) {
    segments.push({
      path: [coordinates[i], coordinates[i + 1]],
      sourceColor: lerpColor(startColor, endColor, i / n),
      targetColor: lerpColor(startColor, endColor, (i + 1) / n),
    });
  }
  return segments;
}

/**
 * Tessellate for "segment" mode: gradient repeats on every segment.
 *
 * Every segment goes originColor→terminusColor (or reversed for negative flow).
 * This creates a repeating dim→bright pattern that makes direction obvious
 * on long multi-segment paths.
 */
function tessellateSegmentGradient(coordinates, flowValue, originColor, terminusColor) {
  if (!coordinates || coordinates.length < 2) return [];

  const n = coordinates.length - 1;
  const isReversed = flowValue < 0;
  const startColor = isReversed ? terminusColor : originColor;
  const endColor = isReversed ? originColor : terminusColor;

  const segments = [];
  for (let i = 0; i < n; i++) {
    segments.push({
      path: [coordinates[i], coordinates[i + 1]],
      sourceColor: startColor,
      targetColor: endColor,
    });
  }
  return segments;
}

/**
 * Create a DirectionalLineLayer from GeoJSON features with flow data.
 *
 * @param {object} options
 * @param {string} options.id - Layer ID
 * @param {object} options.geoData - GeoJSON FeatureCollection with LineString features
 * @param {Map|null} options.dataIndex - Map<entityId → { flow, ... } | number>
 * @param {string} options.joinKey - GeoJSON property to join on
 * @param {string} options.flowColumn - Column name for flow values (default: "flow")
 * @param {string} options.gradientMode - "path" = gradient spans full path,
 *                                        "segment" = gradient repeats per segment
 * @param {number[]} options.originColor - RGBA at gradient start (dim/gray end)
 * @param {number[]} options.terminusColor - RGBA at gradient end (bright end)
 * @param {number[]} options.neutralColor - RGBA for zero flow
 * @param {number} options.widthScale - Multiplier for line width
 * @param {number} options.widthMinPixels - Minimum width in pixels
 * @param {number} options.widthMaxPixels - Maximum width in pixels
 * @param {number} options.opacity - Layer opacity
 * @param {boolean} options.pickable - Whether the layer responds to pointer events
 * @param {function} options.onHover - Hover callback
 * @param {function} options.onClick - Click callback
 * @param {number} options.transitionDuration - Animation transition duration in ms
 * @returns {PathLayer|null}
 */
export function createDirectionalLineLayer({
  id = 'directional-lines',
  geoData,
  dataIndex,
  joinKey,
  flowColumn = 'flow',
  gradientMode = 'segment',
  originColor = DEFAULT_SOURCE_COLOR,
  terminusColor = DEFAULT_TARGET_COLOR,
  neutralColor = DEFAULT_NEUTRAL_COLOR,
  widthScale = 1,
  widthMinPixels = 1,
  widthMaxPixels = 20,
  opacity = 0.8,
  pickable = true,
  onHover = null,
  onClick = null,
  transitionDuration = 0,
} = {}) {
  if (!geoData) return null;

  const features = geoData.features ?? (Array.isArray(geoData) ? geoData : []);
  if (!features.length) return null;

  const tessellate = gradientMode === 'path'
    ? tessellatePathGradient
    : tessellateSegmentGradient;

  const segments = [];

  for (const feature of features) {
    const coords = feature.geometry?.coordinates;
    if (!coords || feature.geometry?.type !== 'LineString') continue;

    // Look up flow value from data index
    let flowValue = 0;
    if (dataIndex && joinKey) {
      const entityId = String(feature.properties?.[joinKey] ?? '');
      const entry = dataIndex.get(entityId);
      if (entry != null) {
        flowValue = typeof entry === 'number' ? entry : (entry[flowColumn] ?? 0);
      }
    }

    const absMagnitude = Math.abs(flowValue);
    const width = absMagnitude < 1e-6
      ? widthMinPixels
      : Math.min(Math.sqrt(absMagnitude) * widthScale, widthMaxPixels);

    if (absMagnitude < 1e-6) {
      // Zero flow — uniform neutral color, no gradient
      segments.push({
        path: coords,
        sourceColor: neutralColor,
        targetColor: neutralColor,
        width,
        feature,
      });
    } else {
      // Non-zero flow — tessellate with directional gradient
      const dirSegments = tessellate(coords, flowValue, originColor, terminusColor);
      for (const seg of dirSegments) {
        segments.push({ ...seg, width, feature });
      }
    }
  }

  if (!segments.length) return null;

  return new PathLayer({
    id,
    data: segments,
    getPath: d => d.path,
    getColor: d => d.sourceColor,  // fallback; overridden by extension shader
    getSourceColor: d => d.sourceColor,
    getTargetColor: d => d.targetColor,
    getWidth: d => d.width ?? 1,
    widthScale,
    widthMinPixels,
    widthMaxPixels,
    widthUnits: 'pixels',
    opacity,
    pickable,
    autoHighlight: true,
    jointRounded: true,
    capRounded: true,
    extensions: [new DirectionalColorExtension()],
    ...(onHover && { onHover }),
    ...(onClick && { onClick }),
    ...(transitionDuration > 0 && {
      transitions: {
        getSourceColor: { duration: transitionDuration },
        getTargetColor: { duration: transitionDuration },
        getWidth: { duration: transitionDuration },
      },
    }),
    updateTriggers: {
      getSourceColor: [dataIndex, gradientMode],
      getTargetColor: [dataIndex, gradientMode],
      getWidth: [dataIndex, widthScale],
    },
    parameters: NO_DEPTH,
  });
}

export { DirectionalColorExtension };
export default createDirectionalLineLayer;
