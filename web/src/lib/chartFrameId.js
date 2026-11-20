/**
 * chartFrameId — identity helpers for ChartFrame entries.
 *
 * A "frame" hosts one or more charts of the same kind (extension scenario
 * charts, a single built-in timeseries, or a registered panel). Different
 * call sites use different identity tuples for dedup; centralizing them
 * here keeps `App.jsx`, `ChartTrayApp.jsx`, and `viewState.js` from
 * drifting apart on what counts as "the same chart".
 */

/** Generate a fresh, locally-unique frame key. */
export function makeFrameKey() {
  return `frame-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Identity tuple for a scenario chart, ignoring entity. Used by App's
 * "Charts" menu where popping the same chart twice should be a no-op.
 */
export function scenarioChartId(c) {
  return `${c.extName}::${c.spec?.name}`;
}

/**
 * Identity tuple for an entity-scoped scenario chart. Same chart for two
 * entities yields two different ids — so the user can pop one frame per
 * entity from a tooltip.
 */
export function entityChartId(c) {
  return `${c.extName}::${c.spec?.name}::${c.entityId || ''}`;
}

/** Identity tuple for a built-in entity timeseries frame. */
export function builtinFrameId(b) {
  return `builtin-ts::${b.layerId}::${b.entityId}::${b.dsId}`;
}

/**
 * Identity payload for a scenario frame, used in cross-tab transfer +
 * un-mirror messages. Returns null for non-scenario kinds (built-ins and
 * panels carry their own identity in the transfer payload).
 */
export function frameIdentity(entry) {
  if (!entry || entry.kind === 'builtin-ts' || entry.kind === 'panel') return null;
  return (entry.charts || []).map((c) => ({
    extName: c.extName,
    specName: c.spec?.name,
    entityId: c.entityId || '',
  }));
}

/**
 * Build the lookup set used for dedupe when receiving a batch of charts
 * via transfer. Each entity-scoped chart gets its own slot.
 */
export function existingChartIdSet(frames) {
  const set = new Set();
  for (const e of frames || []) {
    if (!e?.charts) continue;
    for (const c of e.charts) set.add(entityChartId(c));
  }
  return set;
}
