import { useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import VegaLiteRenderer from './VegaLiteRenderer.jsx';
import { windowedView } from '../../lib/entityTimeseries.js';

// Vega-Lite paints a y-axis label band on the left and some breathing room
// on the right. Approximate widths so click→timestamp math doesn't drift
// too far from the visible plot — we don't have precise plot-area metrics
// without going through a Vega view signal, but this is close enough for
// scrub-to-time use.
const PLOT_LEFT_PAD = 50;
const PLOT_RIGHT_PAD = 12;

/**
 * TimeseriesChart — renders an entity's timeseries as a Vega-Lite line chart
 * with a vertical rule at the current animation time. Clicking on the chart
 * (when `onScrub` is supplied) seeks the global animation clock.
 */
export default function TimeseriesChart({
  timeseries,
  clockState,
  interaction,
  width = 420,
  height = 180,
  onScrub,
}) {
  const wrapperRef = useRef(null);
  const delta = interaction?.timeseriesDelta ?? 168;

  const windowed = useMemo(
    () => windowedView(
      timeseries,
      clockState.index,
      clockState.start_index,
      clockState.end_index,
      delta,
    ),
    [timeseries, clockState.index, clockState.start_index, clockState.end_index, delta],
  );

  const spec = useMemo(() => {
    if (!windowed.timestamps.length) return null;

    const values = windowed.timestamps.map((t, i) => ({
      time: t.toISOString(),
      value: windowed.values[i] ?? 0,
    }));

    // Current time marker
    const currentTs = windowed.timestamps[windowed.currentLocalIndex];
    const ruleData = currentTs ? [{ time: currentTs.toISOString() }] : [];

    return {
      $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
      layer: [
        {
          data: { values },
          mark: { type: 'area', line: true, opacity: 0.3 },
          encoding: {
            x: {
              field: 'time',
              type: 'temporal',
              axis: { format: '%m/%d %H:%M', labelAngle: -45, title: null },
            },
            y: {
              field: 'value',
              type: 'quantitative',
              axis: { title: 'MW' },
            },
          },
        },
        {
          data: { values: ruleData },
          mark: { type: 'rule', color: 'rgba(255, 82, 82, 0.8)', strokeWidth: 2 },
          encoding: {
            x: { field: 'time', type: 'temporal' },
          },
        },
      ],
    };
  }, [windowed]);

  if (!spec) return null;

  function handleClick(e) {
    if (!onScrub || !windowed.timestamps.length) return;
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Map click x to a fraction of the plotted x range, accounting for
    // the y-axis padding on the left.
    const plotW = Math.max(1, rect.width - PLOT_LEFT_PAD - PLOT_RIGHT_PAD);
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - PLOT_LEFT_PAD) / plotW));
    const localIdx = Math.round(ratio * (windowed.timestamps.length - 1));
    const ts = windowed.timestamps[localIdx];
    if (!ts) return;
    // Convert the timestamp back to a GLOBAL clock index by searching
    // clockState.timestamps. Binary search for performance on long series.
    const target = ts.getTime();
    const list = clockState?.timestamps;
    if (!Array.isArray(list) || !list.length) return;
    let lo = 0, hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const mt = new Date(list[mid]).getTime();
      if (mt < target) lo = mid + 1;
      else hi = mid;
    }
    let best = lo;
    if (lo > 0) {
      const a = Math.abs(new Date(list[lo - 1]).getTime() - target);
      const b = Math.abs(new Date(list[lo]).getTime() - target);
      if (a < b) best = lo - 1;
    }
    onScrub(best);
  }

  return (
    <Box
      ref={wrapperRef}
      onClick={handleClick}
      sx={{ cursor: onScrub ? 'crosshair' : 'default' }}
    >
      <VegaLiteRenderer spec={spec} width={width} height={height} />
    </Box>
  );
}
