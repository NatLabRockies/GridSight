import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { clickedMsToGlobalIndex, pickPlayheadMs } from '../clock.js';
import { tagChartDraw } from '../chartDebug.js';

/**
 * StackedAreaScrubberPlotly — Plotly-backed sibling of StackedAreaScrubberGPU.
 *
 * Renders a stacked area chart with playhead-synced click-to-scrub. Uses
 * Plotly's scattergl traces with manual cumulative-top stacking (Plotly's
 * native `stackgroup` doesn't work with scattergl, so we keep the same
 * pre-pass the GPU version uses).
 *
 * Same prop signature as StackedAreaScrubberGPU so the chooser can swap
 * implementations without callers changing.
 */

const UNIT_DIVISORS = { MW: 1, GW: 1e3, TW: 1e6 };
const UNIT_DECIMALS = { MW: 1, GW: 2, TW: 4 };

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

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string') return `rgba(136,136,136,${alpha})`;
  const m = hex.replace('#', '');
  const v = m.length === 3
    ? m.split('').map((c) => c + c).join('')
    : m;
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return `rgba(136,136,136,${alpha})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function StackedAreaScrubberPlotly({
  data,
  chartOptions = {},
  clockState,
  onScrub,
  displayMode = 'full',
  windowSize = 24,
  unit = 'MW',
  hiddenCategories = null,
  stackOrder = 'total',
  orderedCategories = null,
  width = 600,
  height = 300,
  fillParent = false,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  const containerRef = useRef(null);
  const [Plotly, setPlotly] = useState(null);
  const onScrubRef = useRef(onScrub);
  const clockStateRef = useRef(clockState);
  onScrubRef.current = onScrub;
  clockStateRef.current = clockState;

  useEffect(() => {
    let cancelled = false;
    import('plotly.js-basic-dist-min').then((mod) => {
      if (!cancelled) setPlotly(() => mod.default || mod);
    }).catch((err) => {
      console.warn('[StackedAreaScrubberPlotly] failed to load plotly:', err);
    });
    return () => { cancelled = true; };
  }, []);

  const timeAxis = chartOptions.time_axis || 'timestamp';
  const categoryAxis = chartOptions.category_axis || 'category';
  const valueAxis = chartOptions.value_axis || 'value';
  const categoryColors = chartOptions.category_colors || {};
  const unitDivisor = UNIT_DIVISORS[unit] ?? 1;
  const unitDecimals = UNIT_DECIMALS[unit] ?? 2;
  const categoryOrder = chartOptions.category_order;

  // Pivot long-format → cumulative-sum tops in bottom-to-top stack order.
  const { traces, sortedTimestampMs, yMax } = useMemo(() => {
    if (!data?.length) return { traces: [], sortedTimestampMs: [], yMax: 1 };

    const buckets = new Map();
    const allCats = new Set();
    for (const row of data) {
      const tsStr = row[timeAxis];
      const cat = row[categoryAxis];
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

    let stackOrderBottomUp;
    if (Array.isArray(orderedCategories) && orderedCategories.length) {
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
      const totals = new Map();
      for (const cat of allCats) totals.set(cat, 0);
      for (const m of buckets.values()) {
        for (const [cat, v] of m) totals.set(cat, (totals.get(cat) ?? 0) + v);
      }
      stackOrderBottomUp = Array.from(allCats).sort(
        (a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0),
      );
    }

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

    // Plotly fill cascade: bottom trace fills to zero; each trace above fills
    // to the trace below it. Traces must be added bottom-to-top in this
    // order, and each trace above the bottom uses fill='tonexty'.
    const xs = tsSorted.map((ms) => new Date(ms));
    const traceList = [];
    for (let li = 0; li < stackOrderBottomUp.length; li++) {
      const cat = stackOrderBottomUp[li];
      const t = tops[li];
      const ys = Array.from(t);
      const color = categoryColors[cat] || '#888888';
      traceList.push({
        type: 'scattergl',
        mode: 'lines',
        name: cat,
        x: xs,
        y: ys,
        line: { width: 0, color },
        fill: li === 0 ? 'tozeroy' : 'tonexty',
        fillcolor: hexToRgba(color, 1.0),
        hoverinfo: 'x+y+name',
        showlegend: false,
      });
    }

    return {
      traces: traceList,
      sortedTimestampMs: tsSorted,
      yMax: niceCeil(observedMax),
    };
  }, [data, timeAxis, categoryAxis, valueAxis, categoryColors, unitDivisor, unitDecimals, hiddenCategories, stackOrder, categoryOrder, orderedCategories]);


  // Playhead x in epoch ms — see pickPlayheadMs for why we prefer the local
  // series array over clockState.timestamps (the latter is date-string-only
  // and collapses every hour in a day to midnight).
  const playheadMs = useMemo(
    () => pickPlayheadMs(clockState, sortedTimestampMs),
    [clockState?.index, clockState?.timestamps, sortedTimestampMs],
  );

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

  const layout = useMemo(() => {
    if (!xBounds) return null;
    const fg = isDark ? '#ccc' : '#333';
    const grid = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    return {
      // Trimmed from l:64 r:12 t:12 — the y-tick labels never needed 64px
      // (they're SI-abbreviated and unit-scaled), and the frame already pads
      // the card, so the old values stacked into a visibly empty band down
      // both sides. b:36 stays: it carries the x-axis labels.
      margin: { l: 44, r: 6, t: 6, b: 36 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: fg, size: 11 },
      showlegend: false,
      xaxis: {
        type: 'date',
        range: [new Date(xBounds.min), new Date(xBounds.max)],
        gridcolor: grid,
        zeroline: false,
        fixedrange: true,
      },
      yaxis: {
        title: { text: unit, font: { size: 11, color: fg } },
        range: [0, yMax],
        gridcolor: grid,
        zeroline: false,
        fixedrange: true,
      },
      hovermode: 'x unified',
    };
  }, [xBounds, isDark, unit, yMax]);

  // Render / update with Plotly.react (diff-based).
  useEffect(() => {
    if (!Plotly || !containerRef.current || !traces.length || !layout) return;
    const gd = containerRef.current;
    tagChartDraw(gd, 'StackedAreaScrubberPlotly', { responsive: true });
    Plotly.react(gd, traces, layout, {
      responsive: true,
      displayModeBar: false,
    }).catch((err) => {
      console.warn('[StackedAreaScrubberPlotly] react failed:', err);
    });
  }, [Plotly, traces, layout]);

  // Playhead vertical line — updated via Plotly.relayout on every clock
  // tick. Cheaper than putting it in `layout` (which would trigger a full
  // Plotly.react every tick and re-diff all the traces).
  useEffect(() => {
    if (!Plotly || !containerRef.current || !traces.length) return;
    const gd = containerRef.current;
    const baseShapes = (layout && Array.isArray(layout.shapes)) ? layout.shapes : [];
    const next = baseShapes.slice();
    if (Number.isFinite(playheadMs)) {
      next.push({
        type: 'line',
        xref: 'x',
        yref: 'paper',
        x0: new Date(playheadMs),
        x1: new Date(playheadMs),
        y0: 0,
        y1: 1,
        line: { color: 'rgba(244, 67, 54, 0.9)', width: 1.5 },
      });
    }
    try { Plotly.relayout(gd, { shapes: next }); } catch { /* noop */ }
  }, [Plotly, playheadMs, layout, traces.length]);

  // Click handler — register once after first render.
  useEffect(() => {
    if (!Plotly || !containerRef.current || !traces.length) return;
    const gd = containerRef.current;
    const handler = (ev) => {
      const cb = onScrubRef.current;
      if (!cb || !ev || !ev.points || !ev.points.length) return;
      const p = ev.points[0];
      const xMs = new Date(p.x).getTime();
      if (!Number.isFinite(xMs)) return;
      // Map clicked ms → exact global hourly index. The previous binary
      // search on `clockState.timestamps` (date strings, 24 copies per day)
      // collapsed to nearest midnight and snapped any click within a day
      // back to that day's hour 0.
      cb(clickedMsToGlobalIndex(xMs, clockStateRef.current));
    };
    gd.on?.('plotly_click', handler);
    return () => {
      try { gd.removeAllListeners?.('plotly_click'); } catch { /* noop */ }
    };
  }, [Plotly, traces.length]);

  // ResizeObserver — Plotly's responsive:true only fires on window resize,
  // not on parent container resize (drag-resizable panels, grid layouts).
  // Call Plotly.Plots.resize(gd) ourselves whenever the container changes size.
  useEffect(() => {
    const gd = containerRef.current;
    if (!Plotly || !gd || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      try { Plotly.Plots.resize(gd); } catch { /* noop */ }
    });
    ro.observe(gd);
    return () => ro.disconnect();
  }, [Plotly]);

  useEffect(() => () => {
    const gd = containerRef.current;
    if (Plotly && gd) {
      try { Plotly.purge(gd); } catch { /* noop */ }
    }
  }, [Plotly]);

  if (!traces.length || !layout) {
    return (
      <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
        {data?.length ? 'Rendering chart…' : 'No chart data available'}
      </Typography>
    );
  }

  const wrapperSx = fillParent
    ? { position: 'absolute', inset: 0, cursor: onScrub ? 'crosshair' : 'default' }
    : { position: 'relative', width, height, cursor: onScrub ? 'crosshair' : 'default' };

  // DOM-level click fallback. Maps click x → ratio across plot area → ms,
  // independent of Plotly's hit-testing. Mirrors the GPU sibling.
  const GRID_LEFT = 64;
  const GRID_RIGHT = 12;
  function onWrapperClick(e) {
    const cb = onScrubRef.current;
    if (!cb || !xBounds) return;
    // Plotly's own click already fired? Skip — we don't want double-scrub.
    // Heuristic: if event target is inside the plot's drag layer, plotly_click
    // will (or did) handle it. Only act when click landed on padding/labels.
    const t = e.target;
    if (t && (t.classList?.contains('nsewdrag') || t.closest?.('.nsewdrag'))) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const plotW = Math.max(1, rect.width - GRID_LEFT - GRID_RIGHT);
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left - GRID_LEFT) / plotW));
    const xMs = xBounds.min + ratio * (xBounds.max - xBounds.min);
    cb(clickedMsToGlobalIndex(xMs, clockStateRef.current));
  }

  return (
    <Box sx={wrapperSx} onClick={onScrub ? onWrapperClick : undefined}>
      <Box ref={containerRef} sx={{ position: 'absolute', inset: 0 }} />
    </Box>
  );
}
