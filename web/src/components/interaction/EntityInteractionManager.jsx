import React, { useState, useEffect, useMemo, useCallback, Suspense, Component } from 'react';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

/** Error boundary to prevent chart errors from crashing the map. */
class ChartErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(err) { console.warn('[ChartErrorBoundary]', err); }
  render() {
    if (this.state.error) {
      return (
        <Box sx={{ p: 1, color: '#f44336', fontSize: 12 }}>
          Chart error: {this.state.error.message}
        </Box>
      );
    }
    return this.props.children;
  }
}

const EMPTY_CONTENT = [];

/** Section header with chevron toggle and optional pop-out icon. */
function SectionHeader({ label, collapsed, onToggle, onPopOut }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.25 }}>
      <Tooltip title={collapsed ? 'Expand' : 'Collapse'}>
        <IconButton
          size="small"
          onClick={onToggle}
          sx={{ p: 0.25 }}
        >
          <ExpandMoreIcon
            sx={{
              fontSize: 14,
              transform: collapsed ? 'rotate(-90deg)' : 'none',
              transition: 'transform 0.15s',
            }}
          />
        </IconButton>
      </Tooltip>
      <Typography variant="caption" sx={{ color: '#aaa', fontWeight: 600, flex: 1 }}>
        {label}
      </Typography>
      {onPopOut && (
        <Tooltip title="Pop out as draggable chart">
          <IconButton size="small" onClick={onPopOut} sx={{ p: 0.25 }}>
            <OpenInNewIcon sx={{ fontSize: 12 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

import EntityPopup from './EntityPopup.jsx';
import EntityFloatingPanel from './EntityFloatingPanel.jsx';
import EntityDrawerPanel from './EntityDrawerPanel.jsx';
import InfoCard from './InfoCard.jsx';
import LineScrubber from '../../lib/charts/LineScrubber.jsx';
import HeatmapChart from './HeatmapChart.jsx';
import HistogramChart from './HistogramChart.jsx';
import DataControlPanel from './DataControlPanel.jsx';
import ResizableChartContainer from './ResizableChartContainer.jsx';

import {
  fetchEntityTimeseries,
  extractEntityFromBuffer,
} from '../../lib/entityTimeseries.js';
import {
  getEntityWindow,
  prefetchEntityWindow,
} from '../../lib/entitySeriesCache.js';
import { pickPlayheadMs } from '../../lib/clock.js';

import {
  fetchExtensionControls,
  setExtensionControl,
  fetchExtensionCharts,
} from '../../lib/loaders.js';
import { isAbortError } from '../../lib/requestControl.js';

import ScenarioChartBody from '../charts/ScenarioChartBody.jsx';
import { resolveEntityName } from '../../lib/entityName.js';
import { useEntityInspectorState } from '../../state/entityInspectorState.js';

const DEFAULT_INTERACTION = {
  hoverContent: ['infocard'],
  clickContent: ['infocard', 'timeseries'],
  panelPlacement: 'floating',
  heatmapBinMode: 'hour',
  histogramMode: 'full',
  timeseriesDelta: 168,
  // Entity-timeseries window in hours. Loaded once when the entity is
  // clicked and re-loaded ("ratcheted") only when the cursor approaches
  // an edge — so scrubbing inside the loaded range is purely visual
  // (cursor line moves; chart bounds don't shift). Wider than the
  // visible chart so the user has context to either side of "now".
  timeseriesWindowHours: 168,  // 7 days
};

// Ratchet trigger: when the cursor moves within this fraction of the
// loaded window edge, reload re-centered on the cursor. 0.15 means a
// 7-day window won't reload until the cursor is within ~25 h of an
// edge. Smaller value = chart sits still longer + more "snap" when it
// finally moves; larger value = more frequent reloads + smoother
// follow during continuous playback.
const EDGE_RATCHET_FRACTION = 0.15;

// Debounce on the ratchet check so scrubbing past several boundaries
// quickly only fires one re-fetch instead of one per step.
const RATCHET_DEBOUNCE_MS = 200;

/**
 * EntityInteractionManager — top-level orchestrator for entity hover/click popups.
 *
 * interactionState.content is an array of items to display, e.g. ['infocard', 'timeseries', 'heatmap'].
 * All selected items are stacked vertically.
 */
export default function EntityInteractionManager({
  interactionState,
  onDismiss,
  genericLayerConfigs,
  genericLayerLocalStyle,
  genericLayerData,
  timeseriesBuffersRef,
  layerToDatasetsRef,
  clockState,
  updateClockState,             // for scrubbing on scrubber-style extension charts
  scenarioState,
  onPopOutChart,                // (extName, spec, entityId) => void
  onPopOutBuiltinTimeseries,    // ({layerId, entityId, dsId, label}) => void
  webgpu = false,
  // Bumped by App.jsx whenever any input control change invalidates a
  // dataset. We add it to the chart-specs fetch deps so extensions that
  // bake control state into their ChartSpec name get re-queried for fresh
  // specs (and the new spec name then re-fires ScenarioChartBody's fetch).
  inputControlRefreshKey = 0,
  // Forwarded from App.jsx (handleDatasetsInvalidated). Fires when a
  // chart inside the popup commits a click→control update so the map
  // and downstream charts re-render to match.
  onInputControlInvalidated,
}) {
  // Consolidated async fetch state for the inspector panel
  // (full + windowed timeseries, extension controls, extension chart
  // specs, section collapse map). ``infocard`` starts collapsed via
  // INITIAL in the hook because for entities with many metadata fields
  // it pushes the timeseries chart off-screen.
  const entity = useEntityInspectorState();
  const {
    fullTimeseries,
    loadingFull,
    windowedTimeseries,
    loadingWindow,
    loadedRange,
    controls,
    controlsLoading,
    controlsError,
    chartSpecs,
    chartsLoading,
    collapsedSections,
  } = entity.state;
  const toggleSection = useCallback((name) => {
    entity.toggleSection(name);
  }, [entity]);

  const layerId = interactionState?.layerId;
  const entityId = interactionState?.entityId;
  // Human-readable name for the clicked entity — feature NAME property first,
  // then a FIPS→state-name fallback, finally the raw id. We always show the
  // name over the bare code.
  const entityName = useMemo(
    () => resolveEntityName(interactionState?.feature, entityId),
    [interactionState?.feature, entityId],
  );
  const trigger = interactionState?.trigger;
  const content = interactionState?.content ?? EMPTY_CONTENT;

  const interaction = useMemo(() => ({
    ...DEFAULT_INTERACTION,
    ...(genericLayerLocalStyle[layerId]?.interaction ?? {}),
  }), [genericLayerLocalStyle, layerId]);

  const dsId = layerId != null ? layerToDatasetsRef.current?.get(layerId)?.get('primary') ?? null : null;
  const buffer = dsId != null ? timeseriesBuffersRef.current?.get(dsId) : null;
  const currentValue = buffer && entityId ? buffer.currentValues.get(entityId) ?? null : null;
  const layerConfig = genericLayerConfigs.find((lc) => lc.id === layerId) ?? null;

  // Look up the entity's dataset row for static datasets (used by InfoCard tooltip)
  const dataIndex = layerId != null ? genericLayerData?.[layerId] : null;
  const dataRow = dataIndex instanceof Map && entityId ? dataIndex.get(entityId) ?? null : null;

  // Derive extension context from the layer config
  const extensionName = layerConfig?.extension_name || null;
  const project = scenarioState?.project || '';
  const scenario = scenarioState?.scenario || '';

  // Extract windowed timeseries from buffer (no network)
  const bufferTimeseries = useMemo(() => {
    if (!buffer || !entityId || !clockState.timestamps?.length) return null;
    return extractEntityFromBuffer(buffer, entityId, clockState.timestamps);
  }, [buffer, entityId, clockState.timestamps]);

  // Fetch full timeseries from server when heatmap or histogram is
  // shown — those aggregate across the full year so they need every
  // point. The timeseries line chart has its own rolling-window fetch
  // below; it does NOT trigger a full fetch.
  useEffect(() => {
    entity.clearFull();
    if (!dsId || !entityId) return;
    const needsFull = content.includes('heatmap') || content.includes('histogram');
    if (!needsFull) return;
    // Abort the in-flight fetch when the entity/section changes so rapidly
    // clicking many entities cancels superseded loads instead of queueing a
    // request per click that all run to completion server-side.
    const ctrl = new AbortController();
    entity.fullStart();
    fetchEntityTimeseries(dsId, entityId, { signal: ctrl.signal })
      .then((ts) => { if (!ctrl.signal.aborted) entity.fullSuccess(ts); })
      .catch((e) => {
        if (ctrl.signal.aborted || isAbortError(e)) return;
        console.warn('[EntityInteractionManager] fetchEntityTimeseries error:', e);
        entity.fullError();
      });
    return () => ctrl.abort();
  }, [dsId, entityId, content]);

  // Cursor position in epoch ms, derived via the same helper the
  // LineScrubber uses to draw the playhead. Naively doing
  // ``Date.parse(clockState.timestamps[idx])`` is wrong for the
  // common case where the partition-day clock has the date string
  // repeated once per hour — Date.parse drops the hour and pins
  // every intra-day index to midnight UTC. ``pickPlayheadMs``
  // recovers the hour offset by counting back to the first
  // occurrence of the dateStr, and parses as LOCAL time.
  const cursorMs = useMemo(
    () => pickPlayheadMs(clockState, []),
    [clockState?.index, clockState?.timestamps],
  );

  // ``loadedRange`` is the currently-rendered window (from entity.state).
  // The chart bounds stay pinned to this range; cursor scrubbing moves
  // only the cursor line, not the axis. The range is replaced
  // ("ratcheted") only when the cursor approaches an edge — keeping the
  // chart stable during most playback / scrubbing.

  // Reset when the entity or section changes so a fresh click always
  // re-centers on "now" rather than reusing the previous entity's
  // remembered range.
  useEffect(() => {
    entity.setLoadedRange(null);
    entity.clearWindow();
  }, [dsId, entityId, content]);

  // Initial load + edge ratchet. Triggers a new ``loadedRange`` (and
  // therefore a new fetch) when:
  //   - no range is loaded yet, OR
  //   - the cursor has moved within EDGE_RATCHET_FRACTION of either
  //     edge of the loaded range.
  // Otherwise this effect is a no-op — scrubbing inside the range
  // doesn't touch the network or change the chart axis.
  useEffect(() => {
    if (!content.includes('timeseries') || !dsId || !entityId || cursorMs == null) {
      return undefined;
    }
    const windowHours = interaction.timeseriesWindowHours ?? 168;
    const halfMs = (windowHours / 2) * 3600 * 1000;

    const recenter = () => {
      entity.setLoadedRange({ fromMs: cursorMs - halfMs, toMs: cursorMs + halfMs });
    };

    if (!loadedRange) {
      recenter();
      return undefined;
    }
    const padMs = (loadedRange.toMs - loadedRange.fromMs) * EDGE_RATCHET_FRACTION;
    const nearLeading = cursorMs > loadedRange.toMs - padMs;
    const nearTrailing = cursorMs < loadedRange.fromMs + padMs;
    if (!nearLeading && !nearTrailing) return undefined;

    // Debounce — fast scrubs across multiple boundaries collapse to one
    // recenter rather than spamming fetches.
    const timer = setTimeout(recenter, RATCHET_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [content, dsId, entityId, cursorMs, loadedRange, interaction.timeseriesWindowHours]);

  // Fetch the data for the current loaded range. Goes through the
  // chunked cache so adjacent ratchets reuse most chunks.
  useEffect(() => {
    if (!loadedRange || !dsId || !entityId) {
      entity.clearWindow();
      return undefined;
    }
    let cancelled = false;
    entity.windowStart();
    getEntityWindow(dsId, entityId, loadedRange.fromMs, loadedRange.toMs)
      .then((series) => { if (!cancelled) entity.windowSuccess(series); })
      .catch((e) => {
        if (cancelled) return;
        console.warn('[EntityInteractionManager] getEntityWindow error:', e);
        entity.windowError();
      });
    // Warm the chunk just past the leading edge so the next ratchet's
    // re-fetch (when it eventually fires) hits a cache.
    prefetchEntityWindow(dsId, entityId, loadedRange.toMs);
    return () => { cancelled = true; };
  }, [loadedRange, dsId, entityId]);

  // Fetch extension controls when "controls" is in content and extension_name is available
  useEffect(() => {
    if (!content.includes('controls') || !extensionName || !entityId) {
      entity.clearControls();
      return;
    }
    // Abort on entity/section change: prevents both queue buildup from rapid
    // clicks and a stale response landing after a newer one (this effect had
    // no cleanup before, so out-of-order writes were possible).
    const ctrl = new AbortController();
    entity.controlsStart();
    fetchExtensionControls(extensionName, project, scenario, entityId, { signal: ctrl.signal })
      .then((arr) => { if (!ctrl.signal.aborted) entity.controlsSuccess(arr); })
      .catch((e) => {
        if (ctrl.signal.aborted || isAbortError(e)) return;
        console.warn('[EntityInteractionManager] fetchExtensionControls error:', e);
        entity.controlsError(e.message);
      });
    return () => ctrl.abort();
  }, [content, extensionName, project, scenario, entityId]);

  // Fetch extension chart specs when "charts" is in content. The actual
  // per-chart data fetching now happens inside ScenarioChartBody (with
  // caching keyed by entityId), so we don't pre-fetch here.
  useEffect(() => {
    if (!content.includes('charts') || !extensionName) {
      entity.clearChartSpecs();
      return;
    }
    entity.chartSpecsStart();
    fetchExtensionCharts(extensionName)
      .then((arr) => entity.chartSpecsSuccess(arr))
      .catch((e) => {
        console.warn('[EntityInteractionManager] fetchExtensionCharts error:', e);
        entity.chartSpecsError();
      });
  }, [content, extensionName, inputControlRefreshKey]);

  const handleControlChange = useCallback(async (controlName, value) => {
    if (!extensionName) return;
    try {
      const result = await setExtensionControl(extensionName, project, scenario, entityId, controlName, value);
      if (result.success !== false) {
        // Update local control state
        entity.controlsPatch(controlName, { current_value: result.new_value ?? value });
      }
    } catch (e) {
      console.warn('[EntityInteractionManager] setExtensionControl error:', e);
    }
  }, [extensionName, project, scenario, entityId]);

  const onDismissCallback = useCallback(() => onDismiss?.(), [onDismiss]);

  if (!interactionState || !content.length) return null;

  const persistent = trigger === 'click';

  // Build content — all selected items stacked vertically
  const sections = [];

  // Section order: timeseries first (most actionable on click), then
  // heatmap/histogram/controls/charts, then infocard last. Infocard is
  // collapsed by default — useful but rarely needed at-a-glance once
  // the user has clicked through to inspect an entity.

  if (content.includes('timeseries')) {
    const dsName = layerConfig?.layer_datasets
      ?.find(ld => ld.dataset?.id === dsId)
      ?.dataset?.name;
    const chartTitle = dsName || 'Timeseries';
    const collapsed = !!collapsedSections.timeseries;

    // Rolling 72 h window centered on the animation cursor, fetched
    // via the chunked entity-series cache. Falls back to fullTimeseries
    // (if heatmap/histogram already pulled it) so the chart isn't blank
    // during the first network round-trip.
    const sourceTs = (windowedTimeseries?.timestamps?.length > 0
      ? windowedTimeseries
      : (fullTimeseries?.timestamps?.length > 0 ? fullTimeseries : null));
    const tsRows = sourceTs
      ? sourceTs.timestamps.map((t, i) => ({
          timestamp: t instanceof Date ? t.toISOString() : new Date(t).toISOString(),
          value: sourceTs.values[i] ?? 0,
        }))
      : [];
    const tsChartOptions = {
      time_axis: 'timestamp',
      value_axis: 'value',
      value_label: chartTitle,
      value_unit: 'MW',
      line_color: '#FF7043',
    };

    sections.push(
      <ChartErrorBoundary key={`timeseries-boundary-${entityId}`}>
        <Box key={`timeseries-${entityId}`} sx={{ mt: 1, display: 'flex', flexDirection: 'column' }}>
          <SectionHeader
            label={chartTitle}
            collapsed={collapsed}
            onToggle={() => toggleSection('timeseries')}
            onPopOut={onPopOutBuiltinTimeseries && layerId != null && entityId && dsId
              ? () => { onPopOutBuiltinTimeseries({ layerId, entityId, dsId, label: chartTitle }); onDismissCallback(); }
              : undefined}
          />
          <Collapse in={!collapsed} unmountOnExit>
            <Box sx={{ position: 'relative', height: 180 }}>
              {tsRows.length > 0 ? (
                <LineScrubber
                  key={entityId}
                  data={tsRows}
                  chartOptions={tsChartOptions}
                  clockState={clockState}
                  // The chart's data is a 7-day window, not the full
                  // clock timeline, so derive the playhead directly
                  // from cursorMs (already in epoch ms). LineScrubber's
                  // default pickPlayheadMs fails on length-mismatched
                  // local series.
                  playheadMsOverride={cursorMs}
                  onScrub={updateClockState
                    ? (idx) => updateClockState((prev) => ({ ...prev, index: idx, animate: false }))
                    : undefined}
                  fillParent
                />
              ) : (
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  {(loadingFull || loadingWindow)
                    ? <CircularProgress size={20} />
                    : <Typography variant="caption" sx={{ color: '#888' }}>No timeseries data available</Typography>}
                </Box>
              )}
            </Box>
          </Collapse>
        </Box>
      </ChartErrorBoundary>
    );
  }

  if (content.includes('heatmap')) {
    const collapsed = !!collapsedSections.heatmap;
    sections.push(
      <ChartErrorBoundary key="heatmap-boundary">
        <Box key="heatmap" sx={{ mt: 1 }}>
          <SectionHeader
            label="Heatmap"
            collapsed={collapsed}
            onToggle={() => toggleSection('heatmap')}
          />
          <Collapse in={!collapsed} unmountOnExit>
            {loadingFull ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress size={20} />
              </Box>
            ) : fullTimeseries ? (
              <ResizableChartContainer initialWidth={420} initialHeight={200} minHeight={120}>
                {({ width, height }) => (
                  <HeatmapChart timeseries={fullTimeseries} binMode={interaction.heatmapBinMode} width={width} height={height} />
                )}
              </ResizableChartContainer>
            ) : (
              <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
                No timeseries data available
              </Typography>
            )}
          </Collapse>
        </Box>
      </ChartErrorBoundary>
    );
  }

  if (content.includes('histogram')) {
    const ts = interaction.histogramMode === 'full' ? fullTimeseries : bufferTimeseries;
    const collapsed = !!collapsedSections.histogram;
    sections.push(
      <ChartErrorBoundary key="histogram-boundary">
        <Box key="histogram" sx={{ mt: 1 }}>
          <SectionHeader
            label="Histogram"
            collapsed={collapsed}
            onToggle={() => toggleSection('histogram')}
          />
          <Collapse in={!collapsed} unmountOnExit>
            {loadingFull && interaction.histogramMode === 'full' ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress size={20} />
              </Box>
            ) : ts ? (
              <ResizableChartContainer initialWidth={420} initialHeight={180} minHeight={100}>
                {({ width, height }) => (
                  <HistogramChart
                    timeseries={ts}
                    clockState={clockState}
                    mode={interaction.histogramMode}
                    width={width}
                    height={height}
                  />
                )}
              </ResizableChartContainer>
            ) : (
              <Typography variant="caption" sx={{ color: '#888', p: 1 }}>
                No timeseries data available
              </Typography>
            )}
          </Collapse>
        </Box>
      </ChartErrorBoundary>
    );
  }

  if (content.includes('controls')) {
    const collapsed = !!collapsedSections.controls;
    sections.push(
      <ChartErrorBoundary key="controls-boundary">
        <Box key="controls" sx={{ mt: 1 }}>
          <SectionHeader
            label="Controls"
            collapsed={collapsed}
            onToggle={() => toggleSection('controls')}
          />
          <Collapse in={!collapsed} unmountOnExit>
            <DataControlPanel
              controls={controls}
              loading={controlsLoading}
              onControlChange={handleControlChange}
              error={controlsError}
            />
          </Collapse>
        </Box>
      </ChartErrorBoundary>
    );
  }

  if (content.includes('charts')) {
    // Only show a full-section spinner on the initial spec fetch (nothing
    // to render yet). On every later refresh (inputControlRefreshKey bump)
    // the previous chart stays mounted while the new specs land — ChartSpec
    // identity churn flows through React reconciliation and the chart
    // renderer diffs it in place. This is what removes the flash that the
    // earlier "always blank during chartsLoading" branch produced.
    const isInitialLoad = chartsLoading && chartSpecs.length === 0;
    if (isInitialLoad) {
      sections.push(
        <Box key="charts-loading" sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={20} />
        </Box>
      );
    } else {
      // Entity click popup shows ONLY entity-scope specs. scope="scenario"
      // charts (system-wide views) live in the per-extension charts menu
      // and would otherwise pile into every entity tooltip.
      //
      // Per-spec gating: an extension can pin a chart to a specific entity-id
      // length (e.g. 2 for STATEFP, 5 for county GEOID) via
      // chart_options.entity_id_length. Specs without it always render.
      const entityIdLen = (entityId ?? '').length;
      const visibleSpecs = chartSpecs.filter((s) => {
        if (s?.scope && s.scope !== 'entity') return false;
        const want = s?.chart_options?.entity_id_length;
        return want == null || Number(want) === entityIdLen;
      });
      for (const spec of visibleSpecs) {
        const sectionName = `chart-${spec.name}`;
        const collapsed = !!collapsedSections[sectionName];
        // Honor the extension's requested height (spec.height). Many
        // small entity charts default to 220px; tall stacked-bar charts
        // (e.g. 21 counties × 24px row + axes) need ~620px. Clamp to a
        // reasonable max so a buggy spec can't produce a 5000px popup.
        const chartHeight = Math.max(180, Math.min(800, Number(spec.height) || 220));
        sections.push(
          <ChartErrorBoundary key={sectionName}>
            <Box sx={{ mt: 1, minHeight: collapsed ? 0 : chartHeight, display: 'flex', flexDirection: 'column' }}>
              <SectionHeader
                label={spec.display_name || spec.name}
                collapsed={collapsed}
                onToggle={() => toggleSection(sectionName)}
                onPopOut={onPopOutChart && extensionName && entityId
                  ? () => { onPopOutChart(extensionName, spec, entityId, entityName); onDismissCallback(); }
                  : undefined}
              />
              <Collapse in={!collapsed} unmountOnExit sx={{ flex: 1, minHeight: 0 }}>
                <Box sx={{ height: chartHeight, display: 'flex', flexDirection: 'column' }}>
                  <ScenarioChartBody
                    extensionName={extensionName}
                    chartSpec={spec}
                    project={project}
                    scenario={scenario}
                    entityId={entityId}
                    clockState={clockState}
                    onScrub={updateClockState
                      ? (idx) => updateClockState((prev) => ({ ...prev, index: idx, animate: false }))
                      : undefined}
                    onInputControlInvalidated={onInputControlInvalidated}
                    refreshKey={inputControlRefreshKey}
                  />
                </Box>
              </Collapse>
            </Box>
          </ChartErrorBoundary>
        );
      }
    }
  }

  // Infocard goes LAST in the visual order so the timeseries chart
  // sits at the top of the panel. Starts collapsed by default (see
  // ``collapsedSections`` initializer).
  if (content.includes('infocard')) {
    const collapsed = !!collapsedSections.infocard;
    sections.push(
      <Box key="infocard">
        <SectionHeader
          label="Info"
          collapsed={collapsed}
          onToggle={() => toggleSection('infocard')}
        />
        <Collapse in={!collapsed} unmountOnExit>
          <InfoCard
            feature={interactionState.feature}
            entityId={entityId}
            currentValue={currentValue}
            layerConfig={layerConfig}
            dataRow={dataRow}
          />
        </Collapse>
      </Box>
    );
  }

  // Popup width — honor the widest visible entity-chart spec so on-click
  // charts open at their declared size (extensions ask for 520–720px)
  // instead of collapsing to the 300px content minimum. Chart-less popups
  // (plain infocard) keep the compact default. Clamped so a buggy spec
  // can't produce a viewport-wide popup; EntityFloatingPanel's 90vw
  // maxWidth still rules on small screens.
  const popupWidth = (() => {
    if (!content.includes('charts')) return undefined;
    const entityIdLen = (entityId ?? '').length;
    const widths = chartSpecs
      .filter((s) => (!s?.scope || s.scope === 'entity'))
      .filter((s) => {
        const want = s?.chart_options?.entity_id_length;
        return want == null || Number(want) === entityIdLen;
      })
      .map((s) => Number(s.width) || 0)
      .filter((w) => w > 0);
    if (!widths.length) return 460; // charts w/o declared width: still wider than min
    return Math.min(760, Math.max(380, ...widths));
  })();

  const body = (
    <Box sx={{
      minWidth: 300,
      ...(popupWidth ? { width: popupWidth } : {}),
      display: 'flex',
      flexDirection: 'column',
      gap: 0.5,
    }}>
      {/* Entity name lives outside the Info section so it remains
          visible when the user collapses Info — most of the time
          they're inspecting one entity at a time and want the name
          as a persistent header. */}
      {entityId && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">Entity</Typography>
          <Chip
            label={entityName || entityId}
            size="small"
            variant="outlined"
            // Keep the raw id discoverable on hover when we resolved a name.
            title={entityName && String(entityName) !== String(entityId) ? `id: ${entityId}` : undefined}
          />
        </Box>
      )}
      {sections.map((section, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Divider sx={{ opacity: 0.2 }} />}
          {section}
        </React.Fragment>
      ))}
    </Box>
  );

  // Select panel type
  const placement = interaction.panelPlacement ?? 'floating';

  if (placement === 'drawer') {
    return (
      <EntityDrawerPanel onDismiss={onDismissCallback} open={true}>
        {body}
      </EntityDrawerPanel>
    );
  }

  // Default: floating panel
  return (
    <EntityFloatingPanel onDismiss={onDismissCallback} persistent={persistent}>
      {body}
    </EntityFloatingPanel>
  );
}
