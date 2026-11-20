/**
 * LayerWorkerPool — one Web Worker per layer type, refcounted by layerId.
 *
 * Layers register themselves via `acquire(kind, layerId, init, onReady, onError)`.
 * The pool wakes (or reuses) a single shared worker per `kind` and routes
 * messages keyed by layerId. When the last layer for a kind unregisters, the
 * worker stays alive for GRACE_MS to absorb thrash on geometry reload, then
 * terminates.
 *
 * `postPartition` transfers Arrow IPC bytes; `postStyle` is small and
 * synchronous (see comment in the implementation re: race ordering with
 * PARTITION_LOADED).
 */

import { MSG, assertMessage } from './protocol.js';

const GRACE_MS = 30_000;

// kind → factory creating a Worker. Lazily resolved so unused workers never
// pay their import cost.
const WORKER_FACTORIES = {
  scatterplotTimeseries: () =>
    new Worker(new URL('./scatterplotTimeseries.worker.js', import.meta.url), { type: 'module' }),
  transmissionLayer: () =>
    new Worker(new URL('./transmissionLayer.worker.js', import.meta.url), { type: 'module' }),
  generatorLayer: () =>
    new Worker(new URL('./generatorLayer.worker.js', import.meta.url), { type: 'module' }),
};

class WorkerSlot {
  constructor(kind) {
    this.kind = kind;
    this.worker = WORKER_FACTORIES[kind]();
    this.refs = 0;
    this.terminateTimer = null;
    /** @type {Map<string, {onReady: Function, onError: Function}>} */
    this.handlers = new Map();

    this.worker.addEventListener('message', (e) => {
      const msg = e.data;
      try {
        assertMessage(msg);
      } catch (err) {
        console.warn('[LayerWorkerPool] malformed message', err, msg);
        return;
      }
      const handler = this.handlers.get(String(msg.layerId));
      if (!handler) return;
      if (msg.type === MSG.READY)  handler.onReady?.(msg);
      if (msg.type === MSG.ERROR)  handler.onError?.(msg);
    });

    this.worker.addEventListener('error', (e) => {
      console.error(`[LayerWorkerPool:${kind}] worker error`, e);
    });
  }

  acquire(layerId, onReady, onError) {
    const id = String(layerId);
    this.handlers.set(id, { onReady, onError });
    this.refs++;
    if (this.terminateTimer) {
      clearTimeout(this.terminateTimer);
      this.terminateTimer = null;
    }
  }

  release(layerId) {
    const id = String(layerId);
    if (!this.handlers.has(id)) return;
    this.handlers.delete(id);
    this.worker.postMessage({ type: MSG.DISPOSE, layerId: id });
    this.refs--;
    if (this.refs <= 0) {
      this.terminateTimer = setTimeout(() => this.terminate(), GRACE_MS);
    }
  }

  terminate() {
    this.worker.terminate();
    this.handlers.clear();
  }
}

const slots = new Map(); // kind → WorkerSlot

function getSlot(kind) {
  if (!WORKER_FACTORIES[kind]) {
    throw new Error(`LayerWorkerPool: unknown worker kind '${kind}'`);
  }
  let slot = slots.get(kind);
  if (!slot) {
    slot = new WorkerSlot(kind);
    slots.set(kind, slot);
  }
  return slot;
}

/**
 * Register a layer with a worker pool slot.
 * @returns {{
 *   postInit:       (init: object) => void,
 *   postPartition:  (partitionId: string, arrowBytes: ArrayBuffer, partitionRange: object) => void,
 *   postStyle:      (style: object) => void,
 *   release:        () => void,
 * }}
 */
export function acquireLayerWorker(kind, layerId, { onReady, onError } = {}) {
  const slot = getSlot(kind);
  slot.acquire(layerId, onReady, onError);
  const id = String(layerId);

  return {
    postInit(init) {
      slot.worker.postMessage({ type: MSG.INIT, layerId: id, ...init });
    },
    postPartition(partitionId, arrowBytes, partitionRange, extras = null) {
      // `extras` carries optional secondary buffers (currently used by
      // GeneratorLayer to ship per-tick availability data). Each extra
      // is also transferred so the main thread releases ownership.
      const transfers = [arrowBytes];
      const msg = {
        type: MSG.PARTITION_LOADED,
        layerId: id,
        partitionId,
        arrowBytes,
        partitionRange,
      };
      if (extras && typeof extras === 'object') {
        for (const [role, buf] of Object.entries(extras)) {
          if (buf instanceof ArrayBuffer) {
            msg[`${role}ArrowBytes`] = buf;
            transfers.push(buf);
          }
        }
      }
      slot.worker.postMessage(msg, transfers);
    },
    postStyle(style) {
      // Send synchronously so the worker has the new style *before* any
      // PARTITION_LOADED messages that the cache fires on resubscribe in
      // the same render cycle. Debouncing this caused a race where style
      // sliders (e.g. greyAlphaMax) silently failed: the catch-up replay
      // was processed under the old style, then STYLE_CHANGED arrived
      // too late and no further READY was emitted. Style messages are
      // tiny — debouncing was a premature optimization.
      slot.worker.postMessage({ type: MSG.STYLE_CHANGED, layerId: id, style });
    },
    release() { slot.release(id); },
  };
}
