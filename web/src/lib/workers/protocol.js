/**
 * Worker message protocol for layer-type precompute workers.
 *
 * One module worker per layer type (transmission, generator, scatterplot, …).
 * Workers receive raw Arrow IPC bytes per partition and produce ready-to-bind
 * typed-array buffers for deck.gl. Style edits route through the same channel
 * so recomputation happens off the main thread.
 *
 * Message ownership:
 *   main → worker:  INIT, PARTITION_LOADED, STYLE_CHANGED, DISPOSE
 *   worker → main:  READY, ERROR
 */

export const MSG = Object.freeze({
  // main → worker
  INIT:             'init',             // { layerId, geom, style, joinKey, capacityProperty? }
  PARTITION_LOADED: 'partition_loaded', // { layerId, partitionId, arrowBytes (transferred), partitionRange }
  STYLE_CHANGED:    'style_changed',    // { layerId, style }
  DISPOSE:          'dispose',          // { layerId }

  // worker → main
  READY:            'ready',            // { layerId, partitionId, buffers (transferred) }
  ERROR:            'error',            // { layerId, message, stack? }
});

/**
 * Validate a message envelope. Throws on malformed shape so bugs surface
 * during dev rather than silently no-op.
 */
export function assertMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    throw new Error(`worker protocol: expected object, got ${typeof msg}`);
  }
  if (typeof msg.type !== 'string') {
    throw new Error('worker protocol: missing type');
  }
  if (typeof msg.layerId !== 'string' && typeof msg.layerId !== 'number') {
    throw new Error(`worker protocol: missing layerId on ${msg.type}`);
  }
}
