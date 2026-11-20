/**
 * BuiltinTimeseriesPanel — popped-out version of an entity's built-in
 * timeseries chart (the one that shows in the entity tooltip when content
 * includes 'timeseries'). Wraps a LineScrubber inside a ChartFrame so the
 * popped-out chart joins the same anchor / combine / transfer pipeline as
 * extension scenario charts.
 *
 * Data is fetched fresh from the dataset stream by id so the popped frame
 * doesn't have to keep a reference to the in-memory buffer (which would
 * disappear if the user closed the source tab).
 */

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';

import { ANCHOR_MODE } from '../../lib/chartDescriptor.js';
import { getEntityWindow, prefetchEntityWindow } from '../../lib/entitySeriesCache.js';
import { pickPlayheadMs } from '../../lib/clock.js';
import ChartFrame from './ChartFrame.jsx';
import LineScrubber from '../../lib/charts/LineScrubber.jsx';
import { resolveEntityName } from '../../lib/entityName.js';

// Pop-out window default — wider than the inspector's 168 h since the
// user explicitly opened a bigger view to see more context. Still
// goes through the chunked cache, so chunks already loaded by the
// inspector are reused without a network round-trip.
const POPOUT_WINDOW_HOURS = 336;  // 14 days
const EDGE_RATCHET_FRACTION = 0.1;
const RATCHET_DEBOUNCE_MS = 200;

export default function BuiltinTimeseriesPanel({
  layerId,                   // unused at render but kept on the descriptor for transfer
  entityId,
  dsId,
  label,
  clockState,
  updateClockState,
  onClose,
  anchorMode = ANCHOR_MODE.FLOATING,
  onAnchorModeChange,
  frameKey,
  combineCandidates,
  onCombine,
  onTransfer,
  initialPos,
  geom,
  onGeomChange,
}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loadedRange, setLoadedRange] = useState(null);

  // Cursor in epoch ms — shared logic with the inspector. Same source
  // used to drive the playhead override below.
  const cursorMs = useMemo(
    () => pickPlayheadMs(clockState, []),
    [clockState?.index, clockState?.timestamps],
  );

  // Reset loaded range when the entity changes (e.g. user pops out a
  // different feature). Otherwise the panel would show the previous
  // entity's data until the new fetch lands.
  useEffect(() => {
    setLoadedRange(null);
    setData(null);
    setError(null);
  }, [dsId, entityId]);

  // Initial load + ratchet — same pattern as EntityInteractionManager
  // but with a wider default window. Most pop-out interaction is "look
  // at this entity over time", so the cache hit rate within the loaded
  // range is what makes the experience feel instant.
  useEffect(() => {
    if (!dsId || !entityId || cursorMs == null) return undefined;
    const halfMs = (POPOUT_WINDOW_HOURS / 2) * 3600 * 1000;
    const recenter = () => {
      setLoadedRange({ fromMs: cursorMs - halfMs, toMs: cursorMs + halfMs });
    };
    if (!loadedRange) {
      recenter();
      return undefined;
    }
    const padMs = (loadedRange.toMs - loadedRange.fromMs) * EDGE_RATCHET_FRACTION;
    if (cursorMs > loadedRange.toMs - padMs || cursorMs < loadedRange.fromMs + padMs) {
      const timer = setTimeout(recenter, RATCHET_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [dsId, entityId, cursorMs, loadedRange]);

  useEffect(() => {
    if (!loadedRange || !dsId || !entityId) return undefined;
    let cancelled = false;
    setError(null);
    getEntityWindow(dsId, entityId, loadedRange.fromMs, loadedRange.toMs)
      .then((ts) => { if (!cancelled) setData(ts); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    prefetchEntityWindow(dsId, entityId, loadedRange.toMs);
    return () => { cancelled = true; };
  }, [loadedRange, dsId, entityId]);

  const rows = useMemo(() => {
    if (!data?.timestamps?.length) return [];
    return data.timestamps.map((t, i) => ({
      timestamp: typeof t === 'string' ? t : t.toISOString?.() ?? new Date(t).toISOString(),
      value: data.values[i] ?? 0,
    }));
  }, [data]);

  const chartOptions = {
    time_axis: 'timestamp',
    value_axis: 'value',
    value_label: label || 'Timeseries',
    value_unit: 'MW',
    line_color: '#FF7043',
  };

  const onScrub = updateClockState
    ? (idx) => updateClockState((prev) => ({ ...prev, index: idx, animate: false }))
    : undefined;

  return (
    <ChartFrame
      // No portable descriptor for built-in timeseries today (the data
      // is buffer/stream-bound to layerId+entityId, not a portable spec).
      // Cross-window transfer of these would need a builtin-flavored
      // descriptor on the bus — leave for later.
      descriptor={{ kind: 'builtin-ts', layerId, entityId, dsId, title: label }}
      anchorMode={anchorMode}
      onAnchorModeChange={onAnchorModeChange}
      onClose={onClose}
      frameKey={frameKey}
      combineCandidates={combineCandidates}
      onCombine={onCombine}
      onTransfer={onTransfer}
      title={`${label || 'Timeseries'} — ${resolveEntityName(null, entityId) || entityId}`}
      initialFloatPosition={initialPos}
      geom={geom}
      onGeomChange={onGeomChange}
    >
      {/* Match ScenarioChartBody's sizing — flex:1 with a generous min so
          a tray/dock cell doesn't squash the chart down to its header. */}
      <Box sx={{ flex: 1, minHeight: 200, position: 'relative' }}>
        {error && (
          <Typography variant="caption" sx={{ color: 'error.main', p: 1 }}>
            Error: {error}
          </Typography>
        )}
        {!error && data == null && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={20} />
          </Box>
        )}
        {!error && data != null && (
          <LineScrubber
            data={rows}
            chartOptions={chartOptions}
            clockState={clockState}
            playheadMsOverride={cursorMs}
            onScrub={onScrub}
            fillParent
          />
        )}
      </Box>
    </ChartFrame>
  );
}
