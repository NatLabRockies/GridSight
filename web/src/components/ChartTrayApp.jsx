/**
 * ChartTrayApp — lightweight root for a dedicated "chart tray" browser tab.
 *
 * Rendered in place of <App/> when the URL carries ?view=chartTray. This
 * tab is a pure receiver for chart transfers from a paired Meridian tab:
 * no deck.gl, no layer state, no extension discovery. Just a session join,
 * clock/scenario sync, and a full-screen ChartTray that hosts whatever
 * scenario charts get sent its way.
 *
 * Intended use case: dual-display setup — horizontal display runs <App/>
 * (map + tooltips), vertical display runs <ChartTrayApp/> with a stack of
 * charts pinned by the user.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import SettingsIcon from '@mui/icons-material/Settings';
import bus, { applyRoleDefaults } from '../lib/stateBus.js';
import useStateBusSync from '../hooks/useStateBusSync.js';
import useClockEngine from '../hooks/useClockEngine.js';
import useChartFrames from '../hooks/useChartFrames.js';
import useChartDAG from '../lib/useChartDAG.js';
import { useCategoryColors } from '../lib/categoryColors.jsx';
import {
  makeFrameKey,
  scenarioChartId,
  frameIdentity,
} from '../lib/chartFrameId.js';
import SyncSettingsPanel from './controllers/SyncSettingsPanel.jsx';
import ChartFrame from './charts/ChartFrame.jsx';
import { PANEL_REGISTRY, getPanelDef } from '../lib/panelRegistry.jsx';
import { fetchGuestMe, fetchGuestWsTicket } from '../lib/loaders.js';

// Permission tiers map to which registered panel keys are mounted in
// control mode. Operators (no guest cookie) get every panel; guests are
// filtered by tier. The 'full' tier is intentionally identical to the
// operator set — by design — but the cookie still blocks invite admin
// at the Bun edge.
const TIER_PANEL_KEYS = {
  story: ['story-playback'],
  'story+chat': ['story-playback', 'ai-chat'],
  full: null, // null = mount all
};

const ChartTray = lazy(() => import('./interaction/ChartTray.jsx'));
const ScenarioChartsPanel = lazy(() => import('./charts/ScenarioChartsPanel.jsx'));
const BuiltinTimeseriesPanel = lazy(() => import('./charts/BuiltinTimeseriesPanel.jsx'));
const AiChartPanel = lazy(() => import('./charts/AiChartPanel.jsx'));

export default function ChartTrayApp({ mode = 'chartTray' }) {
  // In 'control' mode we pre-populate the tray with the registered
  // control panels so a tablet / dedicated operator tab opens ready to
  // drive the main display. No charts are carried over — this view is
  // explicitly for running the show, not watching it.
  const isControl = mode === 'control';

  // Permission filter — derived from /auth/guest/me when this tab is a
  // guest tab. Null = "operator, no filter" (all panels). Set to an
  // array of allowed panel keys for guests.
  const [allowedPanelKeys, setAllowedPanelKeys] = useState(null);
  const [guestReady, setGuestReady] = useState(!isControl); // operators don't wait

  // Join session from URL on mount. buildPopoutParams() in stateBus.js
  // already encoded join_session + per-channel sync flags. For a
  // freshly-redeemed guest, the URL has no `join_session` param — we
  // fetch /auth/guest/me to learn the sessionKey and join via WS ticket.
  useEffect(() => {
    bus.loadFromURL();
    if (!isControl) return;
    let cancelled = false;
    fetchGuestMe().then((info) => {
      if (cancelled) return;
      // Operator command tabs (popped out from main App) won't have a
      // gs_guest cookie — fetchGuestMe returns 401 there; we keep
      // allowedPanelKeys=null and rely on bus.loadFromURL's session join.
      const tier = info?.permissions;
      const keys = TIER_PANEL_KEYS[tier];
      setAllowedPanelKeys(keys || null);
      // Guest tabs join the operator's session via WS ticket; refresh on
      // every reconnect because tickets are single-use.
      bus.joinRemoteSession(info.sessionKey, {
        ticket: info.wsTicket,
        ticketRefresh: async () => {
          const r = await fetchGuestWsTicket();
          return r.ticket;
        },
      });
      // From now on this tab is the CONTROL panel: push state changes
      // to the display, ignore any echoes coming back. Receive stays on
      // for the catalog/metadata channels so the panels know what
      // layers/extensions exist.
      applyRoleDefaults(bus, 'control');
      setGuestReady(true);
    }).catch(() => {
      // Not a guest — operator command tab, proceed as normal.
      if (!cancelled) setGuestReady(true);
    });
    return () => { cancelled = true; };
  }, [isControl]);

  // ── Sync state ──────────────────────────────────────────────────────────
  const [scenarioState, setScenarioState] = useState({ project: '', scenario: '' });
  useStateBusSync('scenario', scenarioState, setScenarioState, { requestOnMount: true });

  // useClockEngine handles the 'clock' channel sync + rAF tick. We pass
  // requestOnMount because this tab joins late and needs to learn the
  // current anchor from the host.
  const [clockState, updateClockState] = useClockEngine({ requestOnMount: true });

  // Layer visibility + style + catalog mirrored from the host. The
  // catalog is publish-only from the host's side; this tab is a read-
  // only subscriber so the operator's toggles never clobber the host's
  // authoritative layer list.
  const [genericLayerVisibility, setGenericLayerVisibility] = useState({});
  const [genericLayerLocalStyle, setGenericLayerLocalStyle] = useState({});
  const [layerCatalog, setLayerCatalog] = useState([]);
  useStateBusSync('layers:visibility', genericLayerVisibility, setGenericLayerVisibility, { requestOnMount: true });
  useStateBusSync('layers:style', genericLayerLocalStyle, setGenericLayerLocalStyle, { requestOnMount: true });
  // Catalog is two-way: the main tab is authoritative, but when the
  // command tab mutates style_mappings via the styler's API calls we
  // publish the patched catalog back so the main tab's deck.gl stack
  // picks it up without a round trip through the server.
  useStateBusSync('layers:catalog', layerCatalog, setLayerCatalog, { requestOnMount: true });

  // Input-control commits POST to the server; bumping refreshKey here
  // syncs both tabs' InputControlPanel re-fetches via the 'controls'
  // channel. Pass the React setter directly — useStateBusSync's echo
  // guard compares the incoming bus value against the applied state, so
  // the setter must apply the incoming value verbatim (a wrapping
  // `(v) => v + 1` would diverge and produce a runaway publish loop).
  const [inputControlRefreshKey, setInputControlRefreshKey] = useState(0);
  useStateBusSync('controls', inputControlRefreshKey, setInputControlRefreshKey);

  // ── AI chart registry ───────────────────────────────────────────────────
  // Locally-mounted DAG so AI tool results in this tab's chat can register
  // chart specs (with SQL, datasets, format, plotlySpec). Without this the
  // ChatMessage falls back to an empty `chart` object → "Unknown Dataset"
  // in the DAG tab and no Pin/Pop-out buttons. Each tab keeps its own
  // chartDAG (mirrors the per-tab conversation). Declared up here so the
  // input-control side-effect handlers below can call refreshCharts.
  const { registerCategories } = useCategoryColors();
  const chartDAG = useChartDAG(registerCategories);

  // Per-AI-chart anchor mode override. chartDAG only knows
  // 'floating'/'tray'/'chat'; we layer side/bottom anchors on top via
  // this map. Mirrors App.jsx so the AiChartPanel chrome behaves the
  // same here as on the host.
  const [aiAnchorModes, setAiAnchorModes] = useState({});
  const aiAnchorFor = useCallback((chart) => {
    if (chart.placement === 'tray') return 'tray';
    return aiAnchorModes[chart.id] || 'floating';
  }, [aiAnchorModes]);
  const setAiAnchor = useCallback((chartId, mode) => {
    if (mode === 'tray') {
      chartDAG.setPlacement(chartId, 'tray');
      setAiAnchorModes((prev) => {
        const { [chartId]: _, ...rest } = prev;
        return rest;
      });
    } else {
      chartDAG.setPlacement(chartId, 'floating');
      setAiAnchorModes((prev) => ({ ...prev, [chartId]: mode }));
    }
  }, [chartDAG]);

  // Apply layer actions returned from a control commit. Same logic as
  // App.jsx#handleLayerActions: looks up layers by name and updates
  // local visibility/filter state. The synced state propagates to the
  // host via the existing 'layers:visibility' / 'layers:style' channels.
  const applyLayerActionsLocally = useCallback((actions) => {
    if (!actions?.length) return;
    for (const act of actions) {
      const target = layerCatalog.find((c) => c.name === act.targetLayerName);
      if (!target) continue;
      if (act.action === 'filter') {
        setGenericLayerLocalStyle((prev) => ({
          ...prev,
          [target.id]: {
            ...(prev[target.id] || {}),
            filterEnabled: true,
            filterProperty: act.filterProperty,
            filterCategories: [String(act.filterValue ?? act.sourceValue ?? '')],
          },
        }));
      } else if (act.action === 'clear_filter') {
        setGenericLayerLocalStyle((prev) => ({
          ...prev,
          [target.id]: {
            ...(prev[target.id] || {}),
            filterEnabled: false,
            filterCategories: [],
          },
        }));
      } else if (act.action === 'show') {
        setGenericLayerVisibility((prev) => ({ ...prev, [target.id]: true }));
      } else if (act.action === 'hide') {
        setGenericLayerVisibility((prev) => ({ ...prev, [target.id]: false }));
      }
    }
  }, [layerCatalog]);

  // Forward dataset invalidations to the host via 'controls:effects';
  // the host's subscriber calls handleDatasetsInvalidated to re-init
  // any TimeseriesBuffers + refresh affected charts. Also refresh our
  // local AI charts so any plots derived from the invalidated datasets
  // re-execute their SQL with the new control values.
  const handleICDatasetsInvalidated = useCallback((extName, datasets) => {
    bus.publish('controls:effects', {
      type: 'datasets-invalidated',
      extName,
      datasets,
    });
    chartDAG.refreshCharts(datasets);
    setInputControlRefreshKey((v) => v + 1);
  }, [chartDAG]);

  const handleICLayerActions = useCallback((actions) => {
    applyLayerActionsLocally(actions);
    setInputControlRefreshKey((v) => v + 1);
  }, [applyLayerActionsLocally]);

  // ── AI chat side-effect handlers (control-tab variants) ──────────────────
  // Most of these update synced state — `setGenericLayerVisibility` etc. —
  // and the existing 'layers:*' / 'scenario' / 'story' channels carry the
  // change to the host. handlers that need host-only state (capturing
  // live view for create_perspective; deck.gl hover charts) are best-
  // effort no-ops in this tab.
  const handleAIInputControlChanged = useCallback(
    (extName, _controlName, _value, invalidatedDatasets) => {
      if (invalidatedDatasets?.length > 0) {
        bus.publish('controls:effects', {
          type: 'datasets-invalidated',
          extName,
          datasets: invalidatedDatasets,
        });
        chartDAG.refreshCharts(invalidatedDatasets);
      }
      setInputControlRefreshKey((v) => v + 1);
    },
    [chartDAG],
  );
  const handleAILayerStyleChanged = useCallback((layerId, updatedMapping) => {
    // See useAiActions: a mapping with no style_id is not a DB row, and
    // appending one creates an entry the styler can never delete.
    if (updatedMapping?.style_id == null) return;
    setLayerCatalog((prev) => prev.map((lc) => {
      if (lc.id !== layerId) return lc;
      // Upsert: an agent creating a NEW mapping must be appended (not just
      // matched against existing rows), and the DB id must be carried over
      // from `style_id` so the styler's delete/edit affordances can target
      // it. Without this, agent-created mappings were undeletable here.
      const existing = lc.style_mappings || [];
      const has = existing.some((sm) => sm.id === updatedMapping.style_id);
      const newMappings = has
        ? existing.map((sm) =>
            sm.id === updatedMapping.style_id ? { ...sm, ...updatedMapping } : sm)
        : [...existing, { ...updatedMapping, id: updatedMapping.style_id }];
      return { ...lc, style_mappings: newMappings };
    }));
  }, []);
  const handleAILayerVisibilityChanged = useCallback((layerId, visible) => {
    setGenericLayerVisibility((prev) => ({ ...prev, [layerId]: visible }));
  }, []);
  const handleAICrossLayerConfig = useCallback((sourceLayerName, actions) => {
    const source = layerCatalog.find((c) => c.name === sourceLayerName);
    if (!source) return;
    setGenericLayerLocalStyle((prev) => ({
      ...prev,
      [source.id]: {
        ...(prev[source.id] || {}),
        interaction: {
          ...(prev[source.id]?.interaction || {}),
          clickContent: [],
          crossLayerActions: actions,
        },
      },
    }));
  }, [layerCatalog]);
  const handleAIApplyPerspective = useCallback((perspectiveId) => {
    setStoryState((prev) => ({ ...prev, activePerspectiveId: perspectiveId }));
  }, []);
  const handleAIApplyStory = useCallback((storyId) => {
    setStoryState({ storyId, activePerspectiveId: null });
  }, []);
  const handleAISwitchScenario = useCallback((_extension, project, scenario) => {
    setScenarioState({ project, scenario });
  }, []);

  // Mirror an AI chart from this tab's chat to the host display. Reads
  // the chart from the local chartDAG and publishes a self-contained
  // payload on the 'charts' channel; the host App.jsx subscriber
  // registers it in its own chartDAG and applies the requested
  // anchorMode (bottom / side-left / side-right / floating / tray).
  const handleMirrorAIChartToMain = useCallback((chartId, anchorMode) => {
    const chart = chartDAG.getChart(chartId);
    if (!chart) return;
    bus.publish('charts', {
      type: 'chart:open-ai',
      anchorMode,
      spec: chart.spec,
      datasets: chart.datasets || [],
      format: chart.format || 'plotly',
      plotlySpec: chart.plotlySpec || null,
      vegaLiteSpec: chart.vegaLiteSpec || null,
    });
  }, [chartDAG]);

  // Extensions catalog mirrored from the host. Toggling in the control
  // tab just broadcasts the updated list — the host's setExtensions
  // subscriber receives it and runs the full setExtensionPreference +
  // layer rebootstrap side effect over there.
  const [extensions, setExtensions] = useState([]);
  useStateBusSync('extensions', extensions, setExtensions, { requestOnMount: true });

  // Story state mirrored from the host. Publishing here (prev / next from a
  // popped-out controller) drives the host tab's handleApplyPerspective via
  // the 'story' subscriber in App.jsx. requestOnMount pulls the current
  // story state on join so a freshly-opened command tab knows what the
  // host is currently on.
  const [storyState, setStoryState] = useState({ storyId: null, activePerspectiveId: null });
  useStateBusSync('story', storyState, setStoryState, { requestOnMount: true });

  // ── Open frames (received via transfer) ─────────────────────────────────
  // useChartFrames owns the state, all CRUD ops, and the 'charts' bus
  // surface. defaultAnchor='tray' + panelAnchorOverride='tray' pins
  // newly-opened or received frames to the react-grid-layout in this tab;
  // requestOnMount fires the sync-request retry that asks paired tabs for
  // any tray-mode frames they want to push.
  const {
    frames: openScenarioCharts,
    setFrames: setOpenScenarioCharts,
    framesRef: openScenarioChartsRef,
    openScenarioChart: openLocalScenarioChart,
    closeFrame: closeScenarioChart,
    setAnchor: setScenarioChartAnchor,
    combine: combineScenarioCharts,
    split: splitScenarioChart,
    transfer: transferScenarioChart,
  } = useChartFrames({
    defaultAnchor: 'tray',
    panelAnchorOverride: 'tray',
    requestOnMount: true,
  });
  const seededControlRef = useRef(false);

  // Seed the control-mode panel set once allowedPanelKeys is known. For
  // operators allowedPanelKeys stays null (= "no filter"); we populate
  // immediately. For guests we wait for the /auth/guest/me roundtrip.
  // Using a deterministic key (rather than makeFrameKey) keeps the seed
  // stable across re-renders so react-grid-layout doesn't shuffle.
  useEffect(() => {
    if (!isControl || seededControlRef.current) return;
    if (!guestReady) return;
    seededControlRef.current = true;
    const keys = allowedPanelKeys === null
      ? Object.keys(PANEL_REGISTRY)
      : Object.keys(PANEL_REGISTRY).filter((k) => allowedPanelKeys.includes(k));
    setOpenScenarioCharts(keys.map((panelId, i) => ({
      key: `frame-control-${panelId}-${i}`,
      kind: 'panel',
      panelId,
      anchorMode: 'tray',
    })));
  }, [isControl, guestReady, allowedPanelKeys, setOpenScenarioCharts]);

  // Per-frame mirror state. Truthy = the chart has been pushed to the
  // paired display via the 'charts' bus channel; toggling false sends a
  // chart:close-frame intent so the display closes the matching frame.
  const [mirrorState, setMirrorState] = useState({}); // { frameKey -> bool }

  // Open in this tab AND publish to the main display. Marks the frame as
  // mirrored so the toggle in ChartFrame's header reflects the right
  // initial state. The display tab dedupes by chart identity, so a
  // re-mirror is a no-op there.
  const openAndMirrorScenarioChart = useCallback((extName, spec) => {
    const id = scenarioChartId({ extName, spec });
    if (openScenarioChartsRef.current.some(
      (e) => e.charts?.some((c) => scenarioChartId(c) === id)
    )) return;
    const newKey = makeFrameKey();
    setOpenScenarioCharts((prev) => [...prev, {
      key: newKey,
      charts: [{ extName, spec }],
      anchorMode: 'tray',
    }]);
    setMirrorState((prev) => ({ ...prev, [newKey]: true }));
    bus.publish('charts', {
      type: 'chart:open-frame',
      anchorMode: 'floating',
      charts: [{ extName, spec }],
    });
  }, [openScenarioChartsRef, setOpenScenarioCharts]);

  // Mirror toggle from a chart's header. On → push frame to display.
  // Off → publish a close intent with the frame identity; the display
  // matches and removes it.
  const handleMirrorToggle = useCallback((entryKey, next) => {
    const entry = openScenarioChartsRef.current.find((e) => e.key === entryKey);
    if (!entry) return;
    if (next) {
      bus.publish('charts', {
        type: 'chart:open-frame',
        anchorMode: 'floating',
        charts: (entry.charts || []).map((c) => ({
          extName: c.extName, spec: c.spec, entityId: c.entityId,
        })),
      });
    } else {
      const identity = frameIdentity(entry);
      if (identity) {
        bus.publish('charts', { type: 'chart:close-frame', identity });
      }
    }
    setMirrorState((prev) => ({ ...prev, [entryKey]: next }));
  }, [openScenarioChartsRef]);

  // ── Render ──────────────────────────────────────────────────────────────
  const [syncSettingsOpen, setSyncSettingsOpen] = useState(false);

  const candidateTitleFor = (entry) => {
    if (entry.kind === 'builtin-ts') {
      const b = entry.builtin || {};
      return `${b.label || 'Timeseries'} — ${b.entityId}`;
    }
    if (entry.charts.length > 1) return `${entry.charts.length} charts`;
    const c = entry.charts[0];
    const base = c?.spec?.display_name || c?.spec?.name || 'Untitled chart';
    return c?.entityId ? `${base} — ${c.entityId}` : base;
  };
  const trayEntries = openScenarioCharts.filter((e) => e.anchorMode === 'tray');
  const floatingEntries = openScenarioCharts.filter((e) => e.anchorMode !== 'tray');

  const renderPanel = (entry, i) => {
    if (entry.kind === 'panel') {
      const def = getPanelDef(entry.panelId);
      if (!def) return null;
      const PanelComponent = def.Component;
      // In a pop-out tab, state lives on the bus. Advancing chapters
      // publishes the new activePerspectiveId; the host tab applies it
      // (handleApplyPerspective) and echoes back. onCapture is null —
      // this tab has no live map to compare, so no drift indicator.
      const panelProps = {
        // story-playback
        storyId: storyState.storyId,
        activePerspectiveId: storyState.activePerspectiveId,
        onApplyChapter: (perspectiveId) => setStoryState({
          storyId: storyState.storyId,
          activePerspectiveId: perspectiveId,
        }),
        // Switching stories from the control tab clears the active
        // chapter; the host's story subscriber sees the new storyId,
        // the playback panel on the host auto-applies chapter 1 of the
        // newly-selected story, and that re-publishes the perspective
        // id back to us.
        onChangeStory: (newStoryId) => setStoryState({
          storyId: newStoryId,
          activePerspectiveId: null,
        }),
        onCapture: null,  // no live view in a controller tab
        // animation
        clockState,
        onClockChange: updateClockState,
        currentTimeLabel: '',
        // layers — catalog is pushed over the bus; panel falls back to
        // fetching via scenarioState if the catalog hasn't arrived yet.
        layers: layerCatalog.length > 0 ? layerCatalog : null,
        scenarioState,
        visibility: genericLayerVisibility,
        localStyle: genericLayerLocalStyle,
        onToggleVisibility: (id, next) => setGenericLayerVisibility((prev) => ({
          ...prev, [id]: next,
        })),
        onLocalStyleChange: (id, next) => setGenericLayerLocalStyle((prev) => ({
          ...prev, [id]: next,
        })),
        onStyleMappingsChange: (layerId, newMappings) => setLayerCatalog((prev) =>
          prev.map((lc) => (lc.id === layerId ? { ...lc, style_mappings: newMappings } : lc))
        ),
        // extensions
        extensions,
        onToggleExtension: (extName, newState) => {
          // Broadcast updated catalog; host applies the persistent toggle.
          setExtensions((prev) => prev.map(
            (e) => e.name === extName ? { ...e, state: newState } : e,
          ));
        },
        onOpenChart: openLocalScenarioChart,
        onOpenChartAndMirror: openAndMirrorScenarioChart,
        onScenarioChange: setScenarioState,
        // input-controls
        inputControlRefreshKey,
        onDatasetsInvalidated: handleICDatasetsInvalidated,
        onLayerActions: handleICLayerActions,
        // ai-chat
        chartDAG,
        onMirrorToMain: handleMirrorAIChartToMain,
        onInputControlChanged: handleAIInputControlChanged,
        onLayerStyleChanged: handleAILayerStyleChanged,
        onLayerVisibilityChanged: handleAILayerVisibilityChanged,
        onCrossLayerConfig: handleAICrossLayerConfig,
        onApplyPerspective: handleAIApplyPerspective,
        onApplyStory: handleAIApplyStory,
        onSwitchScenario: handleAISwitchScenario,
        // Tab has no live map → can't capture for create_perspective
        // and no deck.gl layer hover surface for create_hover_chart.
        // Best-effort no-ops; the AI tool calls succeed server-side and
        // any synced state updates still apply via the channels above.
        onCreatePerspective: undefined,
        onHoverChart: undefined,
        activeExtensions: extensions
          .filter((e) => e?.state !== 'disabled')
          .map((e) => e.name),
        // Story scope tracks the host tab over the sync channel, so a chat
        // opened in the tray gets the same chapter context as the main window.
        activeStoryId: storyState.storyId,
        activePerspectiveId: storyState.activePerspectiveId,
        anchoredLayers: new Set(),
        webgpu: false,
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
          initialFloatPosition={{ x: 120 + i * 30, y: 80 + i * 30 }}
          initialFloatSize={def.defaultSize}
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
          initialPos={{ x: 120 + i * 30, y: 80 + i * 30 }}
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
        mirrored={!!mirrorState[entry.key]}
        onMirrorToggle={(next) => handleMirrorToggle(entry.key, next)}
        combineCandidates={openScenarioCharts
          .filter((e) => e.key !== entry.key && e.kind !== 'builtin-ts' && e.kind !== 'panel')
          .map((e) => ({ key: e.key, title: candidateTitleFor(e) }))}
        onCombine={(sourceKey) => combineScenarioCharts(entry.key, sourceKey)}
        onSplit={(chartIndex) => splitScenarioChart(entry.key, chartIndex)}
        onTransfer={(targetTabId, mode) => transferScenarioChart(entry.key, targetTabId, mode)}
        initialPos={{ x: 120 + i * 30, y: 80 + i * 30 }}
        refreshKey={inputControlRefreshKey}
      />
    );
  };

  // ── AI chart frames (registered via chartDAG by the chat panel) ────────
  const renderAiPanel = (chart, i) => (
    <AiChartPanel
      key={chart.id}
      frameKey={`ai::${chart.id}`}
      chart={chart}
      anchorMode={aiAnchorFor(chart)}
      onAnchorModeChange={(mode) => setAiAnchor(chart.id, mode)}
      onClose={() => chartDAG.unregisterChart(chart.id)}
      anchored={false}
      onAnchorToggle={() => {}}
      webgpu={false}
      initialPos={{ x: 240 + i * 30, y: 100 + i * 30 }}
    />
  );
  const aiTrayCharts = chartDAG.getChartsByPlacement('tray');
  const aiFloatingCharts = chartDAG.getChartsByPlacement('floating');

  return (
    <Box sx={{ width: '100vw', height: '100vh', bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}>
      <Suspense fallback={
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <CircularProgress size={24} />
        </Box>
      }>
        <ChartTray
          charts={[]}
          rightOffset={0}
          fullscreen
          useGridLayout
          scenarioFrames={[
            ...trayEntries.map(renderPanel),
            ...aiTrayCharts.map(renderAiPanel),
          ]}
          panelAddOptions={Object.entries(PANEL_REGISTRY)
            .filter(([id]) => allowedPanelKeys === null || allowedPanelKeys.includes(id))
            .map(([id, def]) => ({
              id,
              title: def.title,
              icon: def.icon,
              disabled: def.singleton && openScenarioCharts.some(
                (e) => e.kind === 'panel' && e.panelId === id,
              ),
            }))}
          onAddPanel={(panelId) => {
            const def = PANEL_REGISTRY[panelId];
            if (!def) return;
            setOpenScenarioCharts((prev) => {
              if (def.singleton && prev.some(
                (e) => e.kind === 'panel' && e.panelId === panelId,
              )) return prev;
              return [...prev, {
                key: `frame-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                kind: 'panel',
                panelId,
                anchorMode: 'tray',
              }];
            });
          }}
        />
      </Suspense>

      {/* Any frame whose anchor-mode isn't 'tray' renders floating over the
          tray. Rare — users would only do this by explicitly changing the
          anchor in this tab. AI charts the user pops out from chat with
          "Pop out to map" land here too (via chartDAG placement='floating'). */}
      <Suspense fallback={null}>
        {floatingEntries.map(renderPanel)}
        {aiFloatingCharts.map(renderAiPanel)}
      </Suspense>

      {/* Empty-state hint so a fresh tray tab isn't a blank page. */}
      {openScenarioCharts.length === 0 && (
        <Box
          sx={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'text.secondary',
            pointerEvents: 'none',
            textAlign: 'center',
            px: 3,
          }}
        >
          <Typography variant="h6" sx={{ opacity: 0.6, mb: 1 }}>
            Chart Tray (standalone)
          </Typography>
          <Typography variant="body2" sx={{ opacity: 0.5, maxWidth: 440 }}>
            Send charts here from the main window using the
            &nbsp;<em>Send to window…</em>&nbsp; menu on any chart frame.
          </Typography>
        </Box>
      )}

      {syncSettingsOpen && (
        <SyncSettingsPanel onClose={() => setSyncSettingsOpen(false)} />
      )}
      <Box sx={{ position: 'fixed', bottom: 8, left: 8, zIndex: 1500 }}>
        <Tooltip title="Tab Sync Settings">
          <IconButton size="small" onClick={() => setSyncSettingsOpen((v) => !v)}>
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}
