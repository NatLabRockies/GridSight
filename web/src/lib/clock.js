/**
 * Pick the most precise epoch-ms for the current clock index.
 *
 * The global `clockState.timestamps` array is populated by
 * TimeseriesBuffer's per-date metadata. It has the right COUNT (one entry
 * per hourly step) but each entry is a DATE STRING — they share the same
 * midnight value across all hours within the same day. Naively converting
 * `new Date(globalTs[idx]).getTime()` collapses every hour in a day to
 * midnight, so any positioning derived from it (playhead, formatted time
 * readout, click-to-scrub) snaps to the wrong instant. In a UTC-7 locale
 * that midnight-UTC value displays as "previous day 17:00".
 *
 * When the chart's own series has the same number of entries as the
 * global clock — true for entity-scoped full-horizon series — its local
 * `sortedTimestampMs` has hour-level precision and we should prefer it.
 *
 * @param {{index: number, timestamps?: string[]}} clockState
 * @param {number[]|undefined} localSortedMs  optional chart-local
 *   ascending-sorted epoch-ms array (1:1 with the global clock when
 *   lengths match — that's the trigger for using it).
 * @returns {number|null} epoch-ms, or null if neither source resolves.
 */
/**
 * Map a clicked epoch-ms value to the right global clock index.
 *
 * Direct binary search on `clockState.timestamps` doesn't work — that
 * array is hourly-counted but each entry is the date STRING (so 24
 * consecutive entries hold the same midnight ms). A naive ms search
 * therefore returns the index of midnight-of-day-X for any click within
 * that day, snapping the playhead to UTC midnight (= prev day 17:00 in
 * UTC-7) regardless of the hour the user clicked.
 *
 * Approach: find the first occurrence of the clicked-ms's local date in
 * the timestamps array (= start of that day's hourly run), then add the
 * hour-within-day. Works whether the chart's local series matches the
 * global clock length or not — robust for aggregated charts where the
 * binary-search-on-local fallback would otherwise fail.
 *
 * @param {number} xMs
 * @param {{timestamps?: string[]}} clockState
 * @returns {number} 0..(clockState.timestamps.length-1), clamped.
 */
export function clickedMsToGlobalIndex(xMs, clockState) {
  const ts = clockState?.timestamps;
  if (!Array.isArray(ts) || !ts.length) return 0;
  if (!Number.isFinite(xMs)) return 0;

  // Target local date as ISO "YYYY-MM-DD" prefix.
  const d = new Date(xMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const isoDate = `${y}-${m}-${dd}`;

  // Walk to the first entry that begins with this date. The array can
  // be huge (8760+) but this scan only runs on click — not per frame.
  let dayStart = -1;
  let dayEndExclusive = ts.length;
  for (let i = 0; i < ts.length; i++) {
    const s = ts[i];
    if (s && typeof s === "string" && s.startsWith(isoDate)) {
      dayStart = i;
      // Find the run end (next index whose date prefix differs).
      for (let j = i + 1; j < ts.length; j++) {
        if (!ts[j] || !ts[j].startsWith(isoDate)) {
          dayEndExclusive = j;
          break;
        }
      }
      break;
    }
  }
  if (dayStart < 0) {
    // Click outside the clock's date range. Snap to nearest end.
    const firstMs = new Date(d.getFullYear(), 0, 1).getTime();
    return xMs < firstMs ? 0 : ts.length - 1;
  }

  // Hour within day, in local time. Day count may be less than 24
  // (e.g. partial first/last day) so clamp to the actual run length.
  const dayLocalMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const hoursIntoDay = Math.floor((xMs - dayLocalMidnight) / 3_600_000);
  const dayCount = dayEndExclusive - dayStart;
  const hourOffset = Math.max(0, Math.min(dayCount - 1, hoursIntoDay));
  return dayStart + hourOffset;
}


export function pickPlayheadMs(clockState, localSortedMs) {
  const idx = clockState?.index ?? 0;
  if (idx < 0) return null;
  const globalTs = clockState?.timestamps;

  // Primary path: derive hour-precise ms from `clockState.timestamps`
  // directly. The array stores the date string repeated once per hourly
  // step within that day (24 copies of "2019-06-15"). The first such
  // occurrence is the start of that day's hourly run; the hour offset
  // is `idx - dayStart`. Parsing the date as LOCAL midnight (via the
  // y/m/d-component constructor, not the string constructor) avoids
  // the UTC-shift bug where "2019-06-15" → UTC midnight → prev-day-17:00
  // in UTC-7. This works regardless of whether the chart's local series
  // length matches the global clock length.
  if (Array.isArray(globalTs) && idx < globalTs.length) {
    const dateStr = globalTs[idx];
    if (typeof dateStr === 'string') {
      let dayStart = idx;
      while (dayStart > 0 && globalTs[dayStart - 1] === dateStr) dayStart--;
      const hourOffset = idx - dayStart;
      const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        return new Date(+m[1], +m[2] - 1, +m[3], hourOffset).getTime();
      }
      // Last-ditch: trust whatever Date can parse (ISO with T+timezone).
      const fallback = new Date(dateStr).getTime();
      if (Number.isFinite(fallback)) return fallback + hourOffset * 3_600_000;
    }
  }

  // Fallback: chart-local hour-precise series, if matching length. Useful
  // when callers don't have `clockState.timestamps` populated yet.
  const local = localSortedMs;
  if (Array.isArray(local) && local.length && idx < local.length
      && (!globalTs || globalTs.length === local.length)) {
    return local[idx];
  }
  return null;
}
