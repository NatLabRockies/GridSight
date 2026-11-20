import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import { useTheme } from '@mui/material/styles';
import { valueAxisTitle } from '../../lib/formatFieldLabel.js';

/**
 * ChartGPUChart — WebGPU-rendered line/bar/scatter chart matching the
 * PlotlyChart prop signature so chartRegistry can route to either.
 *
 * STATUS: deprioritised. LineBarRouter now defaults to PlotlyChart for
 * line/bar/scatter even when WebGPU is available — opt in with
 * `chart_options.renderer = "gpu"`. Open issues to chase before making
 * it the default again:
 *   • TODO: x-axis tick labels fall back to numeric `toFixed()` for
 *     integer year data (yields "1991.5" on a wide year span). Setting
 *     `xAxis = { type: 'category', data: [year strings] }` and remapping
 *     DataPoint.x to indices DID NOT fix it in repro testing — needs a
 *     proper minimal repro + maybe a chartgpu-core upstream fix.
 *
 * Uses the imperative `@chartgpu/chartgpu` API directly rather than the
 * `chartgpu-react` wrapper. The React wrapper has a race with React 18
 * StrictMode where two concurrent `create()` calls both append a canvas
 * (the cleanup of mount #1 fires before mount #1's async create resolves;
 * mount #2 then starts its own create; when both resolve, both canvases
 * are attached and only the second one is tracked for dispose). The
 * imperative path gives us a single, deterministic create + dispose.
 *
 * Props:
 *   data            row objects from the chart-data API
 *   chartSpec       { chart_type, chart_options, width?, height? }
 *   onPointClick    ({ x, y, traceName }) => void
 *   fillParent      if true, wrapper expands to fill its container
 */

// Lazy-load the imperative module so the WebGPU runtime + shaders only
// pull when a ChartGPU chart actually mounts.
const _moduleCache = { mod: null, loading: null };
function loadChartGPU() {
  if (_moduleCache.mod) return Promise.resolve(_moduleCache.mod);
  if (_moduleCache.loading) return _moduleCache.loading;
  _moduleCache.loading = import('@chartgpu/chartgpu').then((m) => {
    _moduleCache.mod = m;
    return m;
  });
  return _moduleCache.loading;
}

// Choose a nice y-axis top + matching tick count so labels are round numbers
// (0, 500,000, 1,000,000, …) instead of data-derived values like "1,987,749".
// Targets ~targetTicks divisions with a {1,2,2.5,5}×10^k step and rounds the max
// UP to a whole multiple of that step. ChartGPU has no tick formatter; the only
// lever is (min, max) + gridLines.count, so a clean max + count IS the fix.
function niceAxisMax(maxVal, targetTicks = 5) {
  if (!Number.isFinite(maxVal) || maxVal <= 0) return { max: 1, count: 2 };
  const rawStep = maxVal / Math.max(1, targetTicks - 1);
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  let max = Math.ceil(maxVal / step) * step;
  if (max <= maxVal) max += step; // guarantee headroom when data sits on a step
  return { max, step, count: Math.round(max / step) + 1 };
}

/** Build ChartGPU options from rows + the extension's chart_options. */
function buildOptions(data, chartType, chartOptions, isDark, hiddenCategories) {
  const opts = chartOptions || {};
  const xCol = opts.time_axis;
  const yCol = opts.value_axis;
  const catCol = opts.category_axis;
  // Display rescale (see PlotlyChart): divide values so a small base unit
  // renders as a natural one with human-scale ticks. Matches value_unit.
  // TODO(units): interim — move conversion to the data layer post ndr/units-2.
  const valueScale = Number(opts.value_scale) || 1;

  if (!Array.isArray(data) || !data.length || !xCol || !yCol) {
    return null;
  }

  const seriesType =
    chartType === 'bar' ? 'bar' :
    chartType === 'scatter' ? 'scatter' :
    'line';

  const categoryColors = opts.category_colors || {};
  const seenCats = [];
  const seenSet = new Set();
  const buckets = new Map(); // cat -> { x: [], y: [] }
  for (const row of data) {
    const cat = catCol ? String(row[catCol] ?? '') : '__single__';
    const x = row[xCol];
    const y = Number(row[yCol]) / valueScale;
    if (x == null || !Number.isFinite(y)) continue;
    if (!seenSet.has(cat)) { seenSet.add(cat); seenCats.push(cat); }
    let b = buckets.get(cat);
    if (!b) { b = { x: [], y: [] }; buckets.set(cat, b); }
    b.x.push(x);
    b.y.push(y);
  }

  const declared = Array.isArray(opts.category_order) ? opts.category_order : null;
  const orderedCats = declared
    ? [...declared.filter((c) => seenSet.has(c)),
       ...seenCats.filter((c) => !declared.includes(c))]
    : seenCats;

  // Stacked-bar opt-in via chart_options.layout.barmode='stack'.
  const isStacked = seriesType === 'bar'
    && (opts.layout?.barmode === 'stack' || opts.barmode === 'stack');
  const stackId = isStacked ? 'stk' : undefined;

  // Filter out any categories hidden via the interactive legend below
  // the chart. ChartGPU doesn't expose a per-series `visible` flag, so
  // we omit them from the options entirely — the chart redraws with
  // whatever set the legend currently has on.
  const hidden = hiddenCategories instanceof Set ? hiddenCategories : null;
  const visibleCats = hidden
    ? orderedCats.filter((c) => !(c === '__single__'
        ? hidden.has(opts.value_label || yCol)
        : hidden.has(c)))
    : orderedCats;

  // X-axis type picker:
  //   • bars always go on a category axis (value-axis centers bars at
  //     their x coords, which clips the first / last half-bars).
  //   • lines/scatter on integer-only x values (years, ordinals) also
  //     go on a category axis. ChartGPU's value-axis auto-tick picks
  //     intervals based on the data range and chart width and labels
  //     them via `toFixed(...)`, so a 64-year span can land on labels
  //     like "1991.5". Category-with-explicit-data forces literal
  //     string labels at known positions.
  //   • non-integer numeric x stays on value axis (continuous time
  //     series).
  const xValuesAllIntegers = data.every((r) => {
    const v = r[xCol];
    return typeof v === 'number' && Number.isInteger(v);
  });
  const sampleX = data[0]?.[xCol];
  // Year-like integer x (the SEDS / Demand100 forecasts are keyed by year) →
  // a TIME axis. That's the only axis type in @chartgpu/chartgpu@0.2.9 that
  // yields real year labels: AxisConfig exposes no label array and no
  // formatter, so a 'category' axis renders bare data indices ("0, 15.75").
  // Each year is mapped to a UTC timestamp; the time axis formats it back to a
  // year. Applies to bars too (they position fine on the time axis).
  // Year-like integer x (SEDS / Demand100 forecasts) → a TIME axis. It's the
  // only ChartGPU v0.2.9 axis that renders all points correctly AND spaces
  // ticks by ~decade with real years. (A 'value' axis truncates the series and
  // still auto-picks fractional/comma ticks like "1,977.5"; 'category' renders
  // bare indices — AxisConfig exposes no label array or formatter.) The time
  // formatter's coarsest form is "YYYY/MM"; there is no year-only mode, so the
  // month suffix is a library limitation we accept. Mid-year UTC keeps the
  // label's year correct regardless of the viewer's UTC offset.
  const xIsYearLike = xValuesAllIntegers
    && data.every((r) => { const v = r[xCol]; return v >= 1800 && v <= 2200; });
  const yearToMs = (y) => Date.UTC(y, 6, 1);
  const xType = xIsYearLike
    ? 'time'
    : (seriesType === 'bar'
        ? 'category'
        : (typeof sampleX === 'number' ? 'value' : 'category'));

  // Build the sorted unique x labels used by the category axis. For a
  // category axis ChartGPU expects DataPoint.x to be the INDEX into
  // xAxis.data (the labels array). Without this remap, category type
  // silently degrades to a value-like layout and labels get auto-
  // formatted with toFixed() — yielding fractional labels like 1991.5.
  let xLabels = null;
  let xIndex = null;
  if (xType === 'category') {
    const seenX = new Set();
    const labelList = [];
    for (const r of data) {
      const v = r[xCol];
      if (v == null) continue;
      const key = String(v);
      if (seenX.has(key)) continue;
      seenX.add(key);
      labelList.push({ raw: v, label: key });
    }
    // Numeric category: sort numerically so years 2000, 2001, … line
    // up; string category: preserve first-seen order.
    if (typeof sampleX === 'number') {
      labelList.sort((a, b) => a.raw - b.raw);
    }
    xLabels = labelList.map((l) => l.label);
    xIndex = new Map(labelList.map((l, i) => [String(l.raw), i]));
  }

  const series = visibleCats.map((cat) => {
    const b = buckets.get(cat);
    const name = cat === '__single__'
      ? (opts.value_label || yCol)
      : cat;
    const points = b.x.map((xv, i) => {
      const x = xType === 'time' ? yearToMs(xv)
        : xType === 'category' ? (xIndex?.get(String(xv)) ?? 0)
        : xv;
      return { x, y: b.y[i] };
    });
    const config = {
      type: seriesType,
      name,
      data: points,
    };
    if (categoryColors[cat]) config.color = categoryColors[cat];
    if (stackId) config.stack = stackId;
    return config;
  });

  const layout = opts.layout || {};

  // ChartGPU's default inner padding is 0 — axis names and the outermost
  // tick labels get clipped. Map the spec's Plotly-shape `layout.margin`
  // ({l,r,t,b}) onto ChartGPU's grid ({left,right,top,bottom}) with
  // sane fallbacks for specs that didn't declare one.
  const m = layout.margin || {};
  const hasLegend = orderedCats.length > 1 && orderedCats[0] !== '__single__';

  // ── Y-axis: nice rounded max + matching tick count ───────────────────
  // ChartGPU auto-ranges y from raw extrema (→ "1,987,749" labels) and, for
  // stacked bars, clips the stack at the tallest single series. Compute the
  // real data max (stack totals across VISIBLE series when stacked, else the
  // per-series max) and snap it up to a nice round top so tick labels are
  // clean multiples (…, 1,000,000, 1,500,000, 2,000,000).
  let yDataMax = 0;
  if (isStacked) {
    const totalsByX = new Map();
    for (const cat of visibleCats) {
      const b = buckets.get(cat);
      if (!b) continue;
      for (let i = 0; i < b.x.length; i += 1) {
        const xv = b.x[i];
        totalsByX.set(xv, (totalsByX.get(xv) || 0) + (b.y[i] || 0));
      }
    }
    for (const v of totalsByX.values()) if (v > yDataMax) yDataMax = v;
  } else {
    for (const cat of visibleCats) {
      const b = buckets.get(cat);
      if (!b) continue;
      for (const y of b.y) if (y > yDataMax) yDataMax = y;
    }
  }
  const yInfo = niceAxisMax(yDataMax);
  const yAxis = {
    type: 'value',
    name: layout.yaxis?.title || valueAxisTitle(opts, yCol),
    min: 0,
    max: yInfo.max,
  };

  // ── X-axis ───────────────────────────────────────────────────────────
  // Year data uses the time axis (points are mapped to timestamps above); its
  // auto-ticks land ~decade apart. Other data keeps category/value.
  const xAxis = { type: xType, name: layout.xaxis?.title || xCol };
  if (xType === 'category' && xLabels) xAxis.data = xLabels;

  // ChartGPU's default inner padding is 0 — axis names + outermost tick labels
  // clip. Map the spec's Plotly-shape margin onto ChartGPU's grid, and widen
  // `left` to fit the widest (nice) y label so millions aren't cut off.
  const yLabelPx = String(Math.round(yInfo.max).toLocaleString()).length * 7 + 24;
  const grid = {
    left:   Math.max(m.l ?? 0, yLabelPx, 56),
    right:  m.r ?? 24,
    top:    m.t ?? 32,
    bottom: m.b ?? (hasLegend ? 56 : 40),
  };

  // Ask for as many horizontal grid lines as our nice y-step implies, so the
  // round max divides into round tick labels (0, 25M, 50M, …).
  const gridLines = { horizontal: { count: yInfo.count } };

  return {
    series,
    grid,
    gridLines,
    xAxis,
    yAxis,
    // ScenarioChartBody already renders an interactive legend below the
    // chart frame — turn ChartGPU's own legend off so the two don't
    // duplicate each other (and so the chart area gets the full grid).
    legend: { show: false },
    tooltip: { show: true },
    theme: isDark ? 'dark' : 'light',
  };
}

export default function ChartGPUChart({
  data, chartSpec, onPointClick, fillParent, hiddenCategories,
}) {
  const containerRef = useRef(null);
  const instanceRef = useRef(null);
  // Stable refs for handlers so we don't tear down + re-register the
  // click listener on every parent re-render.
  const onPointClickRef = useRef(onPointClick);
  onPointClickRef.current = onPointClick;

  const [moduleReady, setModuleReady] = useState(!!_moduleCache.mod);
  const [loadError, setLoadError] = useState(null);
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';

  useEffect(() => {
    if (moduleReady) return;
    let cancelled = false;
    loadChartGPU()
      .then(() => { if (!cancelled) setModuleReady(true); })
      .catch((e) => { if (!cancelled) setLoadError(String(e)); });
    return () => { cancelled = true; };
  }, [moduleReady]);

  const chartType = chartSpec?.chart_type || 'line';
  const optionsKey = JSON.stringify(chartSpec?.chart_options ?? null);
  // `hiddenCategories` is a Set — stringify its contents so the memo
  // recomputes whenever the interactive legend toggles. Sets aren't
  // shallowly comparable.
  const hiddenKey = useMemo(() => {
    if (!(hiddenCategories instanceof Set)) return '';
    return [...hiddenCategories].sort().join('|');
  }, [hiddenCategories]);
  const options = useMemo(
    () => buildOptions(
      data, chartType, chartSpec?.chart_options, isDark, hiddenCategories,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, chartType, optionsKey, isDark, hiddenKey],
  );

  // Mount/dispose the ChartGPU instance once per container lifetime.
  // The cleanup function captures the instance via closure — even if the
  // async create is still pending when cleanup fires (StrictMode), the
  // disposed flag below prevents the resolved instance from sticking
  // around as a stray canvas.
  useEffect(() => {
    if (!moduleReady || !containerRef.current) return undefined;
    const node = containerRef.current;
    // Belt-and-suspenders: clear any prior children (a previous mount's
    // canvas that wasn't disposed because its create resolved AFTER
    // cleanup ran). Cheap; only runs once per mount.
    while (node.firstChild) node.removeChild(node.firstChild);

    let cancelled = false;
    let local = null;
    let resizeObserver = null;
    // Debounce resize() — ResizeObserver fires synchronously on every
    // single-pixel container change (e.g. flexbox reflow during drag).
    // 50 ms catches the steady state without wasting GPU work mid-drag.
    let resizeTimer = null;
    const scheduleResize = (inst) => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (inst && !inst.disposed) {
          try { inst.resize(); } catch (e) { /* noop */ }
        }
      }, 50);
    };

    (async () => {
      try {
        const mod = await loadChartGPU();
        if (cancelled) return;
        const created = await mod.ChartGPU.create(node, options || { series: [] });
        if (cancelled) {
          // create() resolved AFTER our cleanup. Dispose immediately so
          // its canvas doesn't leak into the DOM.
          try { created.dispose(); } catch { /* noop */ }
          return;
        }
        local = created;
        instanceRef.current = created;
        created.on('click', (params) => {
          const cb = onPointClickRef.current;
          if (!cb || !params?.value) return;
          const [x, y] = params.value;
          cb({ x, y, traceName: params.seriesName ?? null });
        });
        // Watch the host element. ChartGPU's canvas resizes itself, but
        // the axis/grid layout is computed by ChartGPU at create time
        // (and only re-computed when `resize()` is called). Without
        // this observer, the plot would scale but the axes would stay
        // pinned at their original pixel positions.
        if (typeof ResizeObserver === 'function') {
          resizeObserver = new ResizeObserver(() => scheduleResize(created));
          resizeObserver.observe(node);
        }
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();

    return () => {
      cancelled = true;
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      if (resizeObserver) {
        try { resizeObserver.disconnect(); } catch { /* noop */ }
        resizeObserver = null;
      }
      if (local && !local.disposed) {
        try { local.dispose(); } catch { /* noop */ }
      }
      instanceRef.current = null;
    };
    // We intentionally don't include `options` in deps. The mount runs
    // once; option changes flow via the setOption effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleReady]);

  // Apply options updates incrementally — no re-mount, no canvas churn.
  useEffect(() => {
    const inst = instanceRef.current;
    if (!inst || inst.disposed || !options) return;
    try { inst.setOption(options); } catch (e) {
      console.warn('[ChartGPUChart] setOption failed:', e);
    }
  }, [options]);

  if (loadError) {
    return (
      <Typography variant="caption" sx={{ color: 'error.main', p: 1 }}>
        ChartGPU load failed: {loadError}
      </Typography>
    );
  }
  if (!moduleReady) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }
  if (!options) {
    return (
      <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
        No chart data available
      </Typography>
    );
  }

  return (
    <Box
      ref={containerRef}
      sx={
        fillParent
          ? { width: '100%', height: '100%', minHeight: 0, position: 'relative' }
          : {
              width: chartSpec?.width || 320,
              height: chartSpec?.height || 220,
              position: 'relative',
            }
      }
    />
  );
}
