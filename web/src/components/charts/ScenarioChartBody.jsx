/**
 * ScenarioChartBody — one chart inside a (possibly multi-chart) ChartFrame.
 *
 * Owns the per-chart concerns: data fetch, partition stats, legend state,
 * play-state overlay. Takes shared toolbar settings (displayMode, windowSize,
 * unit, stackOrder) from the parent ScenarioChartsPanel so all charts in one
 * frame share those controls.
 *
 * Adding/removing this component does NOT affect the frame's chrome — the
 * header, anchor menu, close button, combine menu all live on the frame.
 */

import { useEffect, useMemo, useState, Suspense } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import CallSplitIcon from '@mui/icons-material/CallSplit';
import { useTheme } from '@mui/material/styles';

import { fetchChartData, fetchExtensionCharts, setInputControl } from '../../lib/loaders.js';
import { getChartComponent } from '../../lib/chartRegistry.js';

// Process-level cache for scenario chart data. Re-mounts (e.g. docking a
// floating frame causes re-parenting → remount) otherwise re-fetch, which
// produces a transient "No data" flash even though the server is returning
// the same rows. Chart data is stable for (ext, chart, project, scenario)
// within a session, so we cache indefinitely; a browser refresh is the only
// way to pick up mid-session re-ingestion.
const _chartDataCache = new Map();
function cacheKey(extName, chartName, project, scenario, entityId = '') {
  return `${extName}::${chartName}::${project}::${scenario}::${entityId}`;
}

export default function ScenarioChartBody({
  extensionName,
  chartSpec,
  project,
  scenario,
  // Optional — non-empty for entity-scoped charts (popped out from a
  // tooltip). Threaded into fetchChartData and the cache key so two
  // entities of the same chart spec don't trample each other.
  entityId = '',
  clockState,
  onScrub,
  // Shared toolbar state (from the parent frame)
  displayMode,
  windowSize,
  unit,                          // 'MW' | 'GW' | 'TW'
  stackOrder,
  // Multi-chart affordances
  showTitle = false,             // true when the frame holds >1 chart
  onSplit,                       // () => void — extract this chart into its own frame
  // Two-way binding hook. Fired when a chart point-click POST succeeds
  // and the server reports invalidated datasets; consumer should call
  // App.jsx's handleDatasetsInvalidated (refresh map + bump refresh key).
  onInputControlInvalidated,     // (extName, datasets: string[]) => void
  // Bumped when an input control changes (synced across tabs via the
  // 'controls' channel). Drives a re-fetch of both the spec and the data so
  // the chart tracks the current control selection even though its name is
  // now stable (no control-state token).
  refreshKey = 0,
}) {
  const theme = useTheme();

  // Effective spec — re-resolved on refresh because chart_type AND
  // chart_options can change with controls (e.g. SEDS single→multi sector
  // flips a line chart to a stacked bar). The App-level effect busts the
  // ext-charts cache on `refreshKey` so this returns the current spec.
  const [effectiveSpec, setEffectiveSpec] = useState(chartSpec);
  useEffect(() => {
    let cancelled = false;
    fetchExtensionCharts(extensionName)
      .then((specs) => {
        if (cancelled) return;
        // Match on the (stable) prop name — `spec` isn't declared yet here.
        const found = (specs || []).find((s) => s.name === chartSpec.name);
        if (found) setEffectiveSpec(found);
      })
      .catch(() => { /* keep last good spec */ });
    return () => { cancelled = true; };
  }, [extensionName, chartSpec.name, refreshKey]);
  const spec = effectiveSpec || chartSpec;

  // Seed from the process-level cache so remounts (e.g. anchor-mode change
  // re-parents the frame into a ChartDock) don't flash "no data" while a
  // fresh fetch is in flight. When the fetch resolves we update both state
  // and the cache.
  const initialKey = cacheKey(extensionName, spec.name, project, scenario, entityId);
  const [data, setData] = useState(() => _chartDataCache.get(initialKey) ?? null);
  const [error, setError] = useState(null);
  const [hiddenCategories, setHiddenCategories] = useState(() => new Set());

  // Fetch data for this (extName, chartName, project, scenario, entityId).
  useEffect(() => {
    let cancelled = false;
    const key = cacheKey(extensionName, spec.name, project, scenario, entityId);
    // If the cache has it, use immediately — no flash. Still fire the
    // fetch so the cache refreshes in case data changed server-side.
    const cached = _chartDataCache.get(key);
    if (cached) {
      setData(cached);
      setError(null);
    }
    fetchChartData(extensionName, spec.name, {
      entityId, project, scenario,
    })
      .then((rows) => {
        if (cancelled) return;
        if (rows?.error) {
          console.warn('[ScenarioChartBody fetch]', spec.name,
            'server error:', rows.error);
          setError(rows.error);
          return;
        }
        const n = Array.isArray(rows) ? rows.length : 0;

        // Guard against cache poisoning by a transient empty result. If
        // we've previously fetched non-empty data for this (ext, chart,
        // project, scenario), a sudden empty response is almost always a
        // server-side race (e.g. gat_db detach-reattach), not a real
        // change. Keep the populated state; log so we notice.
        const prior = _chartDataCache.get(key);
        if (n === 0 && Array.isArray(prior) && prior.length > 0) {
          console.warn('[ScenarioChartBody fetch]', spec.name,
            'dropping empty response; keeping previous', prior.length, 'rows');
          return;
        }

        _chartDataCache.set(key, rows);
        setData(rows);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[ScenarioChartBody fetch]', spec.name,
          'network/parse error:', e);
        setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [extensionName, spec.name, project, scenario, entityId, refreshKey]);

  const ChartComponent = getChartComponent(spec.chart_type);
  const isScrubber = String(spec.chart_type || '').startsWith('scrubber-');

  // Two-way binding: when an extension's chart_options declares a
  // `click_control` name, clicking a Plotly data point pushes the
  // clicked x-value to that input control via the same POST path
  // InputControlPanel uses. On success, forward the response's
  // invalidated_datasets to the host (same-tab via callback; cross-tab
  // via the 'controls:effects' bus channel) so the map + dependent
  // charts refetch.
  const clickControl = spec.chart_options?.click_control;
  const handlePointClick = useMemo(() => {
    if (!clickControl || !extensionName) return undefined;
    return async ({ x }) => {
      if (x == null) return;
      const coerced = Number.isFinite(Number(x)) ? Number(x) : x;
      try {
        const result = await setInputControl(
          extensionName, project, scenario, clickControl, coerced,
        );
        const ds = result?.invalidated_datasets;
        if (Array.isArray(ds) && ds.length && onInputControlInvalidated) {
          onInputControlInvalidated(extensionName, ds);
        }
      } catch (e) {
        console.warn('[ScenarioChartBody] click→control failed:', e);
      }
    };
  }, [clickControl, extensionName, project, scenario, onInputControlInvalidated]);
  // Either axis partitions the data into named series — drives the legend.
  const partitionAxis = spec.chart_options?.category_axis
    || spec.chart_options?.series_axis
    || null;
  const partitionColors = spec.chart_options?.category_colors
    || spec.chart_options?.series_colors
    || {};
  const hasPartitioning = !!partitionAxis;
  // Unit only applies to MW-family charts; others (loading %, etc.) ignore it.
  const valueUnit = spec.chart_options?.value_unit;
  const unitApplies = !valueUnit || ['MW', 'GW', 'TW'].includes(valueUnit);
  const effectiveUnit = unitApplies ? unit : undefined;

  const valueAxis = spec.chart_options?.value_axis || 'value';
  const timeAxis = spec.chart_options?.time_axis || 'timestamp';
  const canonicalOrder = spec.chart_options?.category_order;

  // Local hour-precision timestamp array, derived from the chart's data.
  // We need this to compute the playhead time correctly — see clock.js.
  const sortedTimestampMs = useMemo(() => {
    if (!Array.isArray(data) || !data.length) return [];
    const seen = new Set();
    for (const row of data) {
      const tsStr = row?.[timeAxis];
      if (!tsStr) continue;
      const ms = new Date(tsStr).getTime();
      if (Number.isFinite(ms)) seen.add(ms);
    }
    return Array.from(seen).sort((a, b) => a - b);
  }, [data, timeAxis]);

  const stats = useMemo(() => {
    if (!data?.length || !partitionAxis) {
      return { totals: new Map(), means: new Map(), stds: new Map(), allCats: [] };
    }
    const series = new Map();
    for (const row of data) {
      const cat = row[partitionAxis];
      const ts = row[timeAxis];
      const val = Number(row[valueAxis]) || 0;
      if (cat == null || ts == null) continue;
      if (!series.has(cat)) series.set(cat, []);
      series.get(cat).push(val);
    }
    const totals = new Map();
    const means = new Map();
    const stds = new Map();
    for (const [cat, arr] of series) {
      const sum = arr.reduce((a, b) => a + b, 0);
      const mean = arr.length ? sum / arr.length : 0;
      let v = 0;
      for (const x of arr) v += (x - mean) ** 2;
      totals.set(cat, sum);
      means.set(cat, mean);
      stds.set(cat, arr.length ? Math.sqrt(v / arr.length) : 0);
    }
    return { totals, means, stds, allCats: Array.from(series.keys()) };
  }, [data, partitionAxis, valueAxis, timeAxis]);

  const orderedCategories = useMemo(() => {
    const { totals, means, stds, allCats } = stats;
    if (!allCats.length) return [];
    if (stackOrder === 'display' && Array.isArray(canonicalOrder) && canonicalOrder.length) {
      const present = new Set(allCats);
      const known = canonicalOrder.filter((c) => present.has(c));
      const unknown = allCats.filter((c) => !known.includes(c)).sort();
      return [...known, ...unknown];
    }
    if (stackOrder === 'variance') {
      const cov = (c) => {
        const m = means.get(c) ?? 0;
        if (m <= 1e-9) return Infinity;
        return (stds.get(c) ?? 0) / m;
      };
      return [...allCats].sort((a, b) => cov(a) - cov(b));
    }
    return [...allCats].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  }, [stats, stackOrder, canonicalOrder]);

  function toggleCategory(cat) {
    setHiddenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Box sx={{ flex: 1, minHeight: 180, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Optional per-chart title row — shown only when the frame holds >1
          chart so stacked charts are identifiable. A Split button here
          extracts the chart back to its own frame. */}
      {showTitle && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25, flexShrink: 0 }}>
          <Typography
            variant="caption"
            fontWeight={600}
            noWrap
            sx={{ flex: 1, fontSize: 11, opacity: 0.85 }}
          >
            {spec.display_name || spec.name}
          </Typography>
          {onSplit && (
            <Tooltip title="Split into its own frame">
              <IconButton size="small" onClick={onSplit} sx={{ p: 0.25 }}>
                <CallSplitIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      )}

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
      {!error && data != null && ChartComponent && (
          <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <Suspense fallback={<Box sx={{ p: 2 }}><CircularProgress size={20} /></Box>}>
              <ChartComponent
                data={data}
                chartOptions={spec.chart_options || {}}
                chartSpec={spec}
                clockState={clockState}
                onScrub={isScrubber ? onScrub : undefined}
                onPointClick={handlePointClick}
                displayMode={displayMode}
                windowSize={windowSize}
                unit={effectiveUnit}
                stackOrder={stackOrder}
                orderedCategories={orderedCategories}
                hiddenCategories={hiddenCategories}
                // Pin extension charts to Plotly. The routers would otherwise
                // follow the WebGPU preference, and the large-display
                // deployment is not served from a secure context, so ChartGPU
                // can't initialise there — feature detection would fall back on
                // its own, but silently and only if the probe behaves. Pinning
                // makes the renderer a property of the deployment target rather
                // than of whatever the browser reports. ChartGPU is also the
                // deprecated path for these charts (see the router comments).
                webgpu={false}
                fillParent
              />
            </Suspense>
        </Box>
      )}

      {!error && data != null && !ChartComponent && (
        <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
          No renderer for chart_type "{spec.chart_type}"
        </Typography>
      )}

      {/* Legend. For partitioned charts (stacked area, multi-line), entries
          are interactive — click to hide/show that series. For single-line
          charts, one-entry legend from value_label + line_color.
          Skipped for Plotly chart types (line/bar/scatter/plotly) because
          Plotly draws its own interactive legend and we don't want two. */}
      {!error && data != null
        && !['line', 'bar', 'scatter', 'plotly'].includes(String(spec.chart_type || ''))
        && (() => {
        let items;
        if (hasPartitioning && orderedCategories.length > 0) {
          items = [...orderedCategories].reverse().map((cat) => ({
            name: cat,
            color: partitionColors[cat] || '#888888',
            toggleable: true,
          }));
        } else if (!hasPartitioning) {
          const opts = spec.chart_options || {};
          items = [{
            name: opts.value_label || opts.value_axis || 'Value',
            color: opts.line_color || theme.palette.primary.main,
            toggleable: false,
          }];
        } else {
          return null;
        }
        return (
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 0.5,
              pt: 0.5,
              mt: 0.5,
              borderTop: '1px solid',
              borderColor: 'divider',
              maxHeight: 60,
              overflowY: 'auto',
              flexShrink: 0,
            }}
          >
            {items.map(({ name, color, toggleable }) => {
              const hidden = toggleable && hiddenCategories.has(name);
              const tip = toggleable
                ? (hidden ? 'Show this series' : 'Hide this series')
                : '';
              const swatch = (
                <Box
                  onClick={toggleable ? () => toggleCategory(name) : undefined}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 0.75,
                    py: 0.25,
                    borderRadius: 1,
                    cursor: toggleable ? 'pointer' : 'default',
                    opacity: hidden ? 0.4 : 1,
                    border: '1px solid',
                    borderColor: hidden ? 'divider' : 'transparent',
                    ...(toggleable && { '&:hover': { bgcolor: 'action.hover' } }),
                  }}
                >
                  <Box
                    sx={{
                      width: 10,
                      height: 10,
                      borderRadius: 0.25,
                      bgcolor: color,
                      flexShrink: 0,
                      ...(hidden && { opacity: 0.4 }),
                    }}
                  />
                  <Typography
                    variant="caption"
                    sx={{
                      fontSize: 10,
                      lineHeight: 1.2,
                      textDecoration: hidden ? 'line-through' : 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {name}
                  </Typography>
                </Box>
              );
              return toggleable
                ? <Tooltip key={name} title={tip}>{swatch}</Tooltip>
                : <Box key={name}>{swatch}</Box>;
            })}
          </Box>
        );
      })()}
    </Box>
  );
}

export { ScenarioChartBody };
