import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { clickedMsToGlobalIndex, pickPlayheadMs } from '../clock.js';
import { useDisplayScale } from '../DisplayScaleContext.jsx';
import { tagChartDraw } from '../chartDebug.js';

/**
 * LineScrubberPlotly — Plotly-backed sibling of LineScrubberGPU.
 *
 * Single-line or multi-line chart with click-to-scrub. Uses scattergl traces
 * (WebGL) so it works without a secure context. Mirrors LineScrubberGPU's
 * prop signature and signed-area / dashed-baseline behaviors.
 */

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

export default function LineScrubberPlotly({
  data,
  chartOptions = {},
  clockState,
  onScrub,
  displayMode = 'full',
  windowSize = 24,
  unit,
  hiddenCategories = null,
  width = 600,
  height = 300,
  fillParent = false,
  // Explicit playhead override (epoch ms). When the chart's local data
  // is a windowed slice (entity-inspector rolling window), deriving the
  // playhead from clockState.timestamps can fail because the length
  // mismatch defeats the fallback path. Callers that already know the
  // cursor's wall-clock ms pass it directly here.
  playheadMsOverride = null,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { scale: displayScale } = useDisplayScale();
  // Measured container size, only tracked under the wall's body{zoom}. Plotly's
  // responsive autosize misreads the zoomed/fractional container and under-sizes
  // the figure, leaving a gap (bottom/right margin); explicit integer dims from
  // the ResizeObserver fix it. At scale 1 we keep responsive (no change).
  const [size, setSize] = useState({ w: 0, h: 0 });

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
      console.warn('[LineScrubberPlotly] failed to load plotly:', err);
    });
    return () => { cancelled = true; };
  }, []);

  const timeAxis = chartOptions.time_axis || 'timestamp';
  const valueAxis = chartOptions.value_axis || 'value';
  const seriesAxis = chartOptions.series_axis || null;
  const seriesColors = chartOptions.series_colors || {};
  const yAxisName = chartOptions.y_axis_name || unit || chartOptions.value_unit || '';
  const effectiveUnit = unit || chartOptions.value_unit || 'MW';
  const unitDivisor = UNIT_DIVISORS[effectiveUnit] ?? 1;
  const unitDecimals = UNIT_DECIMALS[effectiveUnit] ?? 2;

  const { traces, sortedTimestampMs, yMax, yMin, signedArea, isSingleSeries, tsRange } = useMemo(() => {
    if (!data?.length) return { traces: [], sortedTimestampMs: [], yMax: 1, yMin: 0, signedArea: false, isSingleSeries: true, tsRange: null };

    const buckets = new Map();
    const tsSeen = new Set();
    for (const row of data) {
      const tsStr = row[timeAxis];
      const valRaw = Number(row[valueAxis]) || 0;
      if (!tsStr) continue;
      const ms = new Date(tsStr).getTime();
      if (!Number.isFinite(ms)) continue;
      const sname = seriesAxis ? String(row[seriesAxis] ?? '') : '__one__';
      if (seriesAxis && hiddenCategories && hiddenCategories.has(sname)) continue;
      if (!buckets.has(sname)) buckets.set(sname, []);
      buckets.get(sname).push([ms, valRaw / unitDivisor]);
      tsSeen.add(ms);
    }

    const tsSorted = Array.from(tsSeen).sort((a, b) => a - b);
    const roundFactor = 10 ** unitDecimals;
    const round = (v) => Math.round(v * roundFactor) / roundFactor;

    let observedMax = 0;
    let observedMin = 0;
    for (const [, points] of buckets) {
      for (const [, v] of points) {
        if (v > observedMax) observedMax = v;
        if (v < observedMin) observedMin = v;
      }
    }
    const isSingle = !seriesAxis;
    const autoSigned = observedMin < 0;
    const signed = chartOptions.signed_area !== undefined
      ? !!chartOptions.signed_area
      : autoSigned;

    const traceList = [];
    for (const [name, points] of buckets) {
      points.sort((a, b) => a[0] - b[0]);
      const xs = points.map(([ms]) => new Date(ms));
      const ys = points.map(([, v]) => round(v));
      const color = seriesAxis
        ? (seriesColors[name] || '#888888')
        : (chartOptions.line_color || theme.palette.primary.main);

      if (signed && isSingle) {
        const posY = ys.map((y) => Math.max(0, y));
        const negY = ys.map((y) => Math.min(0, y));
        traceList.push({
          type: 'scattergl',
          mode: 'lines',
          name: '__pos_area__',
          x: xs,
          y: posY,
          line: { width: 0, color: '#4CAF50' },
          fill: 'tozeroy',
          fillcolor: 'rgba(76,175,80,0.35)',
          hoverinfo: 'skip',
          showlegend: false,
        });
        traceList.push({
          type: 'scattergl',
          mode: 'lines',
          name: '__neg_area__',
          x: xs,
          y: negY,
          line: { width: 0, color: '#F44336' },
          fill: 'tozeroy',
          fillcolor: 'rgba(244,67,54,0.35)',
          hoverinfo: 'skip',
          showlegend: false,
        });
      }

      traceList.push({
        type: 'scattergl',
        mode: 'lines',
        name: seriesAxis ? name : (chartOptions.value_label || valueAxis),
        x: xs,
        y: ys,
        line: { color, width: 2.5 },
        hoverinfo: 'x+y+name',
        showlegend: false,
      });
    }

    return {
      traces: traceList,
      sortedTimestampMs: tsSorted,
      yMax: niceCeil(observedMax),
      yMin: observedMin < 0 ? -niceCeil(-observedMin) : 0,
      signedArea: signed,
      isSingleSeries: isSingle,
      tsRange: tsSorted.length ? [tsSorted[0], tsSorted[tsSorted.length - 1]] : null,
    };
  }, [data, timeAxis, valueAxis, seriesAxis, seriesColors, unitDivisor, unitDecimals, chartOptions, theme.palette.primary.main, hiddenCategories]);


  // Playhead x in epoch ms — explicit override wins (used by the
  // entity-inspector windowed chart), otherwise derive from clockState.
  const playheadMs = useMemo(
    () => (Number.isFinite(playheadMsOverride)
      ? playheadMsOverride
      : pickPlayheadMs(clockState, sortedTimestampMs)),
    [playheadMsOverride, clockState?.index, clockState?.timestamps, sortedTimestampMs],
  );

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

  const yMinOverride = chartOptions.y_min;
  const yMaxOverride = chartOptions.y_max;
  const effectiveYMin = yMinOverride !== undefined ? yMinOverride : (yMin < 0 ? yMin : 0);
  const effectiveYMax = yMaxOverride !== undefined ? yMaxOverride : yMax;

  const layout = useMemo(() => {
    if (!xBounds) return null;
    const fg = isDark ? '#ccc' : '#333';
    const grid = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
    const shapes = [];
    if (signedArea && tsRange) {
      shapes.push({
        type: 'line',
        xref: 'x',
        yref: 'y',
        x0: new Date(tsRange[0]),
        x1: new Date(tsRange[1]),
        y0: 0,
        y1: 0,
        line: { color: 'rgba(160,160,160,0.7)', width: 1, dash: 'dash' },
      });
    }
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
        title: yAxisName ? { text: yAxisName, font: { size: 11, color: fg } } : undefined,
        range: [effectiveYMin, effectiveYMax],
        gridcolor: grid,
        zeroline: false,
        fixedrange: true,
      },
      shapes,
      hovermode: 'x unified',
    };
  }, [xBounds, isDark, yAxisName, effectiveYMin, effectiveYMax, signedArea, tsRange]);

  useEffect(() => {
    if (!Plotly || !containerRef.current || !traces.length || !layout) return;
    const gd = containerRef.current;
    // Mirror PlotlyChart: when the display scale flips on a live page, this
    // runs before the debounced ResizeObserver has measured (`size` still
    // {0,0}) — measure synchronously rather than fall back to the responsive
    // draw, which missizes under body{zoom}.
    let w = size.w;
    let h = size.h;
    if (displayScale !== 1 && (!(w > 0) || !(h > 0))) {
      w = gd.clientWidth;
      h = gd.clientHeight;
      if (!(w > 0) || !(h > 0)) return; // not laid out yet — observer re-fires
    }
    const useExplicitSize = displayScale !== 1;
    const reactLayout = useExplicitSize
      ? { ...layout, width: w, height: h, autosize: false }
      : layout;
    tagChartDraw(gd, 'LineScrubberPlotly', { displayScale, w, h, explicit: useExplicitSize });
    Plotly.react(gd, traces, reactLayout, {
      responsive: !useExplicitSize,
      displayModeBar: false,
    }).then(() => {
      // Under body{zoom} Plotly marks edge tick labels display:none even when
      // they fit; clear it so the axis labels aren't truncated on the wall.
      if (displayScale !== 1) {
        try {
          gd.querySelectorAll('.xtick text, .ytick text').forEach((t) => {
            if (t.style.display === 'none') t.style.display = '';
          });
        } catch { /* noop */ }
      }
    }).catch((err) => {
      console.warn('[LineScrubberPlotly] react failed:', err);
    });
  }, [Plotly, traces, layout, displayScale, size]);

  // Track container size under display scale so the react path can feed Plotly
  // explicit integer dims (mirrors PlotlyChart). At scale 1, a Plots.resize
  // keeps the chart following flexbox/drag-handle container changes.
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const node = containerRef.current;
    let timer = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const w = node.clientWidth;
        const h = node.clientHeight;
        if (displayScale !== 1) {
          if (w > 0 && h > 0) {
            setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
          }
        } else if (Plotly) {
          try { Plotly.Plots.resize(node); } catch { /* noop */ }
        }
      }, 50);
    };
    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(trigger);
      observer.observe(node);
    }
    trigger();
    return () => {
      if (timer) clearTimeout(timer);
      if (observer) { try { observer.disconnect(); } catch { /* noop */ } }
    };
  }, [Plotly, displayScale]);

  // Playhead vertical line — Plotly.relayout per clock tick. Appended to
  // the static layout shapes (e.g. the dashed zero baseline in signed mode).
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

  useEffect(() => {
    if (!Plotly || !containerRef.current || !traces.length) return;
    const gd = containerRef.current;
    const handler = (ev) => {
      const cb = onScrubRef.current;
      if (!cb || !ev || !ev.points || !ev.points.length) return;
      const p = ev.points[0];
      const xMs = new Date(p.x).getTime();
      if (!Number.isFinite(xMs)) return;
      // Resolve directly to a global clock index. Avoids the previous
      // binary-search-on-haystack pattern which lost the hour bucket
      // for charts whose local series doesn't match the global clock
      // length 1:1 (e.g. aggregated curtailment) — search would land on
      // a midnight ms and snap back to that day's hour 0.
      cb(clickedMsToGlobalIndex(xMs, clockStateRef.current));
    };
    gd.on?.('plotly_click', handler);
    return () => {
      try { gd.removeAllListeners?.('plotly_click'); } catch { /* noop */ }
    };
  }, [Plotly, traces.length]);

  // ResizeObserver — Plotly's responsive:true doesn't catch parent
  // container resizes; observe ourselves and call Plotly.Plots.resize.
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

  const GRID_LEFT = 64;
  const GRID_RIGHT = 12;
  function onWrapperClick(e) {
    const cb = onScrubRef.current;
    if (!cb || !xBounds) return;
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
