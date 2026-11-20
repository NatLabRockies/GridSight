/**
 * TimeseriesBuffer
 *
 * A client-side circular buffer for wide-format timeseries data streamed
 * as Arrow IPC partitions from the server.
 *
 * "Wide" format: rows = timesteps, columns = entity IDs (e.g. generator IDs).
 * One date partition = one Arrow Table covering a calendar day.
 *
 * Usage:
 *   const buf = new TimeseriesBuffer(datasetId, timestampCol);
 *   await buf.init();                         // loads first partition + metadata
 *   const data = buf.getDataAtIndex(42);      // Map<entityId -> value>
 */

import { fetchDatasetPartitions, streamDatasetPartition } from './loaders.js';

// apache-arrow is loaded lazily on first use to avoid Rollup/Vite
// production-build issues with the package's ESM module graph.
let _tableFromIPC = null;
async function getTableFromIPC() {
  if (!_tableFromIPC) {
    const mod = await import('apache-arrow');
    _tableFromIPC = mod.tableFromIPC;
  }
  return _tableFromIPC;
}

/** Number of date partitions to keep in memory simultaneously. */
const BUFFER_SIZE = 7;

/** Start prefetching the next partition when this fraction through the current one. */
const PREFETCH_THRESHOLD = 0.8;

export class TimeseriesBuffer {
  /**
   * @param {number} datasetId    – Dataset.id from the DB
   * @param {string} timestampCol – name of the timestamp column (excluded from entity columns)
   */
  constructor(datasetId, timestampCol) {
    this.datasetId = datasetId;
    this.timestampCol = timestampCol;

    /** @type {Map<string, import('apache-arrow').Table>} date_str → Arrow Table */
    this.buffer = new Map();
    /**
     * Vector handles per partition, aligned with `entityColumns`. Resolved
     * once at partition load (one `Table.getChild` per column) and reused
     * for every tick — `getChild` is a hashmap lookup that we'd otherwise
     * pay N times per tick at 5 ticks/s, which adds up to a frame's worth
     * of pure JS for 100 K-entity datasets.
     * @type {Map<string, Array<import('apache-arrow').Vector|null>>}
     */
    this._vectorsByDate = new Map();
    /** @type {string[]} sorted date strings */
    this.dates = [];
    /** @type {string[]} non-timestamp column names */
    this.entityColumns = [];
    /** @type {Record<string, number>} date → row count */
    this.rowCounts = {};
    /** @type {Record<string, number>} date → cumulative row offset (global index of first row) */
    this.dateOffsets = {};
    /** @type {number} */
    this.totalRows = 0;

    /**
     * The latest row of entity data, updated in-place by getDataAtIndex().
     * Map<entityId → number>.  Layer generators read this directly.
     * @type {Map<string, number>}
     */
    this.currentValues = new Map();

    /**
     * Monotonically increasing counter bumped every time currentValues changes.
     * Used as a cheap deck.gl updateTrigger.
     * @type {number}
     */
    this.version = 0;

    /** Partitions currently being fetched (avoid duplicate in-flight requests). */
    this._prefetching = new Set();

    /**
     * Raw Arrow IPC bytes per loaded partition. Kept alongside the parsed
     * table so workers (Phase 2 LayerWorkerPool) can re-receive bytes on
     * demand without an extra network round-trip. Evicted in lockstep with
     * `buffer`.
     * @type {Map<string, Uint8Array>}
     */
    this._partitionBytes = new Map();

    /**
     * Subscribers fired on partition load. Each callback receives:
     *   { date, dateIndex, partitionRange: { startGlobalIndex, length },
     *     getArrowBytes() => ArrayBuffer (fresh transferable copy) }
     * Used by per-layer workers to receive raw Arrow IPC bytes for whole-
     * partition precompute.
     * @type {Set<Function>}
     */
    this._subscribers = new Set();

    /** Last-resolved partition state from getDataAtIndex (for layers to read). */
    this.currentDate = null;
    this.currentRow = 0;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch partition metadata and load the first partition.
   * Must be called before any getDataAtIndex() calls.
   * @returns {Promise<TimeseriesBuffer>} this (for chaining)
   */
  async init() {
    const info = await fetchDatasetPartitions(this.datasetId);
    this.dates = info.dates ?? [];
    this.entityColumns = info.entity_columns ?? [];
    this.rowCounts = info.row_counts ?? {};

    // Compute cumulative offsets so we can map a global index → (date, row).
    let offset = 0;
    for (const date of this.dates) {
      this.dateOffsets[date] = offset;
      offset += this.rowCounts[date] ?? 0;
    }
    this.totalRows = offset;

    // Eagerly load the first partition so the first render is instant.
    if (this.dates.length > 0) {
      await this._loadPartition(this.dates[0]);
    }
    return this;
  }

  /**
   * Return entity data for a global clock index as Map<entityId → value>.
   * Also schedules prefetch of the next partition.
   *
   * Returns null if the partition for this index is not yet loaded.
   *
   * @param {number} globalIndex
   * @returns {Map<string, number>|null}
   */
  getDataAtIndex(globalIndex) {
    if (!this.dates.length) return null;

    const clamped = Math.max(0, Math.min(this.totalRows - 1, globalIndex));
    const { date, row } = this._globalIndexToDateRow(clamped);
    this.currentDate = date;
    this.currentRow = row;

    // Bidirectional prefetch around the current index — covers both
    // sequential animation (forward) and scrub-around-the-region (both
    // sides). For small datasets the cap means we end up with the whole
    // dataset in memory after one read; for large datasets we hold a
    // sliding window inside the LRU buffer.
    this.prefetchAround(clamped, 3);
    // Extra forward-bias when nearing the partition boundary (helps the
    // playhead-during-animation case land the next day before we cross).
    const dateIdx = this.dates.indexOf(date);
    const partitionRows = this.rowCounts[date] || 1;
    const progress = row / partitionRows;
    if (dateIdx >= 0 && progress >= 0.95 && dateIdx + 2 < this.dates.length) {
      this._loadPartition(this.dates[dateIdx + 2]);
    }

    const table = this.buffer.get(date);
    if (!table) {
      this._loadPartition(date);
      return false;
    }

    // Update currentValues in-place from the Arrow row. Iterate the cached
    // vector handles by index instead of doing `table.getChild(col)` per
    // column — that hashmap lookup repeated N times per tick is the bulk
    // of getDataAtIndex's main-thread cost on large entity sets.
    // Don't `clear()` either: keys are stable across ticks, so reusing
    // existing slots avoids the rehash work on every tick.
    const vectors = this._vectorsByDate.get(date);
    const cols = this.entityColumns;
    if (vectors) {
      for (let i = 0; i < cols.length; i++) {
        const v = vectors[i];
        if (!v) continue;
        const raw = v.get(row);
        this.currentValues.set(cols[i], raw == null ? 0 : Number(raw));
      }
    } else {
      for (const col of cols) {
        const vector = table.getChild(col);
        if (vector) {
          const val = vector.get(row);
          this.currentValues.set(col, val == null ? 0 : Number(val));
        }
      }
    }
    this.version++;
    return true;
  }

  /**
   * Return the timestamp string for a global clock index.
   * Reads the timestamp column from the Arrow partition table.
   * Falls back to the partition date string if the column is missing or not loaded.
   * @param {number} globalIndex
   * @returns {string}
   */
  getTimestampAtIndex(globalIndex) {
    if (!this.dates.length) return "";
    const clamped = Math.max(0, Math.min(this.totalRows - 1, globalIndex));
    const { date, row } = this._globalIndexToDateRow(clamped);
    const table = this.buffer.get(date);
    if (!table) return date;
    const vector = table.getChild(this.timestampCol);
    if (!vector) return date;
    const val = vector.get(row);
    if (val == null) return date;
    // Arrow may return a Date object or a bigint (timestamp nanos); coerce to ISO string.
    if (val instanceof Date) return val.toISOString();
    if (typeof val === "bigint") return new Date(Number(val / 1000000n)).toISOString();
    if (typeof val === "number") return new Date(val).toISOString();
    return String(val);
  }

  /**
   * Prefetch partitions around a global index — the partition containing
   * the index AND `radius` partitions on each side. Use this when the
   * user is likely to scrub nearby (e.g. clicking a chart, opening the
   * animation panel). Returns immediately and loads in the background.
   *
   * For small datasets the cap is the buffer size (BUFFER_SIZE) — for an
   * 8760-style dataset where days vastly exceed the buffer, prefetching
   * everything would thrash the LRU eviction.
   *
   * @param {number} globalIndex
   * @param {number} [radius=3]
   */
  prefetchAround(globalIndex, radius = 3) {
    if (!this.dates.length) return;
    const clamped = Math.max(0, Math.min(this.totalRows - 1, globalIndex));
    const { date } = this._globalIndexToDateRow(clamped);
    const center = this.dates.indexOf(date);
    if (center < 0) return;
    // Stay within the buffer window so we don't immediately evict what
    // we just loaded.
    const halfBuf = Math.floor(BUFFER_SIZE / 2);
    const r = Math.min(radius, halfBuf);
    const lo = Math.max(0, center - r);
    const hi = Math.min(this.dates.length - 1, center + r);
    for (let i = lo; i <= hi; i++) {
      this._loadPartition(this.dates[i]);
    }
  }

  /**
   * Ensure the Arrow partition containing `globalIndex` is loaded. If it's
   * already cached (or in-flight), the returned promise resolves as soon as
   * the in-flight fetch completes. Otherwise fetches it.
   *
   * Used by the scrub path: when the user jumps to an index whose partition
   * wasn't prefetched by sequential animation, we need to fetch it before
   * the map can show the right frame.
   *
   * @param {number} globalIndex
   * @returns {Promise<boolean>} true if partition is now loaded, false otherwise
   */
  async ensurePartitionLoaded(globalIndex) {
    if (!this.dates.length) return false;
    const clamped = Math.max(0, Math.min(this.totalRows - 1, globalIndex));
    const { date } = this._globalIndexToDateRow(clamped);
    if (this.buffer.has(date)) return true;
    await this._loadPartition(date);
    return this.buffer.has(date);
  }

  /**
   * Replace currentValues from an external source (e.g. scrub-mode row fetch).
   * Bumps version so deck.gl picks up the change.
   * @param {Record<string, number>} rowObj  – { entityId: value, ... }
   */
  setCurrentValues(rowObj) {
    this.currentValues.clear();
    for (const [key, val] of Object.entries(rowObj)) {
      if (typeof val === 'number') this.currentValues.set(key, val);
    }
    this.version++;
  }

  /**
   * Aggregate currentValues by category using a category mapping.
   *
   * @param {Map<string, string>} entityToCategory – Map<entityId → categoryName>
   * @param {string} [mode='sum'] – 'sum', 'mean', or 'max'
   * @returns {Map<string, number>} Map<categoryName → aggregated value>
   */
  getCategoryAggregation(entityToCategory, mode = 'sum') {
    const result = new Map();
    const counts = new Map();
    for (const [entityId, value] of this.currentValues) {
      const category = entityToCategory.get(entityId);
      if (category === undefined) continue;
      const prev = result.get(category) ?? 0;
      if (mode === 'max') {
        result.set(category, Math.max(prev, value));
      } else {
        result.set(category, prev + value);
      }
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    if (mode === 'mean') {
      for (const [cat, sum] of result) {
        result.set(cat, sum / (counts.get(cat) || 1));
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Map a global row index to { date, row } within that partition.
   * Uses binary search over this.dates.
   * @param {number} idx
   * @returns {{ date: string, row: number }}
   */
  _globalIndexToDateRow(idx) {
    const dates = this.dates;
    let lo = 0;
    let hi = dates.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.dateOffsets[dates[mid]] <= idx) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const date = dates[lo];
    return { date, row: idx - this.dateOffsets[date] };
  }

  /**
   * Fetch and cache a partition. No-ops if already cached or in-flight.
   * @param {string} dateStr
   */
  async _loadPartition(dateStr) {
    if (this.buffer.has(dateStr) || this._prefetching.has(dateStr)) return;
    this._prefetching.add(dateStr);
    try {
      const [tableFromIPC, bytes] = await Promise.all([
        getTableFromIPC(),
        streamDatasetPartition(this.datasetId, dateStr),
      ]);
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const table = tableFromIPC(u8);
      this.buffer.set(dateStr, table);
      this._partitionBytes.set(dateStr, u8);
      // Resolve column vectors once per partition (aligned with
      // entityColumns) so the per-tick read loop doesn't pay getChild.
      const vectors = new Array(this.entityColumns.length);
      for (let i = 0; i < this.entityColumns.length; i++) {
        vectors[i] = table.getChild(this.entityColumns[i]) ?? null;
      }
      this._vectorsByDate.set(dateStr, vectors);
      this._evict();
      this._notifyPartitionLoaded(dateStr);
    } catch (e) {
      console.warn(`[TimeseriesBuffer] failed to load partition ${dateStr}:`, e);
    } finally {
      this._prefetching.delete(dateStr);
    }
  }

  /** Evict the oldest partition when the buffer exceeds BUFFER_SIZE. */
  _evict() {
    const keys = [...this.buffer.keys()];
    while (keys.length > BUFFER_SIZE) {
      const k = keys.shift();
      this.buffer.delete(k);
      this._partitionBytes.delete(k);
      this._vectorsByDate.delete(k);
    }
  }

  // ---------------------------------------------------------------------------
  // Partition-load subscriptions (for layer workers, Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to partition-load events. Fires once per loaded partition
   * (immediately for any already-loaded partitions at subscribe time).
   *
   * Callback receives:
   *   {
   *     date: string,                                  // partition key
   *     dateIndex: number,                             // index in this.dates
   *     partitionRange: { startGlobalIndex, length },  // global-index span
   *     getArrowBytes(): ArrayBuffer                   // fresh transferable copy
   *   }
   *
   * @param {(payload: object) => void} cb
   * @returns {() => void} unsubscribe
   */
  subscribe(cb) {
    this._subscribers.add(cb);
    // Catch-up: fire for all already-loaded partitions in load order.
    for (const date of this._partitionBytes.keys()) {
      try { cb(this._buildPartitionPayload(date)); } catch (e) {
        console.warn('[TimeseriesBuffer] subscriber catch-up error:', e);
      }
    }
    return () => this._subscribers.delete(cb);
  }

  _buildPartitionPayload(date) {
    const dateIndex = this.dates.indexOf(date);
    const startGlobalIndex = this.dateOffsets[date] ?? 0;
    const length = this.rowCounts[date] ?? 0;
    const u8 = this._partitionBytes.get(date);
    const getArrowBytes = () => {
      if (!u8) return null;
      // Slice into a fresh ArrayBuffer so each consumer can transfer
      // ownership to its worker without affecting other subscribers.
      const out = new Uint8Array(u8.byteLength);
      out.set(u8);
      return out.buffer;
    };
    return {
      date,
      dateIndex,
      partitionRange: { startGlobalIndex, length },
      getArrowBytes,
    };
  }

  _notifyPartitionLoaded(date) {
    if (!this._subscribers.size) return;
    const payload = this._buildPartitionPayload(date);
    for (const cb of this._subscribers) {
      try { cb(payload); } catch (e) {
        console.warn('[TimeseriesBuffer] subscriber error:', e);
      }
    }
  }
}
