/**
 * useChartDAG — reactive chart subscription registry.
 *
 * Manages active charts (AI-created and extension defaults). When datasets
 * are invalidated by input control changes, re-executes chart SQL queries
 * and pushes new data to all subscribers.
 */

import { useState, useCallback, useRef } from 'react';
import { batchExecuteCharts } from './loaders.js';

let _nextId = 1;

/** Extract category names from a chart for registration in the shared color map. */
function extractCategories(plotlySpec, vegaLiteSpec, format) {
  const cats = new Set();
  if (format === 'plotly' && plotlySpec?.data) {
    for (const trace of plotlySpec.data) {
      if (trace.name) cats.add(trace.name);
    }
  } else if (format === 'vega-lite' && vegaLiteSpec?.data?.values && vegaLiteSpec?.encoding?.color?.field) {
    const field = vegaLiteSpec.encoding.color.field;
    for (const row of vegaLiteSpec.data.values) {
      if (row[field] != null) cats.add(String(row[field]));
    }
  }
  return [...cats];
}

/**
 * Build Plotly traces + layout from query rows and chart spec.
 */
function buildPlotlySpec(rows, spec) {
  if (!rows?.length) return null;

  const { chart_type, x_column, y_column, title, color_column } = spec;

  // Normalize stacked variants to a base Plotly type + stacking flags. The
  // previous version had no stacked_bar/stacked_area cases, so stacked charts
  // produced NO traces on re-exec (blank chart after a slider move).
  const base = chart_type === 'stacked_bar' ? 'bar'
    : chart_type === 'stacked_area' ? 'line'
    : chart_type;

  const makeTrace = (name, x, y) => {
    if (base === 'pie') return { type: 'pie', labels: x, values: y, ...(name != null ? { name } : {}) };
    const t = { x, y, ...(name != null ? { name } : {}) };
    if (base === 'bar') {
      t.type = 'bar';
    } else if (base === 'line') {
      t.type = 'scatter';
      if (chart_type === 'stacked_area') { t.mode = 'lines'; t.stackgroup = 'one'; }
      else { t.mode = 'lines+markers'; }
    } else if (base === 'scatter') {
      t.type = 'scatter';
      t.mode = 'markers';
    } else {
      t.type = 'scatter';
    }
    return t;
  };

  const traces = [];
  if (color_column) {
    const groups = {};
    const order = [];
    for (const row of rows) {
      const key = String(row[color_column] ?? '');
      if (!groups[key]) { groups[key] = { x: [], y: [] }; order.push(key); }
      groups[key].x.push(row[x_column]);
      groups[key].y.push(row[y_column]);
    }
    for (const name of order) traces.push(makeTrace(name, groups[name].x, groups[name].y));
  } else {
    const x = rows.map((r) => r[x_column]);
    const y = rows.map((r) => r[y_column]);
    traces.push(makeTrace(undefined, x, y));
  }

  // Minimal layout — axis titles, title, and barmode for stacked bars. The
  // shared themed-layout helper (applied at render) supplies margins, legend,
  // hover, and theme, so this stays free of render cruft.
  // No plotly `title`: every AI chart renders inside a ChartFrame whose header
  // already shows spec.title. Setting it here printed the title twice, and the
  // themed layout's tight top margin clipped the plotly copy. The frame header
  // is the one that stays readable when the chart is small, so it wins — and
  // dropping this gives the plot back its top margin.
  const layout = {
    xaxis: { title: { text: x_column } },
    yaxis: { title: { text: y_column } },
  };
  if (chart_type === 'stacked_bar') layout.barmode = 'stack';

  return { data: traces, layout };
}

/**
 * @param {function} [registerCategoriesFn] - Optional callback from CategoryColorContext
 *        to register category names when charts are created or refreshed.
 */
export default function useChartDAG(registerCategoriesFn) {
  const [charts, setCharts] = useState({});
  const refreshingRef = useRef(false);
  const registerCatsRef = useRef(registerCategoriesFn);
  registerCatsRef.current = registerCategoriesFn;

  /**
   * Register a new chart in the DAG.
   * @param {object} spec - { sql, chart_type, x_column, y_column, title?, color_column?, chart_options?, width?, height? }
   * @param {'ai'|'extension'} source
   * @param {string[]} datasets - dataset/table names this chart depends on
   * @param {object|null} initialPlotlySpec - optional pre-built Plotly spec for immediate render
   * @param {string} format - 'plotly' | 'vega-lite' | 'chartgpu' (default: 'plotly')
   * @param {object|null} vegaLiteSpec - optional Vega-Lite spec for vega-lite format
   * @returns {string} chartId
   */
  const registerChart = useCallback((spec, source, datasets, initialPlotlySpec = null, format = 'plotly', vegaLiteSpec = null) => {
    const id = `${source}-chart-${_nextId++}`;

    // Register category names in the shared color map.
    const cats = extractCategories(initialPlotlySpec, vegaLiteSpec, format);
    if (cats.length > 0 && registerCatsRef.current) {
      registerCatsRef.current(cats);
    }

    setCharts((prev) => ({
      ...prev,
      [id]: {
        id,
        source,
        spec,
        format,
        datasets: datasets || [],
        placement: 'chat',
        data: null,
        plotlySpec: initialPlotlySpec,
        vegaLiteSpec,
        version: 0,
      },
    }));
    return id;
  }, []);

  /** Remove a chart from the registry. */
  const unregisterChart = useCallback((chartId) => {
    setCharts((prev) => {
      const next = { ...prev };
      delete next[chartId];
      return next;
    });
  }, []);

  /** Remove every chart from the registry (e.g. MCP "close all charts"). */
  const clearCharts = useCallback(() => setCharts({}), []);

  /** Change chart placement (chat → floating, or back). */
  const setPlacement = useCallback((chartId, placement) => {
    setCharts((prev) => {
      const chart = prev[chartId];
      if (!chart) return prev;
      return { ...prev, [chartId]: { ...chart, placement } };
    });
  }, []);

  /**
   * Re-execute SQL for all charts that depend on any of the given dataset names.
   * Called from handleDatasetsInvalidated in App.jsx.
   */
  const refreshCharts = useCallback((datasetNames, extensionName = null) => {
    if (refreshingRef.current) return;

    const nameSet = new Set(datasetNames);
    // "demand-tldr" → "ext_demand_tldr", the schema its tables live under.
    const extPrefix = extensionName
      ? `ext_${extensionName.replace(/-/g, '_')}`
      : null;

    setCharts((prev) => {
      // Find charts whose datasets overlap with invalidated set
      const toRefresh = [];
      for (const chart of Object.values(prev)) {
        if (!chart.spec?.sql) continue;
        const overlaps = chart.datasets.some((d) => {
          // A custom-SQL chart records TABLE refs (ext_demand_tldr.forecast);
          // invalidation reports DATASET names (county-view). Those never
          // overlap textually, so name matching alone left every custom chart
          // frozen at the control values it was born with — its SQL was
          // reactive but nothing ever asked it to re-run. Matching the
          // extension's schema prefix is what actually connects the two.
          const normalized = d.replace(/\./g, '_').replace(/-/g, '_');
          if (extPrefix && normalized.startsWith(extPrefix)) return true;
          for (const name of nameSet) {
            const nameNorm = name.replace(/-/g, '_');
            if (normalized.includes(nameNorm) || nameNorm.includes(normalized)) return true;
          }
          return false;
        })
        // A chart parameterised by an extension's controls depends on that
        // extension whatever its SQL happens to reference.
        || (extensionName && (chart.spec.input_controls || []).some(
          (c) => c.extension === extensionName,
        ));
        if (overlaps) toRefresh.push(chart);
      }

      if (toRefresh.length === 0) {
        console.log('[chartDAG] no charts matched invalidated datasets:', [...nameSet]);
        return prev;
      }

      // Fire async batch refresh
      console.log('[chartDAG] refreshing charts:', toRefresh.map((c) => c.id));
      refreshingRef.current = true;
      const specs = toRefresh.map((c) => ({
        chart_id: c.id,
        sql: c.spec.sql,
        // Send the title template so the server can re-resolve its
        // {control} placeholders alongside the SQL — otherwise the chart
        // silently keeps the title it was born with.
        title_template: c.spec.title_template || null,
        input_controls: c.spec.input_controls || null,
      }));

      batchExecuteCharts(specs)
        .then((results) => {
          setCharts((current) => {
            const updated = { ...current };
            for (const chart of toRefresh) {
              const payload = results[chart.id];
              if (!payload || payload.error) continue;
              // Accept both the legacy bare-array response and the envelope
              // that carries a re-resolved title alongside the rows.
              const rows = Array.isArray(payload) ? payload : payload.rows;
              if (!rows) continue;
              const cur = updated[chart.id];
              const freshTitle = Array.isArray(payload) ? null : payload.title;
              const spec = freshTitle
                ? { ...chart.spec, title: freshTitle }
                : chart.spec;
              const patch = {
                ...cur,
                // Keep the spec's title current so the frame header tracks the
                // controls too, not just the plot.
                spec,
                data: rows,
                version: (cur?.version ?? 0) + 1,
              };
              if (cur?.format === 'vega-lite' && cur.vegaLiteSpec) {
                // Rebuild vega-lite spec with new data, preserving mark/encoding/config
                patch.vegaLiteSpec = { ...cur.vegaLiteSpec, data: { values: rows } };
              } else {
                patch.plotlySpec = buildPlotlySpec(rows, spec);
              }
              // Register any new categories from the refreshed data.
              const cats = extractCategories(patch.plotlySpec, patch.vegaLiteSpec, cur?.format);
              if (cats.length > 0 && registerCatsRef.current) {
                registerCatsRef.current(cats);
              }
              updated[chart.id] = patch;
            }
            return updated;
          });
        })
        .then(() => console.log('[chartDAG] refresh complete'))
        .catch((err) => console.warn('[chartDAG] batch refresh failed:', err))
        .finally(() => { refreshingRef.current = false; });

      return prev; // State update happens async above
    });
  }, []);

  /** Get all charts with a given placement. */
  const getChartsByPlacement = useCallback((placement) => {
    return Object.values(charts).filter((c) => c.placement === placement);
  }, [charts]);

  /** Get a specific chart by ID. */
  const getChart = useCallback((chartId) => charts[chartId] ?? null, [charts]);

  return {
    charts,
    registerChart,
    unregisterChart,
    clearCharts,
    setPlacement,
    refreshCharts,
    getChartsByPlacement,
    getChart,
  };
}
