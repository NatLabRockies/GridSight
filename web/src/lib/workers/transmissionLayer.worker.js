/**
 * transmissionLayer.worker.js — module worker that precomputes per-
 * (timestep × feature) style buffers for TransmissionLayer.
 *
 * Math is a direct transplant of the per-tick loop in TransmissionLayer.js
 * so visual parity is preserved. Whole-partition compute runs once per
 * partition load; per-tick CPU on the main thread becomes a subarray slice.
 *
 * Messages:
 *   IN  INIT             { layerId, geom: { entityIds, capacities }, style }
 *   IN  PARTITION_LOADED { layerId, partitionId, arrowBytes (transferable) }
 *   IN  STYLE_CHANGED    { layerId, style }      -- re-fire PARTITION_LOADED
 *                                                   from main thread to recompute
 *   IN  DISPOSE          { layerId }
 *   OUT READY            { layerId, partitionId, numSteps, n,
 *                          buffers: { dimColors, brightColors, widths,
 *                                     flows, loadings } }   (all transferred)
 *   OUT ERROR            { layerId, message }
 */

import { MSG, assertMessage } from './protocol.js';
import { COLORMAPS, sampleColormap } from '../colormaps.js';

// ─── Logging ───────────────────────────────────────────────────────────────
// Workers can't import the main-thread `logger` (it lives in a React-bundled
// module tree), so inline a tiny relay. Same wire format as logger.js so
// the Bun handler can't tell the difference. Always also writes to the
// worker's own console for in-browser debugging.
function debugLog(message) {
  // eslint-disable-next-line no-console
  console.debug('[worker]', message);
  try {
    fetch('/api/logs/client', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'debug', message, ts: new Date().toISOString() }),
    }).catch(() => {});
  } catch { /* relay must never throw */ }
}

// ─── Defaults (mirror TransmissionLayer.js) ────────────────────────────────
const DEFAULT_NEUTRAL_COLOR = [70, 130, 180, 100]; // steel-blue idle tint (mirror of TransmissionLayer.js)
const DEFAULT_DIM_ALPHA = 10;
const DEFAULT_BRIGHT_ALPHA = 220;
const MIN_GREY_ALPHA_RATIO = 0.12;
const ZONE_TRANSITION_BAND = 0.02;
// Idle / low-load tint — steel-blue, not grey, so barely-loaded lines stay
// distinct from grey basemap streets. Must match TransmissionLayer.js and
// shaders/StylesTextureExtension.js. Name kept for history.
const GREY_COLOR   = [70, 130, 180];
const ORANGE_COLOR = [255, 152, 0];
const RED_COLOR    = [183, 28, 28];

function smoothstep(edge0, edge1, x) {
  if (edge0 >= edge1) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function piecewiseColor(loading, orangeThreshold, redThreshold, out, idleColor = GREY_COLOR) {
  if (loading < orangeThreshold - ZONE_TRANSITION_BAND) {
    out[0] = idleColor[0]; out[1] = idleColor[1]; out[2] = idleColor[2];
    return;
  }
  if (loading < orangeThreshold + ZONE_TRANSITION_BAND) {
    const t = smoothstep(
      orangeThreshold - ZONE_TRANSITION_BAND,
      orangeThreshold + ZONE_TRANSITION_BAND,
      loading,
    );
    out[0] = Math.round(idleColor[0] + (ORANGE_COLOR[0] - idleColor[0]) * t);
    out[1] = Math.round(idleColor[1] + (ORANGE_COLOR[1] - idleColor[1]) * t);
    out[2] = Math.round(idleColor[2] + (ORANGE_COLOR[2] - idleColor[2]) * t);
    return;
  }
  if (loading < redThreshold - ZONE_TRANSITION_BAND) {
    out[0] = ORANGE_COLOR[0]; out[1] = ORANGE_COLOR[1]; out[2] = ORANGE_COLOR[2];
    return;
  }
  if (loading < redThreshold + ZONE_TRANSITION_BAND) {
    const t = smoothstep(
      redThreshold - ZONE_TRANSITION_BAND,
      redThreshold + ZONE_TRANSITION_BAND,
      loading,
    );
    out[0] = Math.round(ORANGE_COLOR[0] + (RED_COLOR[0] - ORANGE_COLOR[0]) * t);
    out[1] = Math.round(ORANGE_COLOR[1] + (RED_COLOR[1] - ORANGE_COLOR[1]) * t);
    out[2] = Math.round(ORANGE_COLOR[2] + (RED_COLOR[2] - ORANGE_COLOR[2]) * t);
    return;
  }
  out[0] = RED_COLOR[0]; out[1] = RED_COLOR[1]; out[2] = RED_COLOR[2];
}

// ─── Per-layer state ───────────────────────────────────────────────────────
/**
 * @type {Map<string, {
 *   entityIds: string[],
 *   capacities: Float32Array,
 *   segmentCounts: Uint32Array,
 *   segmentOffsets: Uint32Array,
 *   totalSegments: number,
 *   n: number,
 *   style: object,
 * }>}
 */
const state = new Map();

// apache-arrow loaded lazily.
let _tableFromIPC = null;
async function getTableFromIPC() {
  if (!_tableFromIPC) {
    const mod = await import('apache-arrow');
    _tableFromIPC = mod.tableFromIPC;
  }
  return _tableFromIPC;
}

self.addEventListener('message', async (e) => {
  const msg = e.data;
  try {
    assertMessage(msg);
  } catch (err) {
    self.postMessage({ type: MSG.ERROR, layerId: msg?.layerId ?? '', message: err.message });
    return;
  }
  const id = String(msg.layerId);

  switch (msg.type) {
    case MSG.INIT: {
      const { entityIds, capacities } = msg.geom ?? {};
      state.set(id, {
        entityIds: entityIds ?? [],
        capacities: capacities instanceof Float32Array
          ? capacities
          : new Float32Array(capacities ?? []),
        n: entityIds?.length ?? 0,
        style: msg.style ?? {},
        // Per-layer diagnostic gate: log the matched/unmatched summary
        // only on the first partition (or any partition with a real
        // mismatch). Without this, every loaded partition spams the
        // console — dozens of identical lines per scenario.
        loggedFirstPartition: false,
      });
      break;
    }

    case MSG.STYLE_CHANGED: {
      const s = state.get(id);
      if (!s) return;
      s.style = msg.style ?? {};
      // No recompute here — main thread re-fires PARTITION_LOADED with bytes.
      break;
    }

    case MSG.PARTITION_LOADED: {
      const s = state.get(id);
      if (!s) {
        self.postMessage({ type: MSG.ERROR, layerId: id, message: 'PARTITION_LOADED before INIT' });
        return;
      }
      try {
        const tableFromIPC = await getTableFromIPC();
        const u8 = new Uint8Array(msg.arrowBytes);
        const table = tableFromIPC(u8);
        const numSteps = table.numRows;
        const n = s.n;
        const { entityIds, capacities, style } = s;

        const neutralColor    = style.neutralColor    ?? DEFAULT_NEUTRAL_COLOR;
        const idleColor       = style.idleColor       ?? GREY_COLOR;
        const dimAlpha        = style.dimAlpha        ?? DEFAULT_DIM_ALPHA;
        const brightAlpha     = style.brightAlpha     ?? DEFAULT_BRIGHT_ALPHA;
        const orangeThreshold = style.orangeThreshold ?? 0.85;
        const redThreshold    = style.redThreshold    ?? 0.95;
        const colorMode       = style.colorMode       ?? 'piecewise';
        const greyAlphaMax    = style.greyAlphaMax    ?? 1.0;
        const usePiecewise    = colorMode === 'piecewise' || !(colorMode in COLORMAPS);

        // Resolve column vector per feature once (Arrow getChild is hashmap lookup).
        // null entries → entityId not in this partition; treated as zero flow.
        const cols = new Array(n);
        let matched = 0;
        const unmatchedSamples = [];
        for (let i = 0; i < n; i++) {
          const c = table.getChild(entityIds[i]);
          cols[i] = c ?? null;
          if (c) matched++;
          else if (unmatchedSamples.length < 5) unmatchedSamples.push(entityIds[i]);
        }
        // Compare against the partition's column count so we know whether
        // the gap is "feature has no data column" vs "join key mismatch".
        // Only log on the first partition per-layer (sanity check) or any
        // subsequent partition where we have an unexpected mismatch.
        const tableCols = table.schema?.fields?.map(f => f.name) ?? [];
        if (!s.loggedFirstPartition || matched !== n) {
          debugLog(
            `[transmissionLayer.worker] partition=${msg.date} matched=${matched}/${n} ` +
            `(table has ${tableCols.length} columns; ` +
            `unmatched samples: ${JSON.stringify(unmatchedSamples)}; ` +
            `sample table cols: ${JSON.stringify(tableCols.slice(0, 3))})`,
          );
          s.loggedFirstPartition = true;
        }

        // Phase 2 (memcpy/function-accessor) buffers — per-feature RGBA
        // and width that the main thread copies into cached path objects.
        const dimColors    = new Float32Array(numSteps * n * 4);
        const brightColors = new Float32Array(numSteps * n * 4);
        const widths       = new Float32Array(numSteps * n);
        const flows        = new Float32Array(numSteps * n);
        const loadings     = new Float32Array(numSteps * n);
        // Phase 3 (GPU texture) packed styles. Layout per (step, feature):
        //   R: loading       (0..1, used by FS to sample colormap LUT)
        //   G: direction     (-1, 0, or +1; flips gradient direction)
        //   B: width         (pixels, drives PathLayer width via shader override)
        //   A: alphaFactor   (0..1, scales bright alpha)
        // Whole-partition Float32Array uploaded to GPU as rgba32float
        // texture once per partition; per-tick CPU is then just a
        // currentIndex uniform write — flat with N.
        const stylesPacked = new Float32Array(numSteps * n * 4);

        for (let step = 0; step < numSteps; step++) {
          const stepFeatureBase = step * n;
          for (let i = 0; i < n; i++) {
            const col = cols[i];
            const raw = col ? col.get(step) : 0;
            const flow = raw == null ? 0 : Number(raw);
            const capacity = capacities[i];
            const absFlow = flow < 0 ? -flow : flow;

            // Per-feature compute → r/g/b/dimA/brightA/width + alphaFactor.
            let r, g, b, dimA, brightA, width, loading, alphaFactor, direction;

            if (absFlow < 1e-6 || capacity <= 0) {
              r = neutralColor[0]; g = neutralColor[1]; b = neutralColor[2];
              dimA = neutralColor[3]; brightA = neutralColor[3];
              width = 0.5;
              loading = 0;
              alphaFactor = 0;          // bright invisible → only static dim renders
              direction = 0;
            } else {
              loading = absFlow / capacity;
              if (loading >= orangeThreshold) {
                alphaFactor = 1.0;
              } else {
                const t = orangeThreshold > 0 ? loading / orangeThreshold : 1.0;
                alphaFactor = MIN_GREY_ALPHA_RATIO + (greyAlphaMax - MIN_GREY_ALPHA_RATIO) * t;
              }
              let rgb;
              if (usePiecewise) {
                const tmp = [0, 0, 0];
                piecewiseColor(loading, orangeThreshold, redThreshold, tmp, idleColor);
                rgb = tmp;
              } else {
                rgb = sampleColormap(colorMode, loading > 1 ? 1 : loading);
              }
              r = rgb[0]; g = rgb[1]; b = rgb[2];
              dimA    = (dimAlpha    * alphaFactor + 0.5) | 0;
              brightA = (brightAlpha * alphaFactor + 0.5) | 0;
              width   = Math.sqrt(absFlow) * 0.3;
              direction = flow > 0 ? 1 : -1;
              // Phase 2 path swaps dim/bright on negative flow; the GPU
              // path uses the `direction` channel and flips the gradient
              // shader-side instead.
              if (flow <= 0) { const t = dimA; dimA = brightA; brightA = t; }
            }

            const j4 = (stepFeatureBase + i) * 4;
            dimColors[j4]   = r; dimColors[j4+1]   = g; dimColors[j4+2]   = b; dimColors[j4+3]   = dimA;
            brightColors[j4]= r; brightColors[j4+1]= g; brightColors[j4+2]= b; brightColors[j4+3]= brightA;
            widths[stepFeatureBase + i]   = width;
            flows[stepFeatureBase + i]    = flow;
            loadings[stepFeatureBase + i] = loading;
            // GPU-texture cell (Float32 RGBA, normalized for shader use).
            stylesPacked[j4]     = loading;
            stylesPacked[j4 + 1] = direction;
            stylesPacked[j4 + 2] = width;
            stylesPacked[j4 + 3] = alphaFactor;
          }
        }

        self.postMessage(
          {
            type: MSG.READY,
            layerId: id,
            partitionId: msg.partitionId,
            numSteps,
            n,
            buffers: { dimColors, brightColors, widths, flows, loadings, stylesPacked },
          },
          [
            dimColors.buffer,
            brightColors.buffer,
            widths.buffer,
            flows.buffer,
            loadings.buffer,
            stylesPacked.buffer,
          ],
        );
      } catch (err) {
        self.postMessage({
          type: MSG.ERROR,
          layerId: id,
          message: `transmission worker compute failed: ${err?.message ?? err}`,
        });
      }
      break;
    }

    case MSG.DISPOSE: {
      state.delete(id);
      break;
    }
  }
});
