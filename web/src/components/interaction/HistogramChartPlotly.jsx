import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@mui/material/styles';
import { computeHistogram } from '../../lib/entityTimeseries.js';
import { tagChartDraw } from '../../lib/chartDebug.js';

/**
 * HistogramChartPlotly — Plotly-backed sibling of HistogramChartGPU.
 * Renders a bar histogram of an entity's timeseries values.
 */
export default function HistogramChartPlotly({
  timeseries,
  clockState,
  mode = 'full',
  windowSize = 168,
  width: containerWidth,
  height: containerHeight,
}) {
  const containerRef = useRef(null);
  const [Plotly, setPlotly] = useState(null);
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const primaryColor = theme.palette.primary.main;

  useEffect(() => {
    let cancelled = false;
    import('plotly.js-basic-dist-min').then((mod) => {
      if (!cancelled) setPlotly(() => mod.default || mod);
    }).catch((err) => {
      console.warn('[HistogramChartPlotly] failed to load plotly:', err);
    });
    return () => { cancelled = true; };
  }, []);

  const { edges, counts } = useMemo(() => {
    if (mode === 'rolling') {
      const start = Math.max(0, clockState.index - windowSize);
      const end = Math.min(timeseries.values.length, clockState.index + 1);
      return computeHistogram(timeseries.values.slice(start, end), 30);
    }
    return computeHistogram(timeseries.values, 50);
  }, [timeseries, clockState.index, mode, windowSize]);

  const labels = useMemo(
    () => edges.slice(0, -1).map((e, i) => `${e.toFixed(1)}–${edges[i + 1].toFixed(1)}`),
    [edges],
  );

  // Tick thinning — show every Nth label.
  const { tickvals, ticktext } = useMemo(() => {
    const step = Math.max(1, Math.floor(labels.length / 8));
    const tv = [];
    const tt = [];
    for (let i = 0; i < labels.length; i++) {
      if (i % step === 0) {
        tv.push(labels[i]);
        tt.push(labels[i]);
      }
    }
    return { tickvals: tv, ticktext: tt };
  }, [labels]);

  useEffect(() => {
    if (!Plotly || !containerRef.current || !edges.length) return;
    const fg = isDark ? '#ccc' : '#333';
    const grid = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
    const traces = [{
      type: 'bar',
      x: labels,
      y: counts,
      marker: { color: primaryColor },
      hoverinfo: 'x+y',
    }];
    const layout = {
      margin: { l: 48, r: 12, t: 8, b: 36 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: { color: fg, size: 11 },
      showlegend: false,
      xaxis: {
        type: 'category',
        title: { text: 'Value', font: { size: 11, color: fg } },
        tickvals,
        ticktext,
        gridcolor: grid,
        fixedrange: true,
      },
      yaxis: {
        title: { text: 'Count', font: { size: 11, color: fg } },
        gridcolor: grid,
        fixedrange: true,
      },
      bargap: 0.05,
    };
    tagChartDraw(containerRef.current, 'HistogramChartPlotly', { responsive: true });
    Plotly.react(containerRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    }).catch((err) => {
      console.warn('[HistogramChartPlotly] react failed:', err);
    });
  }, [Plotly, edges, counts, labels, tickvals, ticktext, isDark, primaryColor]);

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

  if (!edges.length) {
    return <div style={{ color: '#888', fontSize: 12, padding: 8 }}>No data for histogram</div>;
  }

  const w = containerWidth || '100%';
  const h = containerHeight || 180;
  return <div ref={containerRef} style={{ width: w, height: h }} />;
}
