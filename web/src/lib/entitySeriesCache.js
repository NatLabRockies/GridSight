/**
 * entitySeriesCache.js
 *
 * Chunked, LRU-bounded cache for single-entity timeseries windows.
 *
 * Why this exists: the entity-inspector chart fetches a rolling window
 * (default 72 h centered on the animation cursor) every time the user
 * clicks or the clock advances. Without caching that's one server
 * request per clock tick — wasteful on a chart that mostly re-reads
 * the same data. With chunked caching, only the chunks that contain
 * the new window edge get fetched; the rest come from RAM.
 *
 * Time is bucketed into fixed CHUNK_HOURS buckets aligned to UTC
 * midnight. Cache key = ``${datasetId}:${entityId}:${chunkStartIso}``.
 * Each entry stores ``{timestamps: string[], values: (number|null)[]}``
 * for that chunk's worth of data. The cache is process-wide (module
 * singleton); LRU eviction keeps total entries under MAX_ENTRIES.
 *
 * The public ``getEntityWindow`` resolves a requested ``[from, to]``
 * window to its covering chunk set, fetches any missing chunks in
 * parallel, and returns the concatenated slice. Repeat calls for
 * overlapping windows touch the network only for newly-needed chunks.
 */

import { fetchEntitySeriesWindow } from './loaders.js';

/** Width of a cache bucket in hours. 24 h matches the underlying
 * Parquet partition granularity so a typical chunk fetch maps to one
 * partition's worth of column data. */
const CHUNK_HOURS = 24;

/** Hard cap on cached chunks. ~1000 = 24,000 hours of data across all
 * entities — plenty for inspector use. LRU evicts the least recently
 * read chunk. */
const MAX_ENTRIES = 1000;

/** @type {Map<string, {timestamps: string[], values: (number|null)[]}>} */
const _cache = new Map();
/** @type {Map<string, Promise<{timestamps: string[], values: (number|null)[]}>>} */
const _inflight = new Map();

const MS_PER_HOUR = 3600 * 1000;
const CHUNK_MS = CHUNK_HOURS * MS_PER_HOUR;

function _chunkStartMs(tsMs) {
  return Math.floor(tsMs / CHUNK_MS) * CHUNK_MS;
}

function _isoFromMs(ms) {
  // Server expects ISO without TZ — we stored timestamps as local
  // ISO strings already in the wide-format table, so generate the same
  // shape here. Truncate millis.
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function _cacheKey(datasetId, entityId, chunkStartMs) {
  return `${datasetId}:${entityId}:${chunkStartMs}`;
}

function _touchLRU(key, value) {
  // Map preserves insertion order — re-insert to move to "most recent".
  _cache.delete(key);
  _cache.set(key, value);
  while (_cache.size > MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

/**
 * Fetch a contiguous run of chunks in a SINGLE request. The server
 * runs one DuckDB column-projection query and returns one Arrow
 * stream; we slice that into per-chunk cache entries client-side.
 *
 * Sharing the per-chunk inflight map means a later overlapping window
 * doesn't re-fetch chunks that are already in flight.
 */
async function _fetchRun(datasetId, entityId, startMs, endMs) {
  const fromIso = _isoFromMs(startMs);
  const toIso = _isoFromMs(endMs + CHUNK_MS - 1000);
  const table = await fetchEntitySeriesWindow(datasetId, entityId, fromIso, toIso);

  // Distribute rows into per-chunk buckets.
  const tsCol = table.getChild('timestamp');
  const valCol = table.getChild('value');
  const buckets = new Map();
  for (let c = startMs; c <= endMs; c += CHUNK_MS) {
    buckets.set(c, { timestamps: [], values: [] });
  }
  const n = table.numRows;
  for (let i = 0; i < n; i++) {
    const tRaw = tsCol?.get(i);
    if (tRaw == null) continue;
    const tStr = String(tRaw);
    const tMs = Date.parse(tStr);
    if (Number.isNaN(tMs)) continue;
    const chunkStart = _chunkStartMs(tMs);
    const bucket = buckets.get(chunkStart);
    if (!bucket) continue;
    bucket.timestamps.push(tStr);
    const v = valCol?.get(i);
    bucket.values.push(v == null ? null : Number(v));
  }
  // Persist each chunk in the LRU cache so future windows that
  // overlap any of these days hit RAM.
  for (const [chunkStart, entry] of buckets) {
    const key = _cacheKey(datasetId, entityId, chunkStart);
    _touchLRU(key, entry);
  }
  return buckets;
}

/** Mark a chunk in-flight, resolving it from the run-level fetch
 * promise when that arrives. Keeps the dedupe semantics intact even
 * when the user issues overlapping window requests. */
function _markInflight(datasetId, entityId, chunkStartMs, runPromise) {
  const key = _cacheKey(datasetId, entityId, chunkStartMs);
  if (_inflight.has(key)) return;
  const chunkPromise = runPromise
    .then((buckets) => buckets.get(chunkStartMs) ?? { timestamps: [], values: [] })
    .finally(() => { _inflight.delete(key); });
  _inflight.set(key, chunkPromise);
}

/**
 * Fetch one entity's data for ``[fromMs, toMs]``, going through the
 * chunked cache. Returns ``{timestamps: Date[], values: number[]}``
 * with at most one point per source timestep inside the window.
 *
 * @param {number} datasetId
 * @param {string} entityId
 * @param {number} fromMs   inclusive epoch milliseconds
 * @param {number} toMs     inclusive epoch milliseconds
 * @returns {Promise<{timestamps: Date[], values: number[]}>}
 */
export async function getEntityWindow(datasetId, entityId, fromMs, toMs) {
  if (toMs < fromMs) return { timestamps: [], values: [] };

  const firstChunk = _chunkStartMs(fromMs);
  const lastChunk = _chunkStartMs(toMs);
  const allChunks = [];
  for (let c = firstChunk; c <= lastChunk; c += CHUNK_MS) {
    allChunks.push(c);
  }

  // Categorize each chunk: cached / inflight / missing.
  /** @type {Map<number, Promise<{timestamps:string[], values:(number|null)[]}>>} */
  const promises = new Map();
  /** @type {number[]} */
  const missing = [];
  for (const c of allChunks) {
    const key = _cacheKey(datasetId, entityId, c);
    const cached = _cache.get(key);
    if (cached) {
      _touchLRU(key, cached);
      promises.set(c, Promise.resolve(cached));
      continue;
    }
    const inflight = _inflight.get(key);
    if (inflight) {
      promises.set(c, inflight);
      continue;
    }
    missing.push(c);
  }

  // Coalesce missing chunks into contiguous runs so each run = ONE
  // server request that covers many days. Without this, a 7-day cold
  // load fired 7 separate HTTP calls + 7 DuckDB queries; now it's 1.
  /** @type {Array<{start:number, end:number}>} */
  const runs = [];
  for (const c of missing) {
    const last = runs[runs.length - 1];
    if (last && last.end + CHUNK_MS === c) {
      last.end = c;
    } else {
      runs.push({ start: c, end: c });
    }
  }
  // Fire one fetch per run; pre-register in-flight promises per chunk
  // so a concurrent request for an overlapping window joins this fetch
  // instead of issuing a duplicate.
  for (const run of runs) {
    const runPromise = _fetchRun(datasetId, entityId, run.start, run.end);
    for (let c = run.start; c <= run.end; c += CHUNK_MS) {
      _markInflight(datasetId, entityId, c, runPromise);
      promises.set(c, runPromise.then(
        (buckets) => buckets.get(c) ?? { timestamps: [], values: [] }
      ));
    }
  }

  const chunkEntries = await Promise.all(
    allChunks.map((c) => promises.get(c)),
  );

  // Stitch + clip to the precise [fromMs, toMs] window. Chunks at the
  // edges may include points outside the requested range.
  const outTs = [];
  const outVals = [];
  for (const chunk of chunkEntries) {
    for (let i = 0; i < chunk.timestamps.length; i++) {
      const tMs = Date.parse(chunk.timestamps[i]);
      if (Number.isNaN(tMs)) continue;
      if (tMs < fromMs || tMs > toMs) continue;
      outTs.push(new Date(tMs));
      outVals.push(chunk.values[i] == null ? 0 : chunk.values[i]);
    }
  }
  return { timestamps: outTs, values: outVals };
}

/**
 * Fire-and-forget prefetch for the next chunk(s). Call from playback
 * code when the cursor is near a chunk boundary so the data is warm by
 * the time the visible window crosses into it.
 *
 * @param {number} datasetId
 * @param {string} entityId
 * @param {number} aroundMs   epoch ms of the cursor
 * @param {number} aheadHours how far ahead to warm; defaults to one chunk
 */
export function prefetchEntityWindow(
  datasetId, entityId, aroundMs, aheadHours = CHUNK_HOURS,
) {
  // Reuses ``getEntityWindow`` so prefetch enjoys the same run
  // coalescing — a multi-chunk prefetch is one server request.
  getEntityWindow(datasetId, entityId, aroundMs, aroundMs + aheadHours * MS_PER_HOUR)
    .catch(() => { /* swallow */ });
}

/** Clear all cached chunks. Intended for tests + scenario switches. */
export function clearEntitySeriesCache() {
  _cache.clear();
  _inflight.clear();
}

/** For tests. */
export const __testing__ = {
  CHUNK_HOURS,
  CHUNK_MS,
  MAX_ENTRIES,
  cacheSize: () => _cache.size,
};
