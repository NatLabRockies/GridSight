/**
 * LayerWorkerCache — bridges the (stateless) layer factory functions in
 * `layer_generators.js` / `TransmissionLayer.js` / `GeneratorLayer.js` and
 * the per-layer-type Web Workers.
 *
 * Each cache entry owns:
 *   - one worker handle (from `acquireLayerWorker`)
 *   - one TimeseriesBuffer subscription
 *   - a Map<partitionId, {numSteps, n, buffers...}> of precomputed slices
 *
 * The factory function calls `getOrCreate(...)` every render and reads the
 * frame for the current (partition, step). When the geometry signature or
 * style signature changes, the cache reinitialises the worker and evicts
 * partition buffers.
 *
 * Idle entries are released after IDLE_MS so removed layers don't keep
 * their worker alive forever.
 */

import { acquireLayerWorker } from './LayerWorkerPool.js';

const IDLE_MS = 60_000;

/** @type {Map<string, CacheEntry>} layerId → entry */
const entries = new Map();

/**
 * @typedef {{
 *   layerId: string,
 *   kind: string,
 *   geomSig: string,
 *   styleSig: string,
 *   tsBuf: object | null,
 *   unsubscribe: (() => void) | null,
 *   handle: ReturnType<typeof acquireLayerWorker>,
 *   partitions: Map<string, {numSteps: number, n: number, buffers: object}>,
 *   lastTouched: number,
 *   onUpdate: (() => void) | null,
 * }} CacheEntry
 */

function sweepIdle() {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (now - entry.lastTouched > IDLE_MS) {
      releaseEntry(id);
    }
  }
}

function releaseEntry(id) {
  const entry = entries.get(id);
  if (!entry) return;
  for (const u of Object.values(entry.unsubscribes ?? {})) {
    try { u(); } catch { /* noop */ }
  }
  entry.handle.release();
  entries.delete(id);
}

/**
 * Acquire (or refresh) a worker cache entry for a layer.
 *
 * @param {object} args
 * @param {string} args.layerId        Stable layer id (matches deck.gl layer id)
 * @param {string} args.kind           Worker kind (e.g. 'transmissionLayer')
 * @param {string} args.geomSig        Stable signature for INIT geom — when this changes the worker is re-INITed and partition buffers cleared
 * @param {string} args.styleSig       Stable signature for the style payload — when this changes a STYLE_CHANGED is sent and partition buffers re-requested
 * @param {object} args.geom           Geometry payload to send on INIT (entityIds, capacities, …)
 * @param {object} args.style          Style payload to send with INIT / STYLE_CHANGED
 * @param {object|null} args.tsBuf     TimeseriesBuffer to subscribe to for partition events. If null, no subscription is established.
 * @param {() => void} [args.onUpdate] Optional callback fired when a new partition's READY arrives (lets the factory bump its updateTrigger)
 * @returns {CacheEntry}
 */
export function getOrCreate({ layerId, kind, geomSig, styleSig, geom, style, tsBuf, tsBufs, onUpdate }) {
  sweepIdle();

  // tsBufs is a role→buffer map (e.g. { primary, availability }). When
  // omitted, fall back to the legacy single-buffer `tsBuf` arg under the
  // implicit "primary" role.
  const effectiveBufs = tsBufs && Object.keys(tsBufs).length > 0
    ? tsBufs
    : (tsBuf ? { primary: tsBuf } : {});

  let entry = entries.get(layerId);

  // New entry — full setup.
  if (!entry) {
    entry = {
      layerId,
      kind,
      geomSig: '',
      styleSig: '',
      tsBufs: {},          // role → buffer
      unsubscribes: {},    // role → unsubscribe fn
      // Per-date staging — when a layer subscribes to multiple roles
      // (e.g. primary + availability), partitions for the same date can
      // arrive at different times. We hold each role's bytes here and
      // only postPartition when *every* required role is in.
      pendingPartitions: new Map(),
      requiredRoles: new Set(),
      // Per-layer scratchpad for binary `data` envelopes. Layers cache a
      // stable `data` object here keyed by their own layout and mutate
      // inner `attributes.<name>.value` refs each tick, so deck.gl sees
      // the same prop identity across renders and skips full attribute-
      // reconciliation work it would otherwise repeat on every tsVersion
      // bump.
      scratch: new Map(),
      handle: acquireLayerWorker(kind, layerId, {
        onReady: (msg) => {
          const e = entries.get(layerId);
          if (!e) return;
          e.partitions.set(msg.partitionId, {
            numSteps: msg.numSteps,
            n: msg.n,
            buffers: msg.buffers,
          });
          e.onUpdate?.();
        },
        onError: (msg) => {
          console.warn(`[LayerWorkerCache:${kind}:${layerId}]`, msg.message);
        },
      }),
      partitions: new Map(),
      lastTouched: Date.now(),
      onUpdate: onUpdate ?? null,
    };
    entries.set(layerId, entry);
  } else {
    entry.lastTouched = Date.now();
    if (onUpdate) entry.onUpdate = onUpdate;
  }

  // Geometry change → re-INIT + drop all partition buffers (will be
  // re-requested as the subscription replays loaded partitions below).
  const geomChanged = entry.geomSig !== geomSig;
  if (geomChanged) {
    if (entry.geomSig) {
      // First-time INIT is silent; a *re-init* is worth surfacing because
      // it usually means an upstream prop is unstable across renders.
      console.info(
        `[LayerWorkerCache:${kind}:${layerId}] re-INIT (geomSig changed: ${entry.geomSig} → ${geomSig})`,
      );
    }
    entry.partitions.clear();
    entry.handle.postInit({ geom, style, joinKey: geom?.joinKey });
    entry.geomSig = geomSig;
    entry.styleSig = styleSig;
  } else if (entry.styleSig !== styleSig) {
    // Style change → tell the worker, then re-fire PARTITION_LOADED for
    // already-loaded partitions through the subscription replay below so
    // the worker recomputes their buffers under the new style.
    //
    // We DO NOT clear partitions here. If we did, every getFrame call
    // between now and the worker's first READY would return null and the
    // GPU layer would fall through to the legacy CPU path, producing a
    // visible flash. Keeping the stale partitions on screen until the new
    // ones land replaces the flash with a brief delay (no visual change
    // for Phase 3 where styling is uniform-driven; subtle alpha/color
    // delay for Phase 2 where colors are baked in the worker buffers).
    console.info(
      `[LayerWorkerCache:${kind}:${layerId}] style change → resubscribe + replay partitions (sig: ${entry.styleSig} → ${styleSig})`,
    );
    entry.handle.postStyle(style);
    entry.styleSig = styleSig;
    // Force resubscribe so subscriber-catch-up replays partitions to worker
    // (across every role). The next branch rebuilds subs + pendingPartitions.
    for (const u of Object.values(entry.unsubscribes)) {
      try { u(); } catch { /* noop */ }
    }
    entry.unsubscribes = {};
    entry.pendingPartitions.clear();
  }

  // (Re)bind to each timeseries buffer in `effectiveBufs`. The styling
  // path may force a resubscribe (entry.unsubscribes was cleared above)
  // even when buffer identities haven't changed; in that case we just
  // resubscribe so the catch-up replay re-feeds the worker.
  // Detect identity changes per role; if any changed (or all subs were
  // wiped by a style change), tear down everything and re-subscribe so
  // pendingPartitions starts clean.
  const newRoles = Object.keys(effectiveBufs);
  const oldRoles = Object.keys(entry.tsBufs);
  let bufsChanged = newRoles.length !== oldRoles.length;
  if (!bufsChanged) {
    for (const role of newRoles) {
      if (entry.tsBufs[role] !== effectiveBufs[role]) { bufsChanged = true; break; }
    }
  }
  const allSubsCleared = Object.keys(entry.unsubscribes).length === 0
    && newRoles.some(r => effectiveBufs[r]);

  if (bufsChanged || allSubsCleared) {
    if (bufsChanged && oldRoles.length) {
      console.info(
        `[LayerWorkerCache:${kind}:${layerId}] tsBufs identity changed; resubscribing (catch-up will replay loaded partitions)`,
      );
    }
    // Clear out old subs + staged partitions.
    for (const u of Object.values(entry.unsubscribes)) {
      try { u(); } catch { /* noop */ }
    }
    entry.unsubscribes = {};
    entry.pendingPartitions.clear();
    entry.tsBufs = { ...effectiveBufs };
    entry.requiredRoles = new Set(newRoles.filter(r => effectiveBufs[r]));

    const tryFlush = (date) => {
      const staged = entry.pendingPartitions.get(date);
      if (!staged) return;
      // All required roles must have bytes for this date. Catch-up
      // replays from each subscription land in any order; we wait for
      // the slowest one before firing the worker message.
      for (const role of entry.requiredRoles) {
        if (!staged.bytes[role]) return;
      }
      entry.pendingPartitions.delete(date);
      entry.handle.postPartition(
        date,
        staged.bytes.primary,                    // legacy positional
        staged.range,
        { availability: staged.bytes.availability ?? null },
      );
    };

    for (const [role, buf] of Object.entries(effectiveBufs)) {
      if (!buf || typeof buf.subscribe !== 'function') continue;
      entry.unsubscribes[role] = buf.subscribe((payload) => {
        const bytes = payload.getArrowBytes();
        if (!bytes) return;
        let staged = entry.pendingPartitions.get(payload.date);
        if (!staged) {
          staged = { bytes: {}, range: payload.partitionRange };
          entry.pendingPartitions.set(payload.date, staged);
        }
        staged.bytes[role] = bytes;
        tryFlush(payload.date);
      });
    }
  }

  return entry;
}

/**
 * Read the precomputed frame for a (partition, step). Returns null if the
 * partition isn't ready yet — caller should fall back to its inline compute.
 *
 * @param {CacheEntry} entry
 * @param {string|null} partitionId
 * @param {number} step
 * @returns {{
 *   numSteps: number, n: number,
 *   dimColors: Float32Array, brightColors: Float32Array,
 *   widths: Float32Array, flows: Float32Array, loadings: Float32Array,
 * } | null}
 */
export function getFrame(entry, partitionId, step) {
  if (!entry || !partitionId) return null;
  const part = entry.partitions.get(partitionId);
  if (!part) return null;
  const { numSteps, n, buffers } = part;
  const s = Math.max(0, Math.min(numSteps - 1, step | 0));
  // Phase 2 fast path slices: per-feature subarrays for the current step,
  // copied by main thread into cached path objects. Slicing is guarded —
  // each layer's worker writes its own buffer set (transmission writes
  // dimColors/brightColors/widths/flows/loadings; generator writes
  // radii/innerRatios/ringPixels/fillColors/ringColors/gens/caps), so the
  // function only slices what's actually present and leaves missing fields
  // undefined for callers to ignore.
  const offRGBA = s * n * 4;
  const off     = s * n;
  const sub1 = (b) => (b ? b.subarray(off, off + n) : undefined);
  const sub4 = (b) => (b ? b.subarray(offRGBA, offRGBA + n * 4) : undefined);
  return {
    numSteps,
    n,
    step: s,
    partitionId,
    // Transmission-specific slices (undefined when worker is generator):
    dimColors:    sub4(buffers.dimColors),
    brightColors: sub4(buffers.brightColors),
    widths:       sub1(buffers.widths),
    flows:        sub1(buffers.flows),
    loadings:     sub1(buffers.loadings),
    // Generator-specific slices (undefined when worker is transmission):
    radii:        sub1(buffers.radii),
    innerRatios:  sub1(buffers.innerRatios),
    ringPixels:   sub1(buffers.ringPixels),
    fillColors:   sub4(buffers.fillColors),
    ringColors:   sub4(buffers.ringColors),
    gens:         sub1(buffers.gens),
    caps:         sub1(buffers.caps),
    // Phase 3 GPU path: whole-partition packed Float32. Layer uploads
    // this once per partition into a (n × numSteps) rgba32float texture
    // and indexes into it via (instanceFeatureIndex, currentIndex).
    // Stable reference across getFrame calls within a partition — safe
    // for layers to compare-by-identity to detect partition rollover.
    stylesPacked: buffers.stylesPacked,
    // Raw buffers for any future layer that wants its own slicing logic.
    buffers,
  };
}

/** Release a layer cache (rare — usually idle sweep handles it). */
export function release(layerId) {
  releaseEntry(layerId);
}

/**
 * Get (or lazily create) a stable scratch object hung off a cache entry.
 * Layers use this to keep deck.gl prop identity stable across renders —
 * pass the same key each tick and mutate the returned object's fields.
 *
 * @template T
 * @param {CacheEntry} entry
 * @param {string} key
 * @param {() => T} init
 * @returns {T}
 */
export function getScratch(entry, key, init) {
  if (!entry) return init();
  let v = entry.scratch.get(key);
  if (!v) {
    v = init();
    entry.scratch.set(key, v);
  }
  return v;
}
