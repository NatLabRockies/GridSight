import { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';
import { tagChartDraw } from '../../lib/chartDebug.js';
import { valueAxisTitle } from '../../lib/formatFieldLabel.js';

// Tight default margins. Plotly's stock margins (t:100/l:80…) leave a wide
// dead band between the resizable frame edge and the drawn plot — very
// obvious on the large display wall. We trim to the minimum and lean on
// `automargin` (set in the themed layout) to grow back just enough room for
// whatever tick labels / axis titles a given chart actually needs, so the
// plot fills its frame without clipping.
// b: 52 leaves room for the horizontal legend row below the x-axis.
const DEFAULT_MARGIN = { t: 8, r: 12, b: 52, l: 44 };

// Estimate the widest y-axis tick label (in characters) so a STATIC left
// margin can replace automargin under the display scale. Vertical charts have
// numeric y ticks, which Plotly renders in its SI style ("999.9M" worst case);
// horizontal bars put category strings on y (state names etc.).
function estimateYTickChars(traces) {
  let maxChars = 2;
  let maxAbs = 0;
  let sawNumeric = false;
  let hasNeg = false;
  for (const t of traces || []) {
    for (const v of t?.y || []) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        sawNumeric = true;
        if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
        if (v < 0) hasNeg = true;
      } else if (v != null) {
        maxChars = Math.max(maxChars, Math.min(String(v).length, 24));
      }
    }
  }
  if (sawNumeric) {
    const suffix = maxAbs >= 1e3 ? 1 : 0;      // k / M / B / T
    maxChars = Math.max(maxChars, 5 + suffix + (hasNeg ? 1 : 0)); // "999.9M", "-…"
  }
  return maxChars;
}

/**
 * Apply GridSight's chart chrome to a Plotly layout: transparent bg, themed
 * font, no drag-to-zoom, unified hover, tight margins + automargin, and the
 * horizontal legend below the plot. Shared by PlotlyChart (extension/AI charts
 * built from rows) AND PlotlyInline (pre-built AI specs) so both render
 * identically. Server-side layout cruft (a forced template, fixed width/height,
 * loose margins) is stripped so the frame-responsive chrome governs; the
 * meaningful bits (title, axis titles, barmode, …) are preserved.
 *
 * automargin is DISABLED under the display scale (body{zoom}): Plotly measures
 * tick-label boxes with getBoundingClientRect, which under zoom returns
 * VISUALLY-scaled (S×) sizes while the layout works in logical px — on small
 * charts the labels "never fit", automargin loops to its redraw cap ("Too many
 * auto-margin redraws") and bails with bloated margins. Instead the left
 * margin is computed statically from the widest y tick label (pass `traces`),
 * so the loop cannot occur. At scale 1 automargin behaves and stays on.
 */
export function buildThemedPlotlyLayout(baseLayout = {}, {
  isDark, displayScale = 1, width, height, traceCount = 2, traces = null,
  // Actual theme colors when the caller has them (from MUI's palette); fall
  // back to sensible dark/light defaults otherwise.
  bgColor, textColor, borderColor,
  // UI typeface (Settings > Font) so charts match the surrounding app rather
  // than sitting in Plotly's own default face. Optional: callers that don't
  // pass it keep Plotly's default.
  fontFamily,
} = {}) {
  const zoomed = displayScale !== 1;
  const paperColor = bgColor || (isDark ? '#232323' : '#ffffff');
  const inkColor = textColor || (isDark ? '#e6e6e6' : '#222222');
  const lineColor = borderColor || (isDark ? '#555' : '#cccccc');
  // Plotly.js v3 removed the string-title compatibility shim: an axis/chart
  // title must be an object `{ text }`, and a plain string is silently dropped.
  // Our specs (and buildTraces' derived titles) use plain strings, so coerce —
  // this is why axis unit labels vanished after the Plotly 3.x bump.
  const normTitle = (t) => (typeof t === 'string' ? { text: t } : t);
  const axisDefaults = (ax) => {
    const a = {
      gridcolor: isDark ? '#333' : '#ddd',
      automargin: !zoomed,
      tickfont: { size: 11 },
      ...ax,
    };
    if (a.title != null) {
      a.title = normTitle(a.title);
      // Axis titles a step above the tick labels. At a uniform 11px the label
      // and the numbers under it read as one block; the axis title is naming
      // the dimension and should sit visually above the values.
      a.title = { font: { size: 13 }, ...a.title };
    }
    return a;
  };
  const {
    template: _t, width: _w, height: _h, margin: _m,
    paper_bgcolor: _p, plot_bgcolor: _pb, autosize: _a,
    ...rest
  } = baseLayout || {};

  // Under the wall's body{zoom:S}, the chart is laid out at LOGICAL pixels and
  // then visually scaled S×, so Plotly picks far too few axis ticks for the
  // apparent size — the axis looks like it "runs out" of tick labels. Ask for
  // ~one tick per 100 *visual* px (≈ S× more ticks) when the chart spec hasn't
  // pinned tick spacing itself. nticks is a soft cap; Plotly still rounds to a
  // "nice" interval.
  const bumpTicks = (ax, lenPx) => {
    const a = axisDefaults(ax);
    if (displayScale > 1 && lenPx > 0
        && a.dtick == null && a.tickvals == null && a.nticks == null) {
      a.nticks = Math.max(2, Math.round((lenPx * displayScale) / 100));
    }
    return a;
  };

  const hasLegend = rest.showlegend === true
    || (rest.showlegend !== false && traceCount > 1);
  const _xt = rest.xaxis?.title;
  const hasXTitle = !!(typeof _xt === 'string' ? _xt : _xt?.text);
  const computedMargin = (() => {
    let l = DEFAULT_MARGIN.l;
    let b = hasLegend ? DEFAULT_MARGIN.b : 30;
    // Reserve the axis-title band too, or pushing the legend below it just
    // moves the collision off the bottom edge instead of resolving it.
    if (hasLegend && hasXTitle) b += 26;
    if (zoomed) {
      l = Math.min(170, Math.max(44, 12 + Math.round(estimateYTickChars(traces) * 6.6)));
      if (rest.yaxis?.title) l += 20;
      if (hasXTitle) b += 20;
    }
    return { ...DEFAULT_MARGIN, l, b };
  })();

  return {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: isDark ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)',
    font: { color: inkColor, size: 11, ...(fontFamily ? { family: fontFamily } : {}) },
    dragmode: false,
    hovermode: 'x unified',
    // Hover card follows the app theme instead of Plotly's default white bg +
    // dim grey text (unreadable in dark mode).
    hoverlabel: {
      bgcolor: paperColor,
      bordercolor: lineColor,
      font: { color: inkColor, size: 11, ...(fontFamily ? { family: fontFamily } : {}) },
    },
    // The horizontal legend sits in a row below the x-axis; DEFAULT_MARGIN.b
    // reserves space for it. When no legend actually renders — a single trace,
    // or the spec explicitly sets showlegend:false (e.g. seds_state_history,
    // multi-fuel but legend suppressed) — that band is dead space, very visible
    // at high display scale (b*scale px). Match Plotly's own legend rule so we
    // only reserve the row when a legend will really show. Under zoom (static
    // margins, automargin off) l is sized to the widest y tick label and axis
    // titles get their band added explicitly.
    margin: computedMargin,
    ...rest,
    // Same v3 string-title coercion for the main chart title.
    ...(rest.title != null ? { title: normTitle(rest.title) } : {}),
    xaxis: bumpTicks(rest.xaxis, width),
    yaxis: bumpTicks(rest.yaxis, height),
    // The horizontal legend and the x-axis TITLE both live under the plot, and
    // a fixed y: -0.12 put the legend straight through the title whenever a
    // chart had one. Push it below the title's band when one is present —
    // expressed in pixels and converted to the paper fraction Plotly wants, so
    // the offset stays constant instead of growing with the chart.
    legend: {
      orientation: 'h',
      font: { size: 10 },
      ...(rest.legend || {}),
      // Computed y wins over anything the spec pins. A chart_options legend
      // carrying `y: -0.12` (demand-tldr's Top 15 Counties did) reintroduced
      // the exact overlap this calculation exists to prevent — and the spec
      // cannot know the margins the renderer just computed, so it is not in a
      // position to choose. Everything else about the spec's legend is kept.
      y: (() => {
        // Plotly measures legend y against the PLOT AREA, not the container.
        // Dividing by container height landed almost exactly on the old -0.12
        // (44/360 = 0.122), which is why the legend kept sitting on the axis
        // title. The plot area is the container minus its own margins.
        const plotH = Math.max(80, (height || 0) - computedMargin.t - computedMargin.b);
        const px = 20 + (hasXTitle ? 30 : 0);
        return height > 0 ? -(px / plotH) : (hasXTitle ? -0.3 : -0.14);
      })(),
      yanchor: 'top',
      x: rest.legend?.x ?? 0.5,
      xanchor: rest.legend?.xanchor ?? 'center',
    },
  };
}

/**
 * Defeat a Plotly quirk under the wall's nested CSS zoom: it flags some axis
 * tick labels display:none even when they fit — the measurements are correct
 * and the labels don't overlap — so the axis looks like it "runs out" of
 * labels partway across. After a render, force any hidden tick labels back to
 * visible. Only needed under display scale (at scale 1 Plotly behaves), and
 * safe because the labels genuinely fit at the rendered size.
 */
export function unhideTickLabels(node, displayScale = 1) {
  if (!node || displayScale === 1) return;
  try {
    node.querySelectorAll('.xtick text, .ytick text').forEach((t) => {
      if (t.style.display === 'none') t.style.display = '';
    });
  } catch { /* noop */ }
}

/**
 * Transform row data into Plotly traces based on chart type.
 */
function buildTraces(data, chartType, chartOptions, isDark = false) {
  if (!data?.length) return { data: [], layout: {} };

  if (chartType === 'plotly' && chartOptions?.traces) {
    return { data: chartOptions.traces, layout: chartOptions.layout || {} };
  }

  const horizontal = chartType === 'bar' && chartOptions?.orientation === 'h';
  // Opt-in per-segment outline (chart_options.bar_outline). A hairline edge so
  // dark fills (e.g. petroleum/coal) don't blend into a dark chart background.
  // Plotly outlines each stacked segment's full rectangle (not just the stack
  // silhouette), so keep it thin + low-alpha: the internal segment boundaries
  // read as faint separators rather than harsh dividers. Light edge on dark
  // theme, subtle dark edge on light.
  const barLine = (chartType === 'bar' && chartOptions?.bar_outline)
    ? { color: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(40,40,40,0.25)', width: 0.5 }
    : null;
  const plotlyType = chartType === 'bar' ? 'bar'
    : chartType === 'scatter' ? 'scatter'
    : 'scatter';
  const plotlyMode = chartType === 'line' ? 'lines'
    : chartType === 'scatter' ? 'markers'
    : undefined;

  // Long-format mode: extension declares chart_options.category_axis and
  // value_axis (and optionally time_axis). We pivot here so each category
  // becomes its own Plotly trace — Plotly then auto-legends by trace name.
  // This keeps ScenarioChartBody's category-aware legend in sync (it reads
  // chart_options.category_axis to drive its own per-category swatches).
  const catAxis = chartOptions?.category_axis;
  const valAxis = chartOptions?.value_axis;
  const tsAxis = chartOptions?.time_axis;
  // Optional display rescale: divide the value axis by value_scale so a chart
  // whose data is in a small base unit (Billion BTU, MWh) can present a natural
  // one (Quadrillion BTU, TWh) with human-scale ticks. The SQL/data stay in the
  // base unit; only the rendered values + declared value_unit change.
  // TODO(units): interim stopgap — unit conversion/scaling should live in the
  // data layer so the renderer only draws a packet + labels. Revisit after the
  // demand100 units branch (ndr/units-2) merges; then delete value_scale here
  // and in ChartGPUChart.jsx. See project_units_direction memory.
  const valueScale = Number(chartOptions?.value_scale) || 1;

  if (catAxis && valAxis && tsAxis) {
    // Stable category order = first-seen order in the data (SQL's responsibility).
    const seenCats = [];
    const catRows = new Map(); // cat -> Map(ts -> value)
    const seenTs = [];
    const tsSeen = new Set();
    for (const r of data) {
      const c = r[catAxis];
      const t = r[tsAxis];
      if (c == null || t == null) continue;
      if (!catRows.has(c)) { catRows.set(c, new Map()); seenCats.push(c); }
      catRows.get(c).set(t, (Number(r[valAxis]) || 0) / valueScale);
      if (!tsSeen.has(t)) { tsSeen.add(t); seenTs.push(t); }
    }
    const categoryColors = chartOptions?.category_colors || {};
    const traces = seenCats.map((cat) => {
      const m = catRows.get(cat);
      const yVals = seenTs.map((t) => (m.has(t) ? m.get(t) : null));
      const trace = horizontal
        ? { x: yVals, y: seenTs, name: String(cat), orientation: 'h' }
        : { x: seenTs, y: yVals, name: String(cat) };
      trace.type = plotlyType;
      if (plotlyMode) trace.mode = plotlyMode;
      if (categoryColors[cat] || barLine) {
        trace.marker = {
          ...(categoryColors[cat] ? { color: categoryColors[cat] } : {}),
          ...(barLine ? { line: barLine } : {}),
        };
      }
      return trace;
    });
    // Derive a readable value-axis title from value_label (+ value_unit) so
    // every chart carries a unit label even when the spec omits an explicit
    // axis title; the raw column name is the last-resort fallback.
    const valTitle = valueAxisTitle(chartOptions, valAxis);
    const tsKey = horizontal ? 'yaxis' : 'xaxis';
    const valKey = horizontal ? 'xaxis' : 'yaxis';
    const specLayout = chartOptions?.layout || {};
    const layout = {
      margin: { ...DEFAULT_MARGIN },
      ...specLayout,
      // Deep-merge the axis objects: the derived title is the default, but the
      // spec's own axis config (title, type, automargin, …) layers on top —
      // so a spec that sets e.g. { type: 'category' } no longer wipes the title.
      [tsKey]: { title: tsAxis, ...(specLayout[tsKey] || {}) },
      [valKey]: { title: valTitle, ...(specLayout[valKey] || {}) },
    };
    return { data: traces, layout };
  }

  // Wide-format fallback: every column except the first (or 'label'/'x'/'name')
  // is a separate trace. Used by simple single-series charts.
  const columns = Object.keys(data[0]);
  const xCol = columns.find((c) => c === 'label' || c === 'x' || c === 'name') || columns[0];
  const valueCols = columns.filter((c) => c !== xCol && c !== 'color');
  const xValues = data.map((r) => r[xCol]);
  const traces = valueCols.map((col) => {
    const values = data.map((r) => {
      const v = Number(r[col]);
      return Number.isFinite(v) ? v / valueScale : r[col];
    });
    const trace = horizontal
      ? { x: values, y: xValues, name: col, orientation: 'h' }
      : { x: xValues, y: values, name: col };
    trace.type = plotlyType;
    if (plotlyMode) trace.mode = plotlyMode;
    if (barLine) trace.marker = { line: barLine };
    return trace;
  });
  const catKey = horizontal ? 'yaxis' : 'xaxis';
  const valKey = horizontal ? 'xaxis' : 'yaxis';
  const wideSpecLayout = chartOptions?.layout || {};
  const layout = {
    margin: { ...DEFAULT_MARGIN },
    ...wideSpecLayout,
    [catKey]: { title: xCol, ...(wideSpecLayout[catKey] || {}) },
    // Only assert a value-axis title when the spec declared a label/unit —
    // multi-series wide charts otherwise have no single meaningful value name.
    ...((chartOptions?.value_label || chartOptions?.value_unit)
      ? { [valKey]: { title: valueAxisTitle(chartOptions, undefined), ...(wideSpecLayout[valKey] || {}) } }
      : {}),
  };
  return { data: traces, layout };
}

/**
 * PlotlyChart — lazy-loaded Plotly.js renderer for extension charts.
 *
 * Props:
 *   data         row objects from the chart data API
 *   chartSpec    { chart_type, chart_options, width, height }
 *   onPointClick optional ({x, y, traceName}) callback
 *   fillParent   when true, the wrapper Box fills its parent (100% × 100%)
 *                instead of pinning to chartSpec.width/height. Used by
 *                resizable chart frames so the chart tracks the frame.
 */
export default function PlotlyChart({ data, chartSpec, onPointClick, fillParent }) {
  const containerRef = useRef(null);
  const [Plotly, setPlotly] = useState(null);
  const [loading, setLoading] = useState(true);
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { scale: displayScale } = useDisplayScale();
  // Measured container size, only tracked under display scale (the wall).
  // Plotly's responsive autosize misreads the container under `body { zoom }`
  // and bails mid auto-margin, leaving every chart past the first couple
  // blank. Feeding explicit integer dims once the ResizeObserver reports a
  // real size forces each chart to (re)draw at the right size regardless of
  // mount order or whether it was below the fold at first paint.
  const [size, setSize] = useState({ w: 0, h: 0 });

  // Lazy-load Plotly
  useEffect(() => {
    let cancelled = false;
    import('plotly.js-basic-dist-min').then((mod) => {
      if (!cancelled) {
        setPlotly(() => mod.default || mod);
        setLoading(false);
      }
    }).catch((err) => {
      console.warn('[PlotlyChart] Failed to load plotly.js:', err);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  // Check if we have direct plotly traces (no row data needed)
  const hasDirectTraces = chartSpec?.chart_type === 'plotly' && chartSpec?.chart_options?.traces;

  // Stable JSON key for chart_options so a new object reference from the
  // parent (e.g. parent re-fetched specs and rebuilt the array with the
  // same content) doesn't re-fire the data sync. Plotly.react diffs cheap
  // when nothing actually changed, but the old code's `chartSpec` dep
  // combined with a `Plotly.purge` cleanup wiped + redrew on every render
  // — that's the visible flash when an unrelated control changes.
  const chartType = chartSpec?.chart_type || 'line';
  const optionsKey = JSON.stringify(chartSpec?.chart_options ?? null);

  useEffect(() => {
    if (!Plotly || !containerRef.current) return;
    if (!hasDirectTraces && !data?.length) return;

    // Under the display scale (body `zoom`), Plotly's responsive autosize
    // measures the container in zoomed/fractional pixels, so `automargin`
    // never converges — it hits the redraw cap, warns "Too many auto-margin
    // redraws", and bails, leaving the plot squished or blank. Feeding
    // explicit INTEGER dimensions from the measured container size gives
    // auto-margin a stable base so it converges. At scale 1 we keep
    // responsive autosize (no behavior change).
    //
    // `size` comes from the ResizeObserver — but it's only populated while
    // displayScale !== 1. When the scale FLIPS on a live page (the wall's
    // auto mode reacting to a screen change, or DevTools display emulation),
    // this effect runs before the debounced observer has measured, `size` is
    // still {0,0}, and the old code fell back to the responsive+automargin
    // draw — one warning burst + bailed margins per mounted chart. Measure
    // synchronously from the node in that window instead; never draw a
    // zoomed chart through the responsive path.
    const node = containerRef.current;
    let w = size.w;
    let h = size.h;
    if (displayScale !== 1 && (!(w > 0) || !(h > 0))) {
      w = node.clientWidth;
      h = node.clientHeight;
      if (!(w > 0) || !(h > 0)) return; // not laid out yet — observer will re-fire
    }
    const useExplicitSize = displayScale !== 1;

    const { data: traces, layout } = buildTraces(
      data,
      chartType,
      chartSpec?.chart_options,
      isDark,
    );

    const themedLayout = buildThemedPlotlyLayout(layout, {
      isDark, displayScale, width: w, height: h,
      traceCount: traces.length, traces,
      bgColor: theme.palette.background.paper,
      fontFamily: theme.typography?.fontFamily,
      textColor: theme.palette.text.primary,
      borderColor: theme.palette.divider,
    });

    if (useExplicitSize) {
      themedLayout.width = w;
      themedLayout.height = h;
      themedLayout.autosize = false;
    }

    tagChartDraw(node, 'PlotlyChart', {
      displayScale, w, h, explicit: useExplicitSize, sizeState: `${size.w}x${size.h}`,
    });
    Plotly.react(node, traces, themedLayout, {
      responsive: !useExplicitSize,
      displayModeBar: false,
      scrollZoom: false,
      doubleClick: false,
    }).then(() => unhideTickLabels(node, displayScale));
    // No purge in cleanup — Plotly.react handles incremental updates.
    // The purge-on-unmount lives in a separate effect below so the chart
    // doesn't get wiped between renders when chartSpec identity churns.
  }, [Plotly, data, chartType, optionsKey, isDark, hasDirectTraces, displayScale, size]);

  // Unmount cleanup — runs once when the component is removed (popup
  // dismissed, layer hidden, etc.), not between renders.
  useEffect(() => {
    const node = containerRef.current;
    return () => {
      if (Plotly && node) Plotly.purge(node);
    };
  }, [Plotly]);

  // Explicit resize on container size change. Plotly's `responsive: true`
  // claims to handle this but in practice it only listens to window
  // resize — not to flexbox / ResizableChartContainer drag handles, which
  // is what our chart frames use. A ResizeObserver firing Plotly.Plots
  // .resize() makes the chart follow its frame.
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const node = containerRef.current;
    let timer = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      // Coalesce — drag-resizing fires many ticks; we only want the
      // settled size.
      timer = setTimeout(() => {
        timer = null;
        const w = node.clientWidth;
        const h = node.clientHeight;
        if (displayScale !== 1) {
          // Under display scale, push the measured size into state so the
          // draw effect redraws with explicit integer dims (matching the
          // react path) and auto-margin stays converged. Plots.resize would
          // re-trigger the zoomed/fractional autosize loop.
          if (w > 0 && h > 0) {
            setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
          }
        } else if (Plotly) {
          // At scale 1, Plotly's own responsive layout handles window
          // resize but not flexbox / drag-handle container resize — a
          // Plots.resize makes the chart follow its frame.
          try { Plotly.Plots.resize(node); } catch { /* noop */ }
        }
      }, 50);
    };
    let observer = null;
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(trigger);
      observer.observe(node);
    }
    trigger(); // measure once on mount so the first real size lands quickly
    return () => {
      if (timer) clearTimeout(timer);
      if (observer) { try { observer.disconnect(); } catch { /* noop */ } }
    };
  }, [Plotly, displayScale]);

  // Two-way binding: when the consumer passes onPointClick, attach a
  // plotly_click listener so clicking a data point fires the callback
  // with the underlying x/y. Used by scenario controls (e.g. SEDS
  // year slider → click a bar to jump the map to that year).
  useEffect(() => {
    if (!Plotly || !containerRef.current || !onPointClick) return;
    const node = containerRef.current;
    const handler = (ev) => {
      const p = ev?.points?.[0];
      if (!p) return;
      onPointClick({ x: p.x, y: p.y, traceName: p.data?.name });
    };
    // node.on is added by Plotly after the first react() call. Schedule
    // the attach in a microtask so we don't miss the first paint when
    // PlotlyChart and the click handler mount together.
    let attached = false;
    const tryAttach = () => {
      if (typeof node.on === 'function') {
        node.on('plotly_click', handler);
        attached = true;
      }
    };
    tryAttach();
    if (!attached) queueMicrotask(tryAttach);
    return () => {
      if (attached && typeof node.removeAllListeners === 'function') {
        node.removeAllListeners('plotly_click');
      }
    };
  }, [Plotly, onPointClick, optionsKey, data]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (!hasDirectTraces && !data?.length) {
    return (
      <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
        No chart data available
      </Typography>
    );
  }

  // In a resizable frame, fill the parent so Plotly's responsive layout
  // + our ResizeObserver above can track the actual drawn size. With a
  // fixed-pixel Box the chart never grows past the chartSpec's declared
  // width/height even if the frame is bigger. Outside a frame (legacy
  // entity popups), pin to the spec dimensions for back-compat.
  //
  // Fill via absolute inset:0 rather than height:100%. Under the wall's
  // `body { zoom }`, a percentage-height chain collapses (the container's
  // clientHeight reads a small content-driven value), so the explicit-size
  // path locked Plotly's HEIGHT to that collapsed value while WIDTH (which
  // resolves against a definite-width ancestor) tracked the frame — charts
  // capped on height but not width. Absolute positioning fills the nearest
  // positioned ancestor's box (every fillParent wrapper is position:relative
  // with content-independent sizing), so clientHeight tracks the frame at any
  // display scale.
  return (
    <Box
      ref={containerRef}
      sx={
        fillParent
          ? { position: 'absolute', inset: 0, minHeight: 0 }
          : {
              width: chartSpec?.width || 300,
              height: chartSpec?.height || 200,
            }
      }
    />
  );
}
