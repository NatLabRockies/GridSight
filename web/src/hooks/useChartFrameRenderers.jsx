import React from 'react';
import AiChartPanel from '../components/charts/AiChartPanel.jsx';
import BuiltinTimeseriesPanel from '../components/charts/BuiltinTimeseriesPanel.jsx';
import ScenarioChartsPanel from '../components/charts/ScenarioChartsPanel.jsx';
import ChartFrame from '../components/charts/ChartFrame.jsx';
import { getPanelDef } from '../lib/panelRegistry.jsx';

// Diagonal cascade for newly-opened floating charts. The old 30px step left
// near-identical positions for ~768px-wide panels — they looked stacked and
// only the topmost header was grabbable. A larger step exposes each frame's
// header/controls; the modulo wrap keeps a long run from marching off-screen.
const CASCADE_STEP = 56;
const CASCADE_WRAP = 6;
function cascade(baseX, baseY, i) {
  const k = ((i % CASCADE_WRAP) + CASCADE_WRAP) % CASCADE_WRAP;
  return { x: baseX + k * CASCADE_STEP, y: baseY + k * CASCADE_STEP };
}

// Render-function factory extracted from App.jsx. These renderers close over
// a large bag of App-level state/handlers — pass them all in via `deps`.
// Not a "real" hook (no useState/useEffect), but uses the `use` prefix to
// keep the call-site convention consistent.
export function useChartFrameRenderers(deps) {
  const {
    chartDAG,
    aiAnchorFor,
    setAiAnchor,
    handleChartAnchorToggle,
    map,
    gpuCapabilities,
    layout,
    scenarioState,
    clockState,
    updateClockState,
    currentTime,
    handleApplyPerspective,
    captureLiveStateRef,
    handleGenericLayerStyleMappingChange,
    extensions,
    handleExtensionToggle,
    updateScenarioState,
    openScenarioChart,
    closeScenarioChart,
    setScenarioChartAnchor,
    setScenarioChartGeom,
    transferScenarioChart,
    openScenarioCharts,
    combineScenarioCharts,
    splitScenarioChart,
    candidateTitleFor,
    inputControlRefreshKey = 0,
  } = deps;

  function buildGroupedAiCharts() {
    const all = chartDAG.getChartsByPlacement('floating')
      .concat(chartDAG.getChartsByPlacement('tray'));
    const grouped = { floating: [], 'side-left': [], 'side-right': [], bottom: [], tray: [] };
    for (const chart of all) {
      const mode = aiAnchorFor(chart);
      (grouped[mode] ?? grouped.floating).push(chart);
    }
    return grouped;
  }

  const renderAiPanel = (chart, i) => (
    <AiChartPanel
      key={chart.id}
      frameKey={`ai::${chart.id}`}
      chart={chart}
      anchorMode={aiAnchorFor(chart)}
      onAnchorModeChange={(mode) => setAiAnchor(chart.id, mode)}
      onClose={() => {
        if (map.state.anchoredCharts.has(chart.id)) return; // locked
        // Send it home to the chat rather than destroying it. Charts are
        // created at placement:'chat' and setPlacement only ever moves them
        // to 'tray' or 'floating', so unregistering here was a one-way door:
        // closing a popped-out chart discarded its spec, SQL and DAG entry,
        // and the transcript that produced it was left referring to something
        // that no longer existed. The chat is a transcript — the chart
        // belongs in it.
        chartDAG.setPlacement(chart.id, 'chat');
      }}
      anchored={map.state.anchoredCharts.has(chart.id)}
      onAnchorToggle={handleChartAnchorToggle}
      webgpu={gpuCapabilities.webgpu}
      initialPos={cascade(240, 100, i)}
    />
  );

  const renderScenarioPanel = (entry, i) => {
    if (entry.kind === 'panel') {
      const def = getPanelDef(entry.panelId);
      if (!def) return null;
      const PanelComponent = def.Component;
      const panelProps = {
        // story-playback
        storyId: layout.state.activeStory,
        activePerspectiveId: layout.state.activePerspective,
        onApplyChapter: handleApplyPerspective,
        onCapture: () => captureLiveStateRef.current?.(),
        // animation
        clockState,
        onClockChange: updateClockState,
        currentTimeLabel: currentTime,
        // layers
        layers: map.state.configs,
        scenarioState,
        visibility: map.state.visibility,
        localStyle: map.state.localStyle,
        onToggleVisibility: (id, next) => map.setLayerVisibility(id, next),
        onLocalStyleChange: (id, next) => map.setLayerStyle(id, next),
        onStyleMappingsChange: handleGenericLayerStyleMappingChange,
        // extensions
        extensions,
        onToggleExtension: handleExtensionToggle,
        onScenarioChange: updateScenarioState,
        onOpenChart: openScenarioChart,
      };
      return (
        <ChartFrame
          key={entry.key}
          frameKey={entry.key}
          title={def.title}
          anchorMode={entry.anchorMode}
          onAnchorModeChange={(mode) => setScenarioChartAnchor(entry.key, mode)}
          onClose={() => closeScenarioChart(entry.key)}
          onTransfer={(targetTabId, mode) => transferScenarioChart(entry.key, targetTabId, mode)}
          initialFloatPosition={cascade(320, 140, i)}
          initialFloatSize={def.defaultSize}
          geom={entry.geom}
          onGeomChange={(g) => setScenarioChartGeom(entry.key, g)}
        >
          <PanelComponent {...panelProps} />
        </ChartFrame>
      );
    }
    if (entry.kind === 'builtin-ts') {
      const b = entry.builtin;
      return (
        <BuiltinTimeseriesPanel
          key={entry.key}
          frameKey={entry.key}
          layerId={b.layerId}
          entityId={b.entityId}
          dsId={b.dsId}
          label={b.label}
          clockState={clockState}
          updateClockState={updateClockState}
          onClose={() => closeScenarioChart(entry.key)}
          anchorMode={entry.anchorMode}
          onAnchorModeChange={(mode) => setScenarioChartAnchor(entry.key, mode)}
          combineCandidates={undefined}
          onCombine={undefined}
          onTransfer={undefined}
          initialPos={cascade(320, 140, i)}
          geom={entry.geom}
          onGeomChange={(g) => setScenarioChartGeom(entry.key, g)}
        />
      );
    }
    return (
      <ScenarioChartsPanel
        key={entry.key}
        frameKey={entry.key}
        charts={entry.charts}
        project={scenarioState.project}
        scenario={scenarioState.scenario}
        clockState={clockState}
        updateClockState={updateClockState}
        onClose={() => closeScenarioChart(entry.key)}
        anchorMode={entry.anchorMode}
        onAnchorModeChange={(mode) => setScenarioChartAnchor(entry.key, mode)}
        combineCandidates={openScenarioCharts
          .filter((e) => e.key !== entry.key && e.kind !== 'builtin-ts' && e.kind !== 'panel')
          .map((e) => ({ key: e.key, title: candidateTitleFor(e) }))}
        onCombine={(sourceKey) => combineScenarioCharts(entry.key, sourceKey)}
        onSplit={(chartIndex) => splitScenarioChart(entry.key, chartIndex)}
        onTransfer={(targetTabId, mode) => transferScenarioChart(entry.key, targetTabId, mode)}
        initialPos={cascade(320, 140, i)}
        geom={entry.geom}
        onGeomChange={(g) => setScenarioChartGeom(entry.key, g)}
        refreshKey={inputControlRefreshKey}
      />
    );
  };

  return { buildGroupedAiCharts, renderAiPanel, renderScenarioPanel };
}
