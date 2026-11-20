import { useEffect, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { createChart } from 'chartgpu-react';
import { pickPlayheadMs } from '../clock.js';

/**
 * @deprecated WebGPU requires a secure context which our deployment can't
 * provide. Prefer StackedAreaScrubberPlotly. Kept for opt-in / local dev,
 * gated by the experimental WebGPU charts toggle in Settings.
 *
 * StackedAreaScrubberGPU — GPU-accelerated stacked-area chart with a playhead
 * synced to the animation clock.
 *
 * Built on ChartGPU (WebGPU). Scales smoothly to 8760-hour datasets.
 *
 * Stacking is implemented by pre-computing cumulative sums and drawing layers
 * top-to-bottom: each layer fills from y=0 to its cumulative top, and lower
 * layers overpaint upper layers below their level. Result is visually
 * identical to native stacked-area, with no per-x baseline support required.
 *
 * IMPLEMENTATION NOTE: We bypass the chartgpu-react `<ChartGPU>` component and
 * call `createChart()` imperatively. The React wrapper has a StrictMode race
 * where late-completing async create()s from a stale mount slip past its
 * isMounted check, leaving an orphan canvas in the container. Imperative
 * mode + a generation counter guarantees exactly one live chart per mount.
 *
 * Props (same shape as a typical chart component so the parent panel doesn't
 * need to change): data, chartOptions, clockState, onScrub, displayMode,
 * windowSize, width, height
 */
// Map unit name → divisor applied to raw MW values from the server.
const UNIT_DIVISORS = { MW: 1, GW: 1e3, TW: 1e6 };

// Decimal-place precision per unit. Rounding the cumulative tops here keeps
// y-axis tick labels readable (ChartGPU has no tick formatter API; it just
// shows whatever precision the underlying data has).
const UNIT_DECIMALS = { MW: 1, GW: 2, TW: 4 };

// Round x up to the next "nice" number (1, 2, 5 × 10^N) so the y-axis
// auto-tick algorithm picks clean labels. e.g. 85 → 100, 47 → 50, 4.87 → 5.
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

// Format an epoch-ms timestamp as "HH:MM ddd MMM D" in the local timezone.
function formatPlayheadTime(ms) {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + `  ${hh}:${mm}`;
}

// Grid margins (must match chartgpu options.grid below). Used to position
// the play-state overlay over the same bottom strip where the auto labels
// would otherwise render.
const GRID_LEFT = 72;
const GRID_RIGHT = 12;
const GRID_BOTTOM = 36;
const GRID_TOP = 12;

export default function StackedAreaScrubberGPU({
  data,
  chartOptions = {},
  clockState,
  onScrub,
  displayMode = 'full',
  windowSize = 24,
  unit = 'MW',
  hiddenCategories = null,    // optional Set<string> of category names to omit from the stack
  stackOrder = 'total',       // 'total' | 'display' | 'variance' (ignored if orderedCategories provided)
  orderedCategories = null,   // optional bottom-to-top stack order; overrides stackOrder
  width = 600,
  height = 300,
  fillParent = false,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const onScrubRef = useRef(onScrub);
  const clockStateRef = useRef(clockState);
  const sortedTsMsRef = useRef([]);
  // Bumped on every mount; async create()s from stale mounts compare and bail.
  const genRef = useRef(0);

  // Keep refs current for the click handler (which is registered once)
  onScrubRef.current = onScrub;
  clockStateRef.current = clockState;

  const timeAxis = chartOptions.time_axis || 'timestamp';
  const categoryAxis = chartOptions.category_axis || 'category';
  const valueAxis = chartOptions.value_axis || 'value';
  const categoryColors = chartOptions.category_colors || {};

  const unitDivisor = UNIT_DIVISORS[unit] ?? 1;
  const unitDecimals = UNIT_DECIMALS[unit] ?? 2;
  const categoryOrder = chartOptions.category_order;  // optional canonical order from extension

  // ── Pivot long-format → cumulative-sum series, top-to-bottom draw order ──
  // Server values are MW; we divide by `unitDivisor` here so the chart can
  // render in GW/TW without separate axis-format trickery.
  const { series, sortedTimestampMs, yMax } = useMemo(() => {
    if (!data?.length) return { series: [], sortedTimestampMs: [], yMax: 1 };

    const buckets = new Map(); // ts_ms → Map<cat, value>
    const allCats = new Set();
    for (const row of data) {
      const tsStr = row[timeAxis];
      const cat = row[categoryAxis];
      // Filter out user-toggled hidden categories BEFORE pivoting/stacking
      // so cumulative tops and y-axis bounds reflow correctly.
      if (hiddenCategories && hiddenCategories.has(cat)) continue;
      const val = Number(row[valueAxis]) || 0;
      if (!tsStr || cat == null) continue;
      const ms = new Date(tsStr).getTime();
      if (!Number.isFinite(ms)) continue;
      if (!buckets.has(ms)) buckets.set(ms, new Map());
      buckets.get(ms).set(cat, val);
      allCats.add(cat);
    }
    const tsSorted = Array.from(buckets.keys()).sort((a, b) => a - b);

    // Bottom-to-top stack order. If the parent provides one (single source of
    // truth for legend + chart), use it directly. Otherwise fall back to local
    // sorting by stackOrder mode. Note: stack order ONLY affects which color
    // sits at each y-band; the actual y-values are always the raw MW power
    // values (scaled by unitDivisor) — variance is never plotted.
    let stackOrderBottomUp;
    if (Array.isArray(orderedCategories) && orderedCategories.length) {
      // Honor the panel-supplied order; fall back for any cats it missed.
      const present = new Set(allCats);
      const known = orderedCategories.filter((c) => present.has(c));
      const unknown = Array.from(present).filter((c) => !known.includes(c)).sort();
      stackOrderBottomUp = [...known, ...unknown];
    } else if (stackOrder === 'display' && Array.isArray(categoryOrder) && categoryOrder.length) {
      const present = new Set(allCats);
      const known = categoryOrder.filter((c) => present.has(c));
      const unknown = Array.from(present).filter((c) => !known.includes(c)).sort();
      stackOrderBottomUp = [...known, ...unknown];
    } else if (stackOrder === 'variance') {
      // CoV = std/mean (sort key only — never plotted). Low at bottom.
      const stats = new Map();
      for (const cat of allCats) {
        const series = tsSorted.map((ms) => buckets.get(ms)?.get(cat) ?? 0);
        const sum = series.reduce((a, b) => a + b, 0);
        const mean = sum / series.length;
        let v = 0;
        for (const x of series) v += (x - mean) ** 2;
        const std = Math.sqrt(v / series.length);
        stats.set(cat, mean > 1e-9 ? std / mean : Infinity);
      }
      stackOrderBottomUp = Array.from(allCats).sort((a, b) => stats.get(a) - stats.get(b));
    } else {
      // Default 'total': largest contribution at the bottom.
      const totals = new Map();
      for (const cat of allCats) totals.set(cat, 0);
      for (const m of buckets.values()) {
        for (const [cat, v] of m) totals.set(cat, (totals.get(cat) ?? 0) + v);
      }
      stackOrderBottomUp = Array.from(allCats).sort(
        (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
      );
    }

    // Cumulative tops of POWER values (MW divided by unitDivisor → MW/GW/TW),
    // rounded to per-unit precision so the y-axis ticks have clean labels.
    // This is the actual plotted y-data — never variance, never std.
    const roundFactor = 10 ** unitDecimals;
    const round = (v) => Math.round(v * roundFactor) / roundFactor;
    const tops = stackOrderBottomUp.map(() => new Float64Array(tsSorted.length));
    let observedMax = 0;
    for (let ti = 0; ti < tsSorted.length; ti++) {
      const m = buckets.get(tsSorted[ti]);
      let acc = 0;
      for (let li = 0; li < stackOrderBottomUp.length; li++) {
        acc += (m.get(stackOrderBottomUp[li]) ?? 0) / unitDivisor;
        tops[li][ti] = round(acc);
      }
      if (acc > observedMax) observedMax = acc;
    }

    // Series in TOP-TO-BOTTOM draw order so bottom layer paints last and
    // overlays its color across the lower portion of the chart.
    const seriesList = [];
    for (let li = stackOrderBottomUp.length - 1; li >= 0; li--) {
      const cat = stackOrderBottomUp[li];
      const t = tops[li];
      const points = new Array(tsSorted.length);
      for (let ti = 0; ti < tsSorted.length; ti++) {
        points[ti] = { x: tsSorted[ti], y: t[ti] };
      }
      seriesList.push({
        type: 'area',
        name: cat,
        data: points,
        color: categoryColors[cat] || '#888888',
        baseline: 0,
        areaStyle: { opacity: 1.0 },
      });
    }

    return {
      series: seriesList,
      sortedTimestampMs: tsSorted,
      yMax: niceCeil(observedMax),
    };
  }, [data, timeAxis, categoryAxis, valueAxis, categoryColors, unitDivisor, unitDecimals, hiddenCategories, stackOrder, categoryOrder, orderedCategories]);

  // Keep the ref current so the click handler binary-search uses fresh data
  sortedTsMsRef.current = sortedTimestampMs;

  // Playhead x in epoch ms — see pickPlayheadMs for why we prefer the local
  // series array over clockState.timestamps (date-string-only; collapses
  // every hour in a day to midnight).
  const playheadMs = useMemo(
    () => pickPlayheadMs(clockState, sortedTimestampMs),
    [clockState?.index, clockState?.timestamps, sortedTimestampMs],
  );

  // X-axis bounds: full range or centered window — slides smoothly with the
  // playhead. Custom tick labels are drawn as an HTML overlay (see below)
  // so the labels stay anchored to clean hour boundaries instead of jittering.
  const xBounds = useMemo(() => {
    if (!sortedTimestampMs.length) return null;
    if (displayMode !== 'rolling') {
      return {
        min: sortedTimestampMs[0],
        max: sortedTimestampMs[sortedTimestampMs.length - 1],
      };
    }
    const idx = clockState?.index ?? 0;
    const half = Math.max(1, Math.floor(windowSize / 2));
    const lo = Math.max(0, idx - half);
    const hi = Math.min(sortedTimestampMs.length - 1, idx + half);
    return { min: sortedTimestampMs[lo], max: sortedTimestampMs[hi] };
  }, [displayMode, windowSize, clockState?.index, sortedTimestampMs]);

  // Build full ChartGPU options (recomputed per render, but cheap)
  const options = useMemo(() => {
    if (!series.length || !xBounds) return null;
    return {
      theme: isDark ? 'dark' : 'light',
      // Wider left margin so y-axis labels (which can hit 6+ digits in MW)
      // never spill into the plot area. Tighter right margin since the
      // built-in legend is disabled (we render a custom one in the panel).
      grid: { left: GRID_LEFT, right: GRID_RIGHT, top: GRID_TOP, bottom: GRID_BOTTOM },
      // Custom legend lives in ScenarioChartsPanel (with toggle support that
      // properly reflows the cumulative-sum stack). Hide the built-in one
      // to avoid overlap and the broken-toggle behavior.
      legend: { show: false },
      // Use ChartGPU's auto x-axis (ticks + labels). They jitter as the
      // x-range slides, so we cover them with a play-state overlay below
      // while animating, and reveal them when paused.
      xAxis: { type: 'time', min: xBounds.min, max: xBounds.max },
      // Pin yAxis.min to 0 — without it, ChartGPU's autoBounds picks the
      // smallest data value as the floor, which clips off the bottom layer
      // of a stacked area (its baseline=0 ends up below the visible range).
      // Also pin yAxis.max to a "nice" ceiling so the auto-tick algorithm
      // picks clean labels (e.g. 0/20/40/60/80/100 instead of 0/17.13/...).
      yAxis: { type: 'value', name: unit, min: 0, max: yMax, autoBounds: 'global' },
      // Disable chartgpu's internal animation. With it on, every clock tick
      // starts a 200ms interpolation, which makes the playhead annotation
      // appear to update only "occasionally" — it's actually animating
      // toward the new x but never reaching it before the next tick replaces
      // it. Disabling makes data + playhead snap to the latest values
      // immediately on every render.
      animation: false,
      gridLines: { show: true, opacity: 0.3 },
      series,
      // No chartgpu annotation for the playhead — its setOption updates are
      // unreliable for annotations and only redraw "occasionally". We render
      // the playhead as an HTML overlay below, which updates on every React
      // render (i.e. every clock tick).
      annotations: [],
      tooltip: { show: true },
    };
  }, [series, xBounds, playheadMs, isDark, unit, yMax]);

  // ── Imperative chart lifecycle ──
  // Mount: generation++, create chart, register click handler.
  // Cleanup: dispose. Stale async create()s detect their gen != current and bail.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !options) return;

    // Belt-and-suspenders: clear any leftover canvases from a previous failed
    // mount before creating a new one.
    while (container.firstChild) container.removeChild(container.firstChild);

    const myGen = ++genRef.current;
    let cancelled = false;
    if (myGen === 1) {
      console.info('[StackedAreaScrubberGPU] ChartGPU path is deprecated; enabled via user preference.');
    }

    (async () => {
      try {
        const chart = await createChart(container, options);
        if (cancelled || myGen !== genRef.current) {
          // A newer mount has superseded us; dispose and bail before adopting.
          chart.dispose();
          return;
        }
        chartRef.current = chart;
        chart.on('click', (payload) => {
          const cb = onScrubRef.current;
          if (!cb || !payload || !payload.value) return;
          const xMs = payload.value[0];
          if (!Number.isFinite(xMs)) return;
          const haystack = clockStateRef.current?.timestamps?.length
            ? clockStateRef.current.timestamps.map((s) => new Date(s).getTime())
            : sortedTsMsRef.current;
          if (!haystack.length) return;
          // Binary search nearest by ms (haystack is sorted ascending)
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
          console.error('[StackedAreaScrubber] createChart failed:', err);
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
    // Intentionally only depend on the data identity so the chart isn't
    // recreated for every clock tick. Option updates are handled in a
    // separate effect below via setOption().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series.length === 0]);

  // Update existing chart on options change without recreating
  useEffect(() => {
    const c = chartRef.current;
    if (!c || c.disposed || !options) return;
    try { c.setOption(options); } catch (e) { console.warn('[StackedAreaScrubber] setOption:', e); }
  }, [options]);

  // ResizeObserver — call chart.resize() whenever the container size changes
  // (drag-resizing the parent panel, window resize, etc.). The imperative API
  // doesn't auto-watch, so we wire it ourselves.
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

  // No vertical playhead line for now — chartgpu's annotation system updates
  // unreliably (only re-renders "occasionally" via setOption) and HTML/canvas
  // overlays didn't track the playhead smoothly either. The current animation
  // time is shown by the Animation controller's clock instead.
  //
  // FUTURE: a custom 2D-canvas overlay positioned over the plot area could
  // draw the line per-frame using requestAnimationFrame, decoupled from
  // React's render cycle. ChartGPU itself uses WebGPU and doesn't expose a
  // public draw API — patching it would be the only way to render a line
  // truly "on the chart" rather than over it.

  // Wrapper sx — fills the parent (or explicit dimensions).
  const wrapperSx = fillParent
    ? { position: 'absolute', inset: 0, cursor: onScrub ? 'crosshair' : 'default' }
    : { position: 'relative', width, height, cursor: onScrub ? 'crosshair' : 'default' };

  // Chart container holds the chartgpu canvas.
  const chartContainerSx = {
    position: 'absolute',
    inset: 0,
  };

  return (
    <Box sx={wrapperSx}>
      <Box ref={containerRef} sx={chartContainerSx} />
    </Box>
  );
}
