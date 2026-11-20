/**
 * scatterplotTimeseries.worker.js — module worker for ScatterplotLayer with
 * style_mappings driven by a timeseries. Stubbed in Phase 1 to validate the
 * protocol round-trip; real precompute lands in Phase 5 alongside the GPU
 * texture path.
 *
 * Responsibilities (final shape):
 *   - INIT: receive layer geometry (positions + entityIds) and style config.
 *   - PARTITION_LOADED: parse Arrow IPC bytes; precompute per-(timestep ×
 *     feature) Float32 buffers for each style_mapping (radius, fillColor,
 *     lineColor, lineWidth, elevation). Post buffers back as transferables.
 *   - STYLE_CHANGED: recompute the affected channel only and post back.
 *   - DISPOSE: drop all per-layer state.
 *
 * Phase 1 stub just acks each message. Phase 5 fills in the math.
 */

import { MSG, assertMessage } from './protocol.js';

/** @type {Map<string, object>} layerId → state */
const state = new Map();

self.addEventListener('message', (e) => {
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
      state.set(id, { style: msg.style, geom: msg.geom, joinKey: msg.joinKey });
      break;
    }

    case MSG.PARTITION_LOADED: {
      const s = state.get(id);
      if (!s) {
        self.postMessage({ type: MSG.ERROR, layerId: id, message: 'PARTITION_LOADED before INIT' });
        return;
      }
      // Phase 1 stub: ack with an empty buffer set.
      // Phase 5 will:
      //   1. import { tableFromIPC } from 'apache-arrow' (lazy)
      //   2. const table = tableFromIPC(msg.arrowBytes)
      //   3. for each (step, feature, mapping) compute aligned typed arrays
      //   4. transfer them in `buffers`
      self.postMessage({
        type: MSG.READY,
        layerId: id,
        partitionId: msg.partitionId,
        buffers: {},
      });
      break;
    }

    case MSG.STYLE_CHANGED: {
      const s = state.get(id);
      if (!s) return;
      s.style = msg.style;
      // Phase 1 stub: nothing to recompute.
      break;
    }

    case MSG.DISPOSE: {
      state.delete(id);
      break;
    }
  }
});
