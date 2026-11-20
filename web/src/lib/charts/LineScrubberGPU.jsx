import { useEffect, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { createChart } from 'chartgpu-react';

/**
 * @deprecated WebGPU requires a secure context which our deployment can't
 * provide. Prefer LineScrubberPlotly. Kept for opt-in / local dev, gated
 * by the experimental WebGPU charts toggle in Settings.
 *
 * LineScrubberGPU — GPU-accelerated single-line (or multi-line) chart with
 * the same play-state overlay + click-to-scrub behavior as StackedAreaScrubberGPU.
 *
 * Long-format input data:
 *   - Single-line: rows of `{[time_axis]: tsStr, [value_axis]: number}`
 *   - Multi-line:  add `[series_axis]: 'name'` per row → one line per series
 *
 * Reuses the same lifecycle + clip-path-on-animate trick as the stacked
 * scrubber. Most of the file is similar — would be reasonable future cleanup
 * to factor the shared pieces (lazy createChart, ResizeObserver, clip,
 * click handler) into a `useChartGPULifecycle` hook.
 */

// MW → unit divisor. Mirrors StackedAreaScrubber.
const UNIT_DIVISORS = { MW: 1, GW: 1e3, TW: 1e6, '%': 1, NONE: 1 };
const UNIT_DECIMALS = { MW: 1, GW: 2, TW: 4, '%': 1, NONE: 2 };

function niceCeil(x) {
  if (x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const mag = Math.pow(10, exp);
  const fraction = x / mag;
  let nice;
  if (fraction <= 1) nice = 1;
  else if (fraction <= 2) nice = 2;
  else if (fraction <= 5) nice = 5;
  else nice = 10;
  return nice * mag;
}

const GRID_LEFT = 72;
const GRID_RIGHT = 12;
const GRID_BOTTOM = 36;
const GRID_TOP = 12;

export default function LineScrubberGPU({
  data,
  chartOptions = {},
  clockState,
  onScrub,
  displayMode = 'full',
  windowSize = 24,
  unit,                          // unit override; falls back to chart_options.value_unit
  hiddenCategories = null,       // optional Set<string> of series names to hide (multi-line)
  width = 600,
  height = 300,
  fillParent = false,
  // Explicit playhead epoch ms. Same purpose as in LineScrubberPlotly:
  // when the chart's local series is a windowed slice, derive the
  // playhead from the caller's cursor instead of trying to map
  // ``clockState.index`` to a local index that may not exist.
  playheadMsOverride = null,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const onScrubRef = useRef(onScrub);
  const clockStateRef = useRef(clockState);
  const sortedTsMsRef = useRef([]);
  const genRef = useRef(0);

  onScrubRef.current = onScrub;
  clockStateRef.current = clockState;

  // Build the timestamp haystack used by both click paths.
  // The global clockState.timestamps array is populated by the
  // TimeseriesBuffer's per-date metadata — it has the right COUNT (one
  // entry per hourly step) but each entry is the DATE STRING, not the
  // hourly timestamp. Binary searching that as ms collapses every hour
  // within a day to midnight, which scrubs to the wrong place. When the
  // chart's own data has the same number of entries (1:1 with the global
  // clock — true for entity-scoped full-horizon series), prefer the
  // chart's PRECISE local timestamps and treat the index as global.
  function pickHaystack() {
    const local = sortedTsMsRef.current || [];
    const globalTs = clockStateRef.current?.timestamps;
    if (local.length && globalTs?.length === local.length) return local;
    if (globalTs?.length) return globalTs.map((s) => new Date(s).getTime());
    return local;
  }

  const timeAxis = chartOptions.time_axis || 'timestamp';
  const valueAxis = chartOptions.value_axis || 'value';
  const seriesAxis = chartOptions.series_axis || null;     // null → single line
  const seriesColors = chartOptions.series_colors || {};
  const yAxisName = chartOptions.y_axis_name || unit || chartOptions.value_unit || '';
  const effectiveUnit = unit || chartOptions.value_unit || 'MW';
  const unitDivisor = UNIT_DIVISORS[effectiveUnit] ?? 1;
  const unitDecimals = UNIT_DECIMALS[effectiveUnit] ?? 2;

  // Pivot long-format → one (or N) line series.
  const { series, sortedTimestampMs, yMax, yMin } = useMemo(() => {
    if (!data?.length) return { series: [], sortedTimestampMs: [], yMax: 1 };

    // Collect points per series (or single-series under '__one__')
    const buckets = new Map(); // seriesName → Array<[ms, value]>
    const tsSeen = new Set();
    for (const row of data) {
      const tsStr = row[timeAxis];
      const valRaw = Number(row[valueAxis]) || 0;
      if (!tsStr) continue;
      const ms = new Date(tsStr).getTime();
      if (!Number.isFinite(ms)) continue;
      const sname = seriesAxis ? String(row[seriesAxis] ?? '') : '__one__';
      // Legend-driven toggle: skip rows for series the user hid.
      if (seriesAxis && hiddenCategories && hiddenCategories.has(sname)) continue;
      if (!buckets.has(sname)) buckets.set(sname, []);
      buckets.get(sname).push([ms, valRaw / unitDivisor]);
      tsSeen.add(ms);
    }

    const tsSorted = Array.from(tsSeen).sort((a, b) => a - b);

    // Round + sort each series's points by time
    const roundFactor = 10 ** unitDecimals;
    const round = (v) => Math.round(v * roundFactor) / roundFactor;

    let observedMax = 0;
    let observedMin = 0;
    const seriesList = [];
    // Pre-pass: scan all points for min/max so we can decide whether to
    // render in signed-area mode (single series with negative data).
    for (const [, points] of buckets) {
      for (const [, v] of points) {
        if (v > observedMax) observedMax = v;
        if (v < observedMin) observedMin = v;
      }
    }
    // Signed-area mode: any data crossing zero gets a dashed zero
    // baseline; single-series data also gets green/red areas above and
    // below the line. Opt-in/out via chart_options.signed_area.
    const isSingleSeries = !seriesAxis;
    const autoSigned = observedMin < 0;
    const signedArea = chartOptions.signed_area !== undefined
      ? !!chartOptions.signed_area
      : autoSigned;

    for (const [name, points] of buckets) {
      points.sort((a, b) => a[0] - b[0]);
      const data = points.map(([ms, v]) => ({ x: ms, y: round(v) }));
      const color = seriesAxis
        ? (seriesColors[name] || '#888888')
        : (chartOptions.line_color || theme.palette.primary.main);

      if (signedArea && isSingleSeries) {
        // Positive area (negatives clamped to 0) → green fill above zero.
        // Negative area (positives clamped to 0) → red fill below zero.
        const posData = data.map((p) => ({ x: p.x, y: Math.max(0, p.y) }));
        const negData = data.map((p) => ({ x: p.x, y: Math.min(0, p.y) }));
        seriesList.push({
          type: 'area',
          name: '__pos_area__',
          data: posData,
          color: '#4CAF50',
          baseline: 0,
          areaStyle: { opacity: 0.35 },
          lineStyle: { width: 0, opacity: 0 },
        });
        seriesList.push({
          type: 'area',
          name: '__neg_area__',
          data: negData,
          color: '#F44336',
          baseline: 0,
          areaStyle: { opacity: 0.35 },
          lineStyle: { width: 0, opacity: 0 },
        });
      }

      seriesList.push({
        type: 'line',
        name: seriesAxis ? name : (chartOptions.value_label || valueAxis),
        data,
        color,
        // Bold-ish line — easier to read at panel sizes and when multiple
        // scrubber charts are stacked for correlation comparison.
        lineStyle: { width: 2.5 },
      });
    }

    // Dashed zero baseline — added for any chart whose y range crosses 0
    // (auto in signed mode; also helpful for multi-line that goes negative).
    if (signedArea && tsSorted.length >= 2) {
      seriesList.push({
        type: 'line',
        name: '__zero_baseline__',
        data: [
          { x: tsSorted[0], y: 0 },
          { x: tsSorted[tsSorted.length - 1], y: 0 },
        ],
        color: 'rgba(160, 160, 160, 0.7)',
        lineStyle: { width: 1, type: 'dashed' },
      });
    }

    return {
      series: seriesList,
      sortedTimestampMs: tsSorted,
      yMax: niceCeil(observedMax),
      yMin: observedMin < 0 ? -niceCeil(-observedMin) : 0,
    };
  }, [data, timeAxis, valueAxis, seriesAxis, seriesColors, unitDivisor, unitDecimals, chartOptions, theme.palette.primary.main, hiddenCategories]);

  sortedTsMsRef.current = sortedTimestampMs;

  // X-axis bounds: full or rolling
  const xBounds = useMemo(() => {
    if (!sortedTimestampMs.length) return null;
    if (displayMode !== 'rolling') {
      return { min: sortedTimestampMs[0], max: sortedTimestampMs[sortedTimestampMs.length - 1] };
    }
    const idx = clockState?.index ?? 0;
    const half = Math.max(1, Math.floor(windowSize / 2));
    const lo = Math.max(0, idx - half);
    const hi = Math.min(sortedTimestampMs.length - 1, idx + half);
    return { min: sortedTimestampMs[lo], max: sortedTimestampMs[hi] };
  }, [displayMode, windowSize, clockState?.index, sortedTimestampMs]);

  // ChartGPU options. y-axis min/max can be forced via chart_options (use
  // null to opt into "auto from data"). Default min is 0 (current behavior
  // for stacked-area-like single-line charts), default max is a "nice"
  // ceiling above the observed max.
  const yMinOverride = chartOptions.y_min;
  const yMaxOverride = chartOptions.y_max;
  const effectiveYMin = yMinOverride !== undefined ? yMinOverride : (yMin < 0 ? yMin : 0);
  const effectiveYMax = yMaxOverride !== undefined ? yMaxOverride : yMax;
  const options = useMemo(() => {
    if (!series.length || !xBounds) return null;
    return {
      theme: isDark ? 'dark' : 'light',
      grid: { left: GRID_LEFT, right: GRID_RIGHT, top: GRID_TOP, bottom: GRID_BOTTOM },
      legend: { show: false },
      xAxis: { type: 'time', min: xBounds.min, max: xBounds.max },
      yAxis: { type: 'value', name: yAxisName, min: effectiveYMin, max: effectiveYMax, autoBounds: 'global' },
      gridLines: { show: true, opacity: 0.3 },
      series,
      annotations: [],
      animation: false,
      tooltip: { show: true },
    };
  }, [series, xBounds, isDark, yAxisName, effectiveYMin, effectiveYMax]);

  // Mount lifecycle (mirror of StackedAreaScrubber)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !options) return;

    while (container.firstChild) container.removeChild(container.firstChild);

    const myGen = ++genRef.current;
    let cancelled = false;
    if (myGen === 1) {
      console.info('[LineScrubberGPU] ChartGPU path is deprecated; enabled via user preference.');
    }

    (async () => {
      try {
        const chart = await createChart(container, options);
        if (cancelled || myGen !== genRef.current) {
          chart.dispose();
          return;
        }
        chartRef.current = chart;
        chart.on('click', (payload) => {
          const cb = onScrubRef.current;
          if (!cb || !payload || !payload.value) return;
          const xMs = payload.value[0];
          if (!Number.isFinite(xMs)) return;
          const haystack = pickHaystack();
          if (!haystack.length) return;
          let lo = 0, hi = haystack.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (haystack[mid] < xMs) lo = mid + 1;
            else hi = mid;
          }
          let best = lo;
          if (lo > 0 && Math.abs(haystack[lo - 1] - xMs) < Math.abs(haystack[lo] - xMs)) {
            best = lo - 1;
          }
          cb(best);
        });
      } catch (err) {
        if (!cancelled && myGen === genRef.current) {
          console.error('[LineScrubber] createChart failed:', err);
        }
      }
    })();

    return () => {
      cancelled = true;
      genRef.current++;
      const c = chartRef.current;
      chartRef.current = null;
      if (c && !c.disposed) {
        try { c.dispose(); } catch { /* noop */ }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.length === 0]);

  useEffect(() => {
    const c = chartRef.current;
    if (!c || c.disposed || !options) return;
    try { c.setOption(options); } catch (e) { console.warn('[LineScrubber] setOption:', e); }
  }, [options]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const c = chartRef.current;
      if (c && !c.disposed) {
        try { c.resize(); } catch { /* noop */ }
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  if (!series.length || !options) {
    return (
      <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
        {data?.length ? 'Rendering chart…' : 'No chart data available'}
      </Typography>
    );
  }


  const wrapperSx = fillParent
    ? { position: 'absolute', inset: 0, cursor: onScrub ? 'crosshair' : 'default' }
    : { position: 'relative', width, height, cursor: onScrub ? 'crosshair' : 'default' };

  const chartContainerSx = {
    position: 'absolute',
    inset: 0,
  };

  // DOM-level click fallback. ChartGPU's chart.on('click') sometimes
  // returns no nearest point depending on series geometry (areas + dashed
  // baseline can confuse the picker). Compute the click position relative
  // to the plot area, map ratio → timestamp ms → nearest global clock
  // index. Fires whether or not chart.on('click') also fires.
  function onWrapperClick(e) {
    const cb = onScrubRef.current;
    if (!cb || !xBounds) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - GRID_LEFT - GRID_RIGHT);
    const ratio = Math.max(0, Math.min(1,
      (e.clientX - rect.left - GRID_LEFT) / plotW
    ));
    const xMs = xBounds.min + ratio * (xMax - xBounds.min);
    const haystack = pickHaystack();
    if (!haystack.length) return;
    let lo = 0, hi = haystack.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (haystack[mid] < xMs) lo = mid + 1;
      else hi = mid;
    }
    let best = lo;
    if (lo > 0 && Math.abs(haystack[lo - 1] - xMs) < Math.abs(haystack[lo] - xMs)) {
      best = lo - 1;
    }
    cb(best);
  }
  // xBounds.max alias so the ratio math reads cleanly above.
  const xMax = xBounds.max;

  // Playhead overlay — ChartGPU doesn't expose a documented cursor
  // annotation here, so we draw a 1.5 px vertical line as an absolutely
  // positioned div anchored to the chart's plot area.
  //
  // Positioning is by DATA-POINT INDEX, not raw ms→pixel interpolation.
  // ChartGPU's time axis quietly rounds tick positions to the nearest
  // day + local-TZ offset, so the obvious
  // ``(playheadMs - xBounds.min) / (xBounds.max - xBounds.min)``
  // approach misaligns the line by hours. Indexing into the data array
  // sidesteps that: whatever displacement ChartGPU applies to a given
  // data point, our line ends up at the same proportional position.
  const playheadMs = Number.isFinite(playheadMsOverride)
    ? playheadMsOverride
    : null;
  const playheadRatio = useMemo(() => {
    if (playheadMs == null || !sortedTimestampMs.length) return null;
    if (playheadMs < sortedTimestampMs[0]) return null;
    if (playheadMs > sortedTimestampMs[sortedTimestampMs.length - 1]) return null;
    // Binary search for the nearest data point.
    let lo = 0, hi = sortedTimestampMs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sortedTimestampMs[mid] < playheadMs) lo = mid + 1;
      else hi = mid;
    }
    let best = lo;
    if (lo > 0
        && Math.abs(sortedTimestampMs[lo - 1] - playheadMs)
         < Math.abs(sortedTimestampMs[lo] - playheadMs)) {
      best = lo - 1;
    }
    const denom = Math.max(1, sortedTimestampMs.length - 1);
    return best / denom;
  }, [playheadMs, sortedTimestampMs]);
  const showPlayhead = playheadRatio != null;

  return (
    <Box sx={wrapperSx} onClick={onScrub ? onWrapperClick : undefined}>
      <Box ref={containerRef} sx={chartContainerSx} />
      {showPlayhead && (
        <Box
          sx={{
            position: 'absolute',
            top: GRID_TOP,
            bottom: GRID_BOTTOM,
            left: `calc(${GRID_LEFT}px + (100% - ${GRID_LEFT + GRID_RIGHT}px) * ${playheadRatio})`,
            width: '1.5px',
            backgroundColor: 'rgba(244, 67, 54, 0.9)',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />
      )}
    </Box>
  );
}
