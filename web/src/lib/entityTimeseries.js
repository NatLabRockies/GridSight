/**
 * entityTimeseries.js
 *
 * Utilities for extracting, windowing, and transforming a single entity's
 * timeseries data — used by the entity interaction popup/panel charts.
 */

import { fetchEntityTimeseries as fetchFromServer } from './loaders.js';

// ---------------------------------------------------------------------------
// Fetch full entity timeseries from server
// ---------------------------------------------------------------------------

/**
 * Fetch the complete timeseries for one entity from the server.
 * Returns parsed Date objects + numeric values.
 *
 * @param {number} datasetId
 * @param {string} entityId
 * @returns {Promise<{ timestamps: Date[], values: number[] }>}
 */
export async function fetchEntityTimeseries(datasetId, entityId, { signal } = {}) {
  const raw = await fetchFromServer(datasetId, entityId, { signal });
  return {
    timestamps: (raw.timestamps ?? []).map((t) => new Date(t)),
    values: raw.values ?? [],
  };
}

// ---------------------------------------------------------------------------
// Extract from loaded Arrow buffer (no network)
// ---------------------------------------------------------------------------

/**
 * Extract an entity's data from already-loaded Arrow partitions in the
 * TimeseriesBuffer.  Only returns data for partitions currently in memory.
 *
 * @param {import('./TimeseriesBuffer.js').TimeseriesBuffer} buffer
 * @param {string} entityId      – column name in Arrow tables
 * @param {string[]} timestamps  – clockState.timestamps (full array, ISO strings)
 * @returns {{ timestamps: Date[], values: number[] }}
 */
export function extractEntityFromBuffer(buffer, entityId, timestamps) {
  const ts = [];
  const vals = [];
  const tsCol = buffer.timestampCol;

  for (const date of buffer.dates) {
    const table = buffer.buffer.get(date);
    if (!table) continue;

    const vector = table.getChild(entityId);
    if (!vector) continue;

    // Prefer actual timestamps from the Arrow table's datetime column
    const tsVector = tsCol ? table.getChild(tsCol) : null;
    const offset = buffer.dateOffsets[date];
    const numRows = table.numRows;

    for (let i = 0; i < numRows; i++) {
      if (tsVector) {
        const rawTs = tsVector.get(i);
        ts.push(rawTs instanceof Date ? rawTs : new Date(rawTs));
      } else {
        // Fallback to clockState.timestamps
        const globalIdx = offset + i;
        if (globalIdx < timestamps.length) {
          ts.push(new Date(timestamps[globalIdx]));
        }
      }
      const v = vector.get(i);
      vals.push(v === null || v === undefined ? 0 : Number(v));
    }
  }

  return { timestamps: ts, values: vals };
}

// ---------------------------------------------------------------------------
// Windowed view
// ---------------------------------------------------------------------------

/**
 * Return a slice of the timeseries centered on the current animation index.
 *
 * - If the user's animation loop window (endIndex - startIndex) is <= 2 * defaultDelta,
 *   the entire loop window is returned.
 * - Otherwise, a window of [currentIndex - delta, currentIndex + delta] is returned.
 *
 * @param {{ timestamps: Date[], values: number[] }} series
 * @param {number} currentIndex   – clockState.index (global)
 * @param {number} startIndex     – clockState.startIndex
 * @param {number} endIndex       – clockState.endIndex
 * @param {number} defaultDelta   – half-window size in timesteps (e.g. 168 for 1 week hourly)
 * @returns {{ timestamps: Date[], values: number[], currentLocalIndex: number }}
 */
export function windowedView(series, currentIndex, startIndex, endIndex, defaultDelta) {
  if (!series.timestamps.length) {
    return { timestamps: [], values: [], currentLocalIndex: 0 };
  }

  const loopSize = endIndex - startIndex;

  let winStart, winEnd;
  if (loopSize <= 2 * defaultDelta) {
    // Narrowed loop — show the full window
    winStart = startIndex;
    winEnd = endIndex;
  } else {
    // Default — center on current time
    winStart = Math.max(0, currentIndex - defaultDelta);
    winEnd = Math.min(series.timestamps.length - 1, currentIndex + defaultDelta);
  }

  // Clamp to available data
  winStart = Math.max(0, winStart);
  winEnd = Math.min(series.timestamps.length - 1, winEnd);

  const timestamps = series.timestamps.slice(winStart, winEnd + 1);
  const values = series.values.slice(winStart, winEnd + 1);
  const currentLocalIndex = Math.max(0, Math.min(timestamps.length - 1, currentIndex - winStart));

  return { timestamps, values, currentLocalIndex };
}

// ---------------------------------------------------------------------------
// Heatmap reshape
// ---------------------------------------------------------------------------

/**
 * Day-of-year from a Date (1-based).
 * @param {Date} d
 * @returns {number}
 */
function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d - start;
  return Math.floor(diff / 86400000);
}

/**
 * Compute the time-bin index for a Date given a bin mode.
 *
 * @param {Date} d
 * @param {'hour'|'minute'|'4hour'|'15min'} binMode
 * @returns {number}
 */
function timeBin(d, binMode) {
  const h = d.getHours();
  const m = d.getMinutes();
  switch (binMode) {
    case 'hour':
      return h;
    case 'minute':
      return h * 60 + m;
    case '4hour':
      return Math.floor(h / 4);
    case '15min':
      return Math.floor((h * 60 + m) / 15);
    default:
      return h;
  }
}

/**
 * Number of bins on the Y-axis for a given bin mode.
 * @param {'hour'|'minute'|'4hour'|'15min'} binMode
 * @returns {number}
 */
export function timeBinCount(binMode) {
  switch (binMode) {
    case 'hour':
      return 24;
    case 'minute':
      return 1440;
    case '4hour':
      return 6;
    case '15min':
      return 96;
    default:
      return 24;
  }
}

/**
 * Label for a Y-axis bin value.
 * @param {number} bin
 * @param {'hour'|'minute'|'4hour'|'15min'} binMode
 * @returns {string}
 */
export function timeBinLabel(bin, binMode) {
  switch (binMode) {
    case 'hour':
      return `${String(bin).padStart(2, '0')}:00`;
    case 'minute':
      return `${String(Math.floor(bin / 60)).padStart(2, '0')}:${String(bin % 60).padStart(2, '0')}`;
    case '4hour':
      return `${String(bin * 4).padStart(2, '0')}:00`;
    case '15min': {
      const totalMin = bin * 15;
      return `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`;
    }
    default:
      return String(bin);
  }
}

/**
 * Reshape a timeseries into a heatmap grid: X = day-of-year, Y = time bin.
 *
 * @param {Date[]} timestamps
 * @param {number[]} values
 * @param {'hour'|'minute'|'4hour'|'15min'} binMode
 * @returns {{ data: Array<{x: number, y: number, v: number}>, vMin: number, vMax: number }}
 */
export function reshapeToHeatmap(timestamps, values, binMode) {
  // Accumulator: key = "doy-bin", value = { sum, count }
  const acc = new Map();
  let vMin = Infinity;
  let vMax = -Infinity;

  for (let i = 0; i < timestamps.length; i++) {
    const v = values[i];
    if (v == null) continue;

    const doy = dayOfYear(timestamps[i]);
    const bin = timeBin(timestamps[i], binMode);
    const key = `${doy}-${bin}`;

    const existing = acc.get(key);
    if (existing) {
      existing.sum += v;
      existing.count++;
    } else {
      acc.set(key, { doy, bin, sum: v, count: 1 });
    }
  }

  const data = [];
  for (const { doy, bin, sum, count } of acc.values()) {
    const avg = sum / count;
    data.push({ x: doy, y: bin, v: avg });
    if (avg < vMin) vMin = avg;
    if (avg > vMax) vMax = avg;
  }

  return { data, vMin: vMin === Infinity ? 0 : vMin, vMax: vMax === -Infinity ? 0 : vMax };
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

/**
 * Compute a histogram from an array of values.
 *
 * @param {number[]} values
 * @param {number} [numBins=50]
 * @returns {{ edges: number[], counts: number[] }}
 */
export function computeHistogram(values, numBins = 50) {
  if (!values.length) return { edges: [], counts: [] };

  const filtered = values.filter((v) => v != null && isFinite(v));
  if (!filtered.length) return { edges: [], counts: [] };

  const min = Math.min(...filtered);
  const max = Math.max(...filtered);

  if (min === max) {
    return { edges: [min, min + 1], counts: [filtered.length] };
  }

  const binWidth = (max - min) / numBins;
  const edges = [];
  const counts = new Array(numBins).fill(0);

  for (let i = 0; i <= numBins; i++) {
    edges.push(min + i * binWidth);
  }

  for (const v of filtered) {
    let bin = Math.floor((v - min) / binWidth);
    if (bin >= numBins) bin = numBins - 1;
    counts[bin]++;
  }

  return { edges, counts };
}
