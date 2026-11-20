/**
 * generatorLayer.worker.js — module worker that precomputes per-(timestep ×
 * feature) style buffers for GeneratorLayer.
 *
 * Math is a direct transplant of the per-tick loop in GeneratorLayer.js so
 * visual parity is preserved across toggles. Whole-partition compute runs
 * once per partition load; per-tick CPU on the main thread becomes a
 * subarray slice + memcpy (Phase 2) or a single uniform write (Phase 3).
 *
 * Generator math is simpler than transmission's piecewise/colormap zoning —
 * there's no loading-derived colormap. Tech color is per-feature STATIC
 * (passed in at INIT time). The worker bakes per-step radius / innerRatio /
 * ringPixels / fillColor / ringColor for the Phase 2 fast path, and a
 * compact (genMW, capMW) packed texture for the Phase 3 GPU path. The GPU
 * path interprets visibility modes (generationVisible × capacityVisible) at
 * render time via uniforms, so toggles update without worker recompute.
 *
 * Messages:
 *   IN  INIT             { layerId, geom: { entityIds, capacities,
 *                                            staticTechColors }, style }
 *   IN  PARTITION_LOADED { layerId, partitionId, arrowBytes (transferable) }
 *   IN  STYLE_CHANGED    { layerId, style }     -- main thread re-fires
 *                                                  PARTITION_LOADED bytes
 *   IN  DISPOSE          { layerId }
 *   OUT READY            { layerId, partitionId, numSteps, n,
 *                          buffers: { radii, innerRatios, ringPixels,
 *                                     fillColors, ringColors, gens, caps,
 *                                     stylesPacked } }      (all transferred)
 *   OUT ERROR            { layerId, message }
 */

import { MSG, assertMessage } from './protocol.js';

// ─── Logging ───────────────────────────────────────────────────────────────
// Workers can't import the main-thread `logger` (different module graph), so
// inline a tiny relay matching logger.js's wire format.
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

// ─── Per-layer state ───────────────────────────────────────────────────────
/**
 * @type {Map<string, {
 *   entityIds: string[],
 *   capacities: Float32Array,         // static-property capacity, or 0 sentinel
 *   staticTechColors: Uint8Array,     // per-feature RGBA, n*4 bytes (0..255)
 *   n: number,
 *   style: object,
 * }>}
 */
const state = new Map();

// apache-arrow loaded lazily — first PARTITION_LOADED triggers the import.
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
      const { entityIds, capacities, staticTechColors, staticCurtailable } = msg.geom ?? {};
      const n = entityIds?.length ?? 0;
      state.set(id, {
        entityIds: entityIds ?? [],
        capacities: capacities instanceof Float32Array
          ? capacities
          : new Float32Array(capacities ?? n),
        staticTechColors: staticTechColors instanceof Uint8Array
          ? staticTechColors
          : new Uint8Array(n * 4),
        // Per-feature curt-mode gate. 1 = curtailable (renders as grey
        // disc sized by curt MW when curtailmentVisible is on). 0 =
        // not curtailable (renders normally regardless of curt toggle).
        // Defaults to "all curtailable" when the geom payload omits it,
        // so non-GAT extensions keep current behavior.
        staticCurtailable: staticCurtailable instanceof Uint8Array
          ? staticCurtailable
          : new Uint8Array(n).fill(1),
        n,
        style: msg.style ?? {},
        // Per-layer diagnostic gate; see transmissionLayer.worker.js for context.
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
        const { entityIds, capacities, staticTechColors, staticCurtailable, style } = s;

        // Optional availability table — when present (renewable layer
        // wires it via dataset_refs role="availability"), it drives the
        // cap channel per-timestep instead of the static `capacities`
        // (= nameplate). That makes curtailment reflect real dispatch
        // curtailment (avail − gen) rather than "unused nameplate".
        let availCols = null;
        let availMatched = 0;
        if (msg.availabilityArrowBytes) {
          try {
            const availTable = tableFromIPC(new Uint8Array(msg.availabilityArrowBytes));
            availCols = new Array(n);
            for (let i = 0; i < n; i++) {
              const c = availTable.getChild(entityIds[i]) ?? null;
              availCols[i] = c;
              if (c) availMatched++;
            }
          } catch (e) {
            self.postMessage({
              type: MSG.ERROR, layerId: id,
              message: `availability parse failed: ${e.message}`,
            });
            availCols = null;
          }
        }
        const generationVisible  = style.generationVisible  ?? true;
        const capacityVisible    = style.capacityVisible    ?? true;
        const curtailmentVisible = style.curtailmentVisible ?? false;
        const radiusScale        = style.radiusScale        ?? 1;
        const ringPixelsBoth     = style.ringPixelsBoth     ?? 2;
        const ringAlpha          = style.ringAlpha          ?? 220;
        // Curtailment grey (RGBA 0–255). Mirrors GeneratorLayer.js's
        // CPU-path constants; the GPU shader normalises and applies its
        // own version via uniforms.
        const CURT_GREY_R = 128, CURT_GREY_G = 128, CURT_GREY_B = 128, CURT_GREY_A = 153;

        // Resolve column vector per feature once (Arrow getChild is hashmap lookup).
        // null entries → entityId not in this partition; treated as zero generation.
        const cols = new Array(n);
        let matched = 0;
        const unmatchedSamples = [];
        for (let i = 0; i < n; i++) {
          const c = table.getChild(entityIds[i]);
          cols[i] = c ?? null;
          if (c) matched++;
          else if (unmatchedSamples.length < 5) unmatchedSamples.push(entityIds[i]);
        }
        const tableCols = table.schema?.fields?.map(f => f.name) ?? [];
        if (!s.loggedFirstPartition || matched !== n) {
          debugLog(
            `[generatorLayer.worker] partition=${msg.partitionId} matched=${matched}/${n} ` +
            `(table has ${tableCols.length} columns; ` +
            `unmatched samples: ${JSON.stringify(unmatchedSamples)}; ` +
            `sample table cols: ${JSON.stringify(tableCols.slice(0, 3))})`,
          );
          s.loggedFirstPartition = true;
        }

        // Phase 2 buffers — per-feature scalars and RGBAs that the main thread
        // memcpys into cached path objects each tick. Layout per (step, feature)
        // matches the legacy CPU loop's mutated fields exactly so accessor
        // closures stay 1:1.
        const radii        = new Float32Array(numSteps * n);
        const innerRatios  = new Float32Array(numSteps * n);
        const ringPixelsArr = new Float32Array(numSteps * n);
        const fillColors   = new Float32Array(numSteps * n * 4);
        const ringColors   = new Float32Array(numSteps * n * 4);
        // Per-(step, feature) raw values for picking popups & debugging
        const gens = new Float32Array(numSteps * n);
        const caps = new Float32Array(numSteps * n);

        // Phase 3 GPU-texture packed values. Layout per (step, feature):
        //   R: genMW (raw, MW)
        //   G: capMW (raw, MW)
        //   B: unused (reserved)
        //   A: unused (reserved)
        // The shader interprets visibility (gen-only / cap-only / both) and
        // applies radiusScale + ringPixels at render time via uniforms, so
        // those sliders update INSTANTLY without worker recompute.
        const stylesPacked = new Float32Array(numSteps * n * 4);

        for (let step = 0; step < numSteps; step++) {
          const stepBase  = step * n;
          const stepBase4 = stepBase * 4;
          for (let i = 0; i < n; i++) {
            const col = cols[i];
            const rawGen = col ? col.get(step) : 0;
            const genMW  = rawGen == null ? 0 : Number(rawGen);
            // Cap channel is time-varying availability when supplied,
            // else falls back to static nameplate. The shader uses this
            // to drive both the capacity ring radius and the curtailment
            // band thickness — avail-driven cap = real curtailment for
            // VRE; nameplate fallback keeps thermal rendering as before.
            let capMW;
            if (availCols && availCols[i]) {
              const rawAvail = availCols[i].get(step);
              capMW = rawAvail == null ? (capacities[i] || 0) : Number(rawAvail);
            } else {
              capMW = capacities[i] || 0;
            }
            const outerMW = genMW > capMW ? genMW : capMW;
            const innerRatio = outerMW > 0 ? Math.min(genMW / outerMW, 1.0) : 1.0;

            const tcR = staticTechColors[i * 4];
            const tcG = staticTechColors[i * 4 + 1];
            const tcB = staticTechColors[i * 4 + 2];
            const tcA = staticTechColors[i * 4 + 3];

            // Phase 2 baked values per feature × step.
            // Curt-mode model: when curtailment is on globally AND this
            // feature is curtailable (VRE), we render a grey disc sized
            // by curtailment MW (= max(0, avail-gen)). Curtailment is
            // a *replacement* mode for VRE, not an overlay — it lets
            // the user spot waste at a glance: "big grey dot here =
            // VRE being curtailed; tech-color thermal next to it tells
            // the story (committed thermal preventing absorption)."
            // Non-curtailable features (thermal) ignore the curt
            // toggle entirely and fall through to normal G/C rendering.
            const curtMW = capMW > genMW ? capMW - genMW : 0;
            const curtMode = curtailmentVisible && staticCurtailable[i];
            let radius, ratio, ringPx;
            let fR, fG, fB, fA;
            let rR, rG, rB, rA;
            if (curtMode) {
              radius = curtMW * radiusScale;
              ratio  = 1.0;
              ringPx = 0;
              fR = CURT_GREY_R; fG = CURT_GREY_G; fB = CURT_GREY_B; fA = CURT_GREY_A;
              rR = 0; rG = 0; rB = 0; rA = 0;
            } else if (generationVisible && capacityVisible) {
              radius = outerMW * radiusScale;
              ratio  = innerRatio;
              ringPx = ringPixelsBoth;
              fR = tcR; fG = tcG; fB = tcB; fA = tcA;
              rR = tcR; rG = tcG; rB = tcB; rA = ringAlpha;
            } else if (generationVisible) {
              radius = genMW * radiusScale;
              ratio  = 1.0;
              ringPx = 0;
              fR = tcR; fG = tcG; fB = tcB; fA = tcA;
              rR = 0; rG = 0; rB = 0; rA = 0;
            } else if (capacityVisible) {
              radius = capMW * radiusScale;
              ratio  = 1.0;
              ringPx = 0;
              fR = tcR; fG = tcG; fB = tcB; fA = tcA;
              rR = 0; rG = 0; rB = 0; rA = 0;
            } else {
              radius = 0; ratio = 1.0; ringPx = 0;
              fR = 0; fG = 0; fB = 0; fA = 0;
              rR = 0; rG = 0; rB = 0; rA = 0;
            }

            // Phase 2 outputs.
            radii[stepBase + i]        = radius;
            innerRatios[stepBase + i]  = ratio;
            ringPixelsArr[stepBase + i] = ringPx;
            const j4 = stepBase4 + i * 4;
            fillColors[j4]     = fR; fillColors[j4 + 1] = fG; fillColors[j4 + 2] = fB; fillColors[j4 + 3] = fA;
            ringColors[j4]     = rR; ringColors[j4 + 1] = rG; ringColors[j4 + 2] = rB; ringColors[j4 + 3] = rA;
            gens[stepBase + i] = genMW;
            caps[stepBase + i] = capMW;

            // Phase 3 GPU-texture cell — raw genMW/capMW, mode-independent.
            stylesPacked[j4]     = genMW;
            stylesPacked[j4 + 1] = capMW;
            stylesPacked[j4 + 2] = 0;
            stylesPacked[j4 + 3] = 0;
          }
        }

        self.postMessage(
          {
            type: MSG.READY,
            layerId: id,
            partitionId: msg.partitionId,
            numSteps,
            n,
            buffers: {
              radii, innerRatios, ringPixels: ringPixelsArr,
              fillColors, ringColors,
              gens, caps,
              stylesPacked,
            },
          },
          [
            radii.buffer,
            innerRatios.buffer,
            ringPixelsArr.buffer,
            fillColors.buffer,
            ringColors.buffer,
            gens.buffer,
            caps.buffer,
            stylesPacked.buffer,
          ],
        );
      } catch (err) {
        self.postMessage({
          type: MSG.ERROR,
          layerId: id,
          message: `generator worker compute failed: ${err?.message ?? err}`,
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
