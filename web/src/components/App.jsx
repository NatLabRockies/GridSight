import Tray from "./Tray.jsx";
import React, { useState, useEffect, useRef, useMemo, useCallback, Suspense, lazy } from "react";
import {
  DEFAULT_BASEMAP_ID, basemapById, applyFeatureVisibility,
  loadHiddenCategories, saveHiddenCategories,
} from '../lib/basemaps.js';
import "./app.css";
import MapView, { useControl, AttributionControl } from "react-map-gl/maplibre";
import { MapboxOverlay as DeckOverlay } from "@deck.gl/mapbox";
// _StatsWidget is the FPS / GPU-stats HUD. Underscore prefix is the
// deck.gl convention for "experimental but stable" — they ship the
// CSS and API together; we just gate it behind a Settings toggle.
import { _StatsWidget as StatsWidget } from "@deck.gl/widgets";
import "@deck.gl/widgets/stylesheet.css";
import {
  styled,
  useTheme,
} from "@mui/material/styles";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Drawer from "@mui/material/Drawer";
import List from "@mui/material/List";
import IconButton from "@mui/material/IconButton";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import LayersIcon from "@mui/icons-material/Layers";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import ChatPanel from "./chat/ChatPanel.jsx";
import DataPreviewPanel from "./controllers/DataPreviewPanel.jsx";
import ColorMapLegend from "./controllers/ColorMapLegend.jsx";
import LegendPanel from "./controllers/LegendPanel.jsx";
import ChartFrame from "./charts/ChartFrame.jsx";
import { getPanelDef } from "../lib/panelRegistry.jsx";
import SyncIcon from "@mui/icons-material/Sync";
import SyncDisabledIcon from "@mui/icons-material/SyncDisabled";
import Draggable from "react-draggable";
import ClockOverlay from "./shell/ClockOverlay.jsx";
import DialogsHost from "./shell/DialogsHost.jsx";
import BusSyncHost from "./shell/BusSyncHost.jsx";
import ViewportDebugHUD from "./shell/ViewportDebugHUD.jsx";
import SidebarHeader from "./shell/sidebar/SidebarHeader.jsx";
import ExtensionsSection from "./shell/sidebar/ExtensionsSection.jsx";
import SidebarToolsList from "./shell/sidebar/SidebarToolsList.jsx";
import LegacyLegend from "./shell/LegacyLegend.jsx";
import FloatingActionButtons from "./shell/FloatingActionButtons.jsx";

import {
  createGenericLayer,
  createHighlightLayer,
  buildDataIndex,
} from "../lib/layer_generators.js";
import {
  fetchScenarioLayers,
  fetchAllLayers,
  fetchInputControls,
  setInputControl,
  fetchGeometryData,
  fetchDatasetData,
  fetchExtensions,
  setExtensionPreference,
  fetchPerspective,
  updatePerspective,
  createPerspective,
  createStory,
  addStoryStep,
  invalidateCachePrefix,
} from "../lib/loaders.js";
import { captureViewState, applyViewState } from "../lib/viewState.js";
import { TimeseriesBuffer } from "../lib/TimeseriesBuffer.js";
import useChartDAG from "../lib/useChartDAG.js";
import { useCategoryColors } from "../lib/categoryColors.jsx";
import bus, { openSyncedTab } from "../lib/stateBus.js";
import useClockEngine from "../hooks/useClockEngine.js";
import useChartFrames from "../hooks/useChartFrames.js";
import useGpuPreference from "../hooks/useGpuPreference.js";
import useShowStats from "../hooks/useShowStats.js";
import useForceDpr1 from "../hooks/useForceDpr1.js";
import useMaxCanvasSize from "../hooks/useMaxCanvasSize.js";
import useWorkerPrecompute from "../hooks/useWorkerPrecompute.js";
import useGpuTimeseries from "../hooks/useGpuTimeseries.js";
import { useDisplayScale } from "../lib/DisplayScaleContext.jsx";
import { applyVerticalFillMinZoom, applyRenderPixelRatio } from "../lib/mapCamera.js";
import { logViewport } from "../lib/viewportDebug.js";
import useExtensionsCatalog from "../hooks/useExtensionsCatalog.js";
import { useActiveStoryPrompts } from "../hooks/useActiveStoryPrompts.js";
import { useChartFrameRenderers } from "../hooks/useChartFrameRenderers.jsx";
import { useLayerActions } from "../hooks/useLayerActions.js";
import { useScenarioLayerSync } from "../hooks/useScenarioLayerSync.js";
import useSpatialViewportLayers, { isSpatialLayer } from "../hooks/useSpatialViewportLayers.js";
import { useAiActions } from "../hooks/useAiActions.js";
import { useUiPanelState } from '../state/uiPanelState.js';
import { useMapDataState } from '../state/mapDataState.js';
import { useClockUIState } from '../state/clockUIState.js';
import { useExtensionDialogState } from '../state/extensionDialogState.js';
import { useLayoutState } from '../state/layoutState.js';
import { useLayerVersionState } from '../state/layerVersionState.js';
const EntityInteractionManager = lazy(() => import("./interaction/EntityInteractionManager.jsx"));
const ScenarioChartsPanel = lazy(() => import("./charts/ScenarioChartsPanel.jsx"));
const AiChartPanel = lazy(() => import("./charts/AiChartPanel.jsx"));
const BuiltinTimeseriesPanel = lazy(() => import("./charts/BuiltinTimeseriesPanel.jsx"));
import ChartTrayContainer from './shell/ChartTrayContainer.jsx';
import ChartsMenu from './shell/ChartsMenu.jsx';
import ChartDocks from './shell/ChartDocks.jsx';
import "maplibre-gl/dist/maplibre-gl.css";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DRAWER_FULL = 240;
const DRAWER_ICONS = 56;

// ---------------------------------------------------------------------------
// Styled components
// ---------------------------------------------------------------------------

const Main = styled("main", {
  shouldForwardProp: (prop) => prop !== "open" && prop !== "drawerWidth",
})(({ theme, open, drawerWidth: dw }) => ({
  flexGrow: 1,
  padding: theme.spacing(3),
  transition: theme.transitions.create("margin", {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  marginLeft: open ? 0 : `-${dw || DRAWER_FULL}px`,
}));

const DrawerHeader = styled("div")(({ theme }) => ({
  display: "flex",
  alignItems: "center",
  padding: theme.spacing(0, 1),
  ...theme.mixins.toolbar,
  justifyContent: "flex-end",
}));

// ---------------------------------------------------------------------------
// DeckGL overlay bridge
// ---------------------------------------------------------------------------

function DeckGLOverlay({ showStats, ...props }) {
  // The StatsWidget instance is created once and reused — instantiating
  // it inside setProps on every render leaks WebGL contexts. We swap
  // `widgets: []` ↔ `widgets: [statsWidget]` to toggle visibility,
  // which lets deck.gl re-attach/detach the HUD without rebuilding it.
  // Re-create on each enable so the widget always opens expanded —
  // StatsWidget exposes no imperative expand() API, so we let the next
  // toggle build a fresh instance with initialExpanded: true. The ref
  // is cleared on disable to release the prior instance.
  const statsRef = useRef(null);
  if (showStats && !statsRef.current) {
    statsRef.current = new StatsWidget({
      initialExpanded: true,
      placement: 'top-right',
    });
  } else if (!showStats && statsRef.current) {
    statsRef.current = null;
  }
  const widgets = showStats && statsRef.current ? [statsRef.current] : [];
  const overlay = useControl(() => new DeckOverlay({ ...props, widgets }));
  overlay.setProps({ ...props, widgets });
  return null;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const theme = useTheme();

  // Window role and view mode from URL params
  const [windowRole] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('role') || 'full';
  });
  const [viewMode] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('view') || 'full'; // 'full', 'chartTray', 'display'
  });
  const isDisplay = windowRole === 'display' || viewMode === 'display';
  const isController = windowRole === 'controller';

  const ui = useUiPanelState();
  const map = useMapDataState();
  const clockUi = useClockUIState();
  const extDialogs = useExtensionDialogState();
  const layout = useLayoutState();
  const versions = useLayerVersionState();

  const open = true; // sidebar is always visible
  const showLabels = ui.state.sidebarMode === 'full';
  const currentDrawerWidth = ui.state.sidebarMode === 'icons' ? DRAWER_ICONS : DRAWER_FULL;

  const handleDrawerToggle = () => {
    if (ui.state.sidebarMode === 'full') {
      layout.setListItemOpen({ layers: false, data: false, inputControls: false, animation: false, display: false, extensions: false, agentIntegration: false, developer: false });
      ui.collapseDrawer();
    } else {
      ui.setSidebarMode('full');
    }
  };

  // ── Extension manifests + per-extension scenario chart specs ─────────────
  // Both fetches live in useExtensionsCatalog. setExtensions is exposed so
  // optimistic local updates (extension toggle, scenario create) can patch
  // the cached manifest list without waiting for a re-fetch round-trip.
  const {
    extensions, extensionsLoaded, scenarioChartSpecs, setExtensions,
    refreshScenarioCharts,
  } = useExtensionsCatalog();

  // Scenario-charts menu (which extension's "Charts" button is currently open)
  // -> ui.state.chartsMenu / ui.setChartsMenu
  // Open scenario chart panels. Each entry is ONE ChartFrame and can host
  // multiple charts stacked vertically (via the "combine" action), all
  // sharing a single toolbar + x-axis. Shape:
  //   { key, charts: [{ extName, spec }, ...], anchorMode }
  // useChartFrames owns the state, all CRUD ops, and the 'charts' bus
  // surface (open-frame / close-frame / sync-request).
  const {
    frames: openScenarioCharts,
    setFrames: setOpenScenarioCharts,
    framesRef: openScenarioChartsRef,
    openScenarioChart: hookOpenScenarioChart,
    openEntityChart,
    openBuiltinTimeseries,
    openPanel,
    closeFrame: closeScenarioChart,
    setAnchor: setScenarioChartAnchor,
    setGeom: setScenarioChartGeom,
    combine: combineScenarioCharts,
    split: splitScenarioChart,
    transfer: transferScenarioChart,
  } = useChartFrames({ defaultAnchor: 'tray' }); // charts pop up docked in the tray; float on demand

  function openScenarioChart(extName, spec) {
    hookOpenScenarioChart(extName, spec);
    ui.setChartsMenu(null);
  }

  // Live refresh of already-open chart frames when the catalog re-fetches
  // (e.g. after GAT display-group color writes — useExtensionsCatalog bumps
  // its refreshTick which yields a new scenarioChartSpecs object). Each
  // open chart holds a captured spec object; here we swap in the fresh
  // one when the (extName, spec.name) tuple matches and the chart_options
  // actually differ. JSON stringify is cheap for a single spec and avoids
  // re-rendering when nothing actually changed.
  useEffect(() => {
    setOpenScenarioCharts((prev) => {
      let anyChange = false;
      const next = prev.map((frame) => {
        let frameChanged = false;
        const newCharts = (frame.charts || []).map((c) => {
          if (!c?.extName || !c?.spec?.name) return c;
          const fresh = (scenarioChartSpecs[c.extName] || []).find(
            (s) => s.name === c.spec.name,
          );
          if (!fresh || fresh === c.spec) return c;
          if (JSON.stringify(fresh.chart_options) === JSON.stringify(c.spec.chart_options)) {
            return c;
          }
          frameChanged = true;
          return { ...c, spec: fresh };
        });
        if (frameChanged) {
          anyChange = true;
          return { ...frame, charts: newCharts };
        }
        return frame;
      });
      return anyChange ? next : prev;
    });
  }, [scenarioChartSpecs, setOpenScenarioCharts]);

  // Dock sizes — reported by ChartDock on every resize. Used by siblings
  // that need to dodge the dock (map legends, chart tray) so they stay
  // visible when the dock is open.
  const [bottomDockSize, setBottomDockSize] = useState(0);
  const hasBottomDock = openScenarioCharts.some((c) => c.anchorMode === 'bottom');
  const legendBottomOffset = hasBottomDock ? bottomDockSize : 0;

  // Group open scenario-chart entries by anchor mode and build a shared
  // render helper. Lifted out of the JSX so the ChartTray (far down) can
  // also render tray-mode frames via the same path.
  const groupedScenarioCharts = { floating: [], 'side-left': [], 'side-right': [], bottom: [], tray: [] };
  openScenarioCharts.forEach((entry) => {
    (groupedScenarioCharts[entry.anchorMode] ?? groupedScenarioCharts.floating).push(entry);
  });

  // Per-AI-chart anchor mode (chartDAG only knows 'floating'/'tray'/'chat',
  // so we layer side/bottom anchors on top via this map). When the user
  // picks a non-tray anchor we stash it here and tell chartDAG the chart
  // is 'floating'; when they pick 'tray' we forward to chartDAG.
  const [aiAnchorModes, setAiAnchorModes] = useState({}); // chartId -> anchorMode
  const aiAnchorFor = (chart) => {
    if (chart.placement === 'tray') return 'tray';
    return aiAnchorModes[chart.id] || 'floating';
  };
  const setAiAnchor = (chartId, mode) => {
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
  };
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
  // Chart-frame renderers are built via useChartFrameRenderers below
  // (after currentTime / handleApplyPerspective / handleExtensionToggle
  // exist) and consumed in the JSX further down.

  // ── Scenario state ────────────────────────────────────────────────────────
  const [scenarioState, updateScenarioState] = useState({
    project: "",
    scenario: "",
  });

  const onSChange = (value) => updateScenarioState(value);

  // ── Base layer ────────────────────────────────────────────────────────────
  // Tracked by registry id (string) — clean to sync across displays and to
  // know whether feature toggles apply (vector vs raster). Resolved to a
  // MapLibre style at render via basemapById().
  const [BaseLayer, updateBaseLayer] = useState(DEFAULT_BASEMAP_ID);
  // Basemap feature categories the operator has hidden (streets, waterways, …)
  // to declutter — especially on the wall. Persisted across reloads.
  const [hiddenBasemapCategories, setHiddenBasemapCategories] = useState(loadHiddenCategories);
  // Ref mirror so the map's `style.load` handler (attached once) always reads
  // the current hidden set without re-binding.
  const hiddenBasemapCategoriesRef = useRef(hiddenBasemapCategories);
  hiddenBasemapCategoriesRef.current = hiddenBasemapCategories;
  // Same pattern for the open extension sub-tray (see refreshExtensionsAndLayers).
  const expandedExtRef = useRef(null);
  expandedExtRef.current = ui.state.expandedExt;
  const toggleBasemapCategory = (catId) => {
    setHiddenBasemapCategories((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId); else next.add(catId);
      saveHiddenCategories(next);
      return next;
    });
  };
  // Re-apply when the operator toggles a category (same style, no reload).
  useEffect(() => {
    const m = mapRef.current?.getMap?.();
    if (m) applyFeatureVisibility(m, hiddenBasemapCategories);
  }, [hiddenBasemapCategories]);

  // ── Generic layer state ────────────────────────────────────────────────────
  // genericLayerConfigs: layer records from the DB (geometry + datasets + style_mappings)
  // genericLayerGeo: { layerId -> GeoJSON FeatureCollection }
  // genericLayerData: { layerId -> Map(joinKey -> row|number) }
  //   static dataset: Map<entityId -> rowObject>   (from buildDataIndex)
  //   timeseries:     Map<entityId -> number>       (from TimeseriesBuffer at current index)
  // genericLayerVisibility: { layerId -> boolean }
  // Generic layer state (configs, geo, data, visibility, localStyle, anchoredLayers, anchoredCharts)
  // now lives in `map` (useMapDataState).
  // handleAnchorToggle / handleChartAnchorToggle now come from useLayerActions
  // (called further down, after autoRescaleColormap is defined).
  // inputControlRefreshKey lives in `versions` (useLayerVersionState).

  // Extension chart specs + data are cached by name (cachedRequest). With
  // stable chart names (no control-state token), the cache key no longer
  // changes when controls change — so bust the chart caches whenever the
  // input-control refresh key bumps. That key is synced across tabs via the
  // 'controls' channel, so a follower display busts + re-fetches too and
  // picks up the controller's selection from the shared extension instance.
  // (Static layer datasets use cache:'no-store', so they need no busting.)
  useEffect(() => {
    invalidateCachePrefix('chart-data:');
    invalidateCachePrefix('ext-charts:');
  }, [versions.state.inputControlRefreshKey]);

  // Shared categorical color map — used by charts and map layers
  const { registerCategories } = useCategoryColors();

  // Reactive chart DAG — manages active charts and refreshes them on data changes
  const chartDAG = useChartDAG(registerCategories);

  // ── StateBus initialization (session-based, opt-in sync) ─────────────────
  const [sessionBorderFlash, setSessionBorderFlash] = useState(false);
  useEffect(() => {
    // Load session + sync flags from URL params (auto-join if ?join_session=...)
    bus.loadFromURL();

    // Flash border when another tab requests identification
    const unflash = bus.onFlash(() => {
      setSessionBorderFlash(true);
      setTimeout(() => setSessionBorderFlash(false), 1500);
    });

    return () => {
      unflash();
      // Don't destroy the bus — it's a singleton that survives HMR re-mounts.
      // The discovery heartbeat continues running in the background.
    };
  }, []);

  // Hide the local ChartTray when a peer in the session is the dedicated
  // chart-tray view (view=chartTray). The tray "moved" to the popout; if
  // the user closes that popout, this returns to true and the tray
  // reappears with its existing contents (state is preserved locally).
  useEffect(() => {
    const check = () => {
      const sid = bus.getSessionId();
      if (!sid) { layout.setTrayPoppedOut(false); return; }
      const has = bus.discovery.getTabs().some(
        (t) => t.sessionId === sid && (t.url || '').includes('view=chartTray')
      );
      layout.setTrayPoppedOut(has);
    };
    check();
    const unsub = bus.discovery.onChange(check);
    const onSyncChange = bus.onSyncChange(check);
    return () => { unsub(); onSyncChange(); };
  }, []);

  // NOTE: StateBus sync hooks moved below after all useState declarations

  // ── WebGPU support + user preference ─────────────────────────────────────
  // `gpu.active` is the boolean to pass to consumers that opt into a
  // WebGPU code path (chartgpu-react). It's true only when the browser
  // supports WebGPU AND the user hasn't toggled it off in Settings.
  // The user-facing status + toggle live in the Settings panel.
  const gpu = useGpuPreference();
  const stats = useShowStats();
  const forceDpr1 = useForceDpr1();
  const maxCanvasSize = useMaxCanvasSize();
  const workerPrecompute = useWorkerPrecompute();
  const gpuTimeseries = useGpuTimeseries();
  // CSS `body { zoom: scale }` is applied by DisplayScaleProvider for wide
  // monitors (auto-scale starts at 3440px). Anything positioned with
  // `position: fixed` + `vh` units has its real-pixel footprint multiplied
  // by `displayScale`, so the Tray needs to divide by it to fit visibly.
  const { scale: displayScale } = useDisplayScale();
  const gpuCapabilities = {
    webgpu: gpu.active,
    supported: gpu.supported,
    adapter: gpu.adapter,
    checked: gpu.checked,
  };

  // Holds TimeseriesBuffer instances keyed by datasetId (not layerId) to avoid
  // duplicate buffers when multiple layers share the same timeseries dataset.
  /** @type {React.MutableRefObject<Map<number, TimeseriesBuffer>>} */
  const mapRef = useRef(null);

  // Track cross-layer drill-down so zoom-out can reverse it.
  // { hiddenLayers: [id, …], shownLayers: [id, …], filteredLayers: [{ id, prev }, …], zoomThreshold: number }
  const drillDownRef = useRef(null);
  // Monotonic counter bumped whenever any buffer's currentValues changes.
  // Triggers React re-render so deck.gl layers pick up new data.
  // tsVersion lives in `versions` (useLayerVersionState).
  // Bumped whenever a static (non-timeseries) layer dataset is re-fetched.
  // Threaded into createGenericLayer so deck.gl's updateTriggers see a
  // new sig and re-evaluate fillColor accessors against the fresh dataIndex.
  // staticVersion lives in `versions` (useLayerVersionState).

  // ── Clock / animation state ───────────────────────────────────────────────
  // useClockEngine owns the rAF tick + bus sync. Only the *anchor*
  // (animate, frequency, range, startWallTime, startIndex, showClock)
  // travels over the bus; the live index is computed locally from the
  // anchor on every animation frame so two tabs don't race-publish
  // per-tick index updates.
  const [clockState, updateClockState, broadcastClockAnchor] = useClockEngine();

  // StateBus sync hooks + viewport/extensions subscribers live in BusSyncHost
  // (mounted in the render tree below).
  // 'clock' channel sync is handled inside useClockEngine — see hook for
  // the anchor/derived-index split.

  // ── Scenario-driven layer sync (refs + bootstrap + filter + autoRescale + effect)
  const layerSync = useScenarioLayerSync({
    scenarioState,
    extensions,
    extensionsLoaded,
    map,
    versions,
    updateClockState,
  });
  const {
    timeseriesBuffersRef,
    layerToDatasetsRef,
    scenarioGenRef,
    bootstrapLayers,
    filterLayersByExtensions,
    autoRescaleColormap,
    pendingPerspectiveStyleRef,
  } = layerSync;

  // Viewport-driven loading for spatial (DuckDB-backed) geometry layers. Only
  // the features inside the current map bounds are fetched, at a zoom-
  // appropriate detail. Fired on moveend (below) and when the set of visible
  // spatial layers changes.
  const setSpatialLayerGeo = useCallback(
    (layerId, fc) => map.setLayerGeo(layerId, fc),
    [map],
  );
  const refetchSpatialViewport = useSpatialViewportLayers({
    layers: map.state.configs,
    visibility: map.state.visibility,
    localStyle: map.state.localStyle,
    onGeo: setSpatialLayerGeo,
  });

  // Fetch an initial viewport whenever the set of visible spatial layers
  // changes (e.g. a spatial layer is added or toggled on) — otherwise nothing
  // shows until the user first pans. Uses the map's current bounds/zoom.
  const visibleSpatialKey = (map.state.configs || [])
    .filter((lc) => isSpatialLayer(lc) && map.state.visibility?.[lc.id] !== false)
    .map((lc) => lc.id)
    .join(',');
  useEffect(() => {
    if (!visibleSpatialKey) return;
    const m = mapRef.current?.getMap?.();
    const b = m?.getBounds?.();
    if (!b) return;
    refetchSpatialViewport(
      { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() },
      m.getZoom(),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSpatialKey]);

  // (Removed: an initial `fetchAllLayers()` effect used to fire when
  // extensions finished loading. It pulled layers for *every* (project,
  // scenario) pair and started downloading their geometry + dataset
  // partitions, racing the scenario-specific effect below. With multiple
  // scenarios in the registry that meant ~2× the geometry/dataset traffic
  // on every cold load. The scenario-change effect handles the active
  // scenario fully; when no scenario is selected the map is intentionally
  // empty until the user picks one. Extension-toggle / scenario-create
  // paths still call `fetchAllLayers()` because they need a fresh view
  // across all scenarios after a backend-side change.)


  // ── Update timeseries buffer data on every clock tick ─────────────────────
  // getDataAtIndex() updates buffer.currentValues in-place and returns true/false.
  // We bump tsVersion to trigger a React re-render so deck.gl sees new updateTrigger values.
  //
  // When the index change is a SCRUB (vs. sequential playback) the target
  // partition may not be in memory yet — getDataAtIndex returns false. In
  // that case we fire an on-demand partition load and re-read once it lands,
  // so scrubbing to any time (including far-ahead via chart click) reliably
  // updates the map instead of freezing on the last loaded frame.
  // rAF coalescing: ticks arrive from setTimeout boundaries, which can land
  // mid-frame. Gating setTsVersion behind rAF aligns the React render +
  // deck.gl attribute upload with the start of a fresh frame, giving them
  // the full 16.7 ms budget. If multiple ticks land in one frame (rapid
  // scrubbing), they coalesce into a single render with the latest values
  // (getDataAtIndex mutates buf.currentValues in place, so by the time the
  // rAF fires the buffer already holds the most recent index's data).
  const tsRafRef = useRef(null);
  const scheduleTsCommit = () => {
    if (tsRafRef.current != null) return;
    tsRafRef.current = requestAnimationFrame(() => {
      tsRafRef.current = null;
      versions.bumpTs();
    });
  };
  useEffect(() => () => {
    if (tsRafRef.current != null) cancelAnimationFrame(tsRafRef.current);
  }, []);

  useEffect(() => {
    const buffers = timeseriesBuffersRef.current;
    if (!buffers.size) return;

    // Only advance buffers feeding a VISIBLE layer. Every buffer used to tick,
    // including those behind hidden layers, and advancing one isn't free: it
    // prefetches ±3 partitions, and each new partition costs a fetch plus a
    // main-thread Arrow parse and vector-cache rebuild (10k+ columns on the
    // bigger tables). A hidden layer whose dataset spans far more partitions
    // than the clock's range therefore keeps loading partitions the animation
    // will never display, overflowing the LRU and hitching at every partition
    // boundary — the stutter, at consistent spots, with everything "cached".
    //
    // Safe to skip: the next tick advances a layer that just became visible,
    // and visibility is in this effect's deps so showing one advances it
    // immediately even while paused. A miss is already handled below.
    const visibleDatasetIds = new Set();
    const mappedDatasetIds = new Set();
    for (const [layerId, roleMap] of layerToDatasetsRef.current) {
      const hidden = map.state.visibility[layerId] === false;
      for (const dsId of roleMap.values()) {
        mappedDatasetIds.add(dsId);
        if (!hidden) visibleDatasetIds.add(dsId);
      }
    }

    let changed = false;
    const misses = [];
    for (const [dsId, buf] of buffers) {
      // Skip only datasets a layer actually claims AND that no visible layer
      // uses. Buffers no layer has mapped yet still tick — dropping them would
      // stall a layer whose dataset mapping lands after its buffer does.
      if (mappedDatasetIds.has(dsId) && !visibleDatasetIds.has(dsId)) continue;
      if (buf.getDataAtIndex(clockState.index)) {
        changed = true;
      } else {
        misses.push(buf);
      }
    }
    if (changed) scheduleTsCommit();

    if (misses.length === 0) return;
    const targetIndex = clockState.index;
    let cancelled = false;
    (async () => {
      await Promise.all(misses.map((buf) => buf.ensurePartitionLoaded(targetIndex)));
      // The effect's cleanup sets `cancelled = true` when the clock moves
      // to a new index before our loads finish — skip the commit in that
      // case so we don't briefly paint a stale frame.
      if (cancelled) return;
      let late = false;
      for (const buf of misses) {
        if (buf.getDataAtIndex(targetIndex)) late = true;
      }
      if (late) scheduleTsCommit();
    })();
    return () => { cancelled = true; };
    // `visibility` is a dep so a layer switched on mid-animation (or while
    // paused) advances its buffer right away instead of waiting for the next
    // tick, which would otherwise leave it a frame stale.
  }, [clockState.index, map.state.visibility]);

  // handleGenericLayer{Visibility,LocalStyle,StyleMapping,Deleted,Added}Change
  // now come from useLayerActions (called further down).

  // ── Build deck.gl layers ─────────────────────────────────────────────────

  // ── Entity interaction state (hover/click popups) ─────────────────────────
  // Shape: { layerId, entityId, feature, coordinate: {x,y,lng,lat}, trigger: 'hover'|'click', content: string[] }
  const [interactionState, setInteractionState] = useState(null);

  // Clear any active hover when playback starts — picking is disabled during
  // animation, so a stale hover tooltip would never auto-dismiss otherwise.
  useEffect(() => {
    if (clockState.animate) {
      setInteractionState((prev) => (prev?.trigger === 'hover' ? null : prev));
    }
  }, [clockState.animate]);

  // 'tooltip' sync (publish + subscribe) lives in BusSyncHost.
  // Refs so the bus subscriber (which mounts once) can dispatch into the
  // latest version of the click handler — handleLayerClick is recreated
  // each render and closes over map.state.configs / map.state.localStyle,
  // which we need fresh values of when running cross-layer actions.
  const handleLayerClickRef = useRef(null);
  const handleLayerHoverRef = useRef(null);
  // Stable dispatchers — identity-stable across renders so the layer-
  // construction memo doesn't invalidate on every render.
  const stableLayerClick = useCallback((info) => handleLayerClickRef.current?.(info), []);
  const stableLayerHover = useCallback((info) => handleLayerHoverRef.current?.(info), []);

  function handleLayerHover(info) {
    if (!info.object) {
      setInteractionState((prev) => (prev?.trigger === 'hover' ? null : prev));
      return;
    }
    setInteractionState((prev) => {
      if (prev?.trigger === 'click') return prev;
      const layerId = info.layerId;
      const interaction = map.state.localStyle[layerId]?.interaction ?? {};
      // Hover tooltips are off by default — opt in by setting
      // interaction.hoverContent on the layer's local style. Click
      // tooltips remain on by default (see clickContent below).
      const hoverContent = interaction.hoverContent ?? [];
      if (!hoverContent.length) return prev;
      const lc = map.state.configs.find((c) => c.id === layerId);
      const geomJoinKey = lc?.geometry?.join_key;
      const entityId = geomJoinKey ? String(info.object.properties?.[geomJoinKey] ?? '') : null;
      return {
        layerId,
        entityId,
        feature: info.object,
        coordinate: { x: info.x, y: info.y, lng: info.coordinate?.[0], lat: info.coordinate?.[1] },
        trigger: 'hover',
        content: hoverContent,
      };
    });
  }

  function handleLayerClick(info) {
    if (!info.object) {
      setInteractionState(null);
      return;
    }
    const layerId = info.layerId;
    const interaction = map.state.localStyle[layerId]?.interaction ?? {};

    // ── Cross-layer actions ──────────────────────────────────────────────
    const crossActions = interaction.crossLayerActions;
    if (crossActions?.length) {
      const feature = info.object;
      // Record drill-down so zoom-out can reverse it
      const drillDown = { hiddenLayers: [], shownLayers: [], filteredLayers: [], zoomThreshold: null };
      // NOTE: `map` (outer scope) is the React hook from useMapDataState
      // — it owns setLayerVisibility, patchLayerStyle, state.configs etc.
      // `mapInstance` is the raw MapLibre handle, used only for fitBounds
      // below. A prior version of this block declared `const map = ...`
      // here and shadowed the hook for the whole if-block, which crashed
      // hide_self/show/filter at runtime (MapLibre has no setLayerVisibility).
      const mapInstance = mapRef.current?.getMap?.();

      for (const act of crossActions) {
        if (act.action === 'hide_self') {
          map.setLayerVisibility(layerId, false);
          drillDown.hiddenLayers.push(layerId);
        } else if (act.action === 'show' && act.targetLayerName) {
          const target = map.state.configs.find((c) => c.name === act.targetLayerName);
          if (target) {
            map.setLayerVisibility(target.id, true);
            drillDown.shownLayers.push(target.id);
          }
        } else if (act.action === 'filter' && act.targetLayerName) {
          const target = map.state.configs.find((c) => c.name === act.targetLayerName);
          if (target) {
            const sourceVal = String(feature.properties?.[act.sourceProperty] ?? '');
            map.patchLayerStyle(target.id, {
              filterEnabled: true,
              filterProperty: act.filterProperty,
              filterCategories: [sourceVal],
            });
            drillDown.filteredLayers.push(target.id);
          }
        } else if (act.action === 'fly_to_bounds') {
          // Compute bounding box of clicked feature and fly to it
          if (mapInstance && feature.geometry) {
            const coords = [];
            const extractCoords = (geom) => {
              if (geom.type === 'Polygon') {
                for (const ring of geom.coordinates) for (const c of ring) coords.push(c);
              } else if (geom.type === 'MultiPolygon') {
                for (const poly of geom.coordinates) for (const ring of poly) for (const c of ring) coords.push(c);
              }
            };
            extractCoords(feature.geometry);
            if (coords.length > 0) {
              let [minLng, minLat, maxLng, maxLat] = [Infinity, Infinity, -Infinity, -Infinity];
              for (const [lng, lat] of coords) {
                if (lng < minLng) minLng = lng;
                if (lat < minLat) minLat = lat;
                if (lng > maxLng) maxLng = lng;
                if (lat > maxLat) maxLat = lat;
              }
              mapInstance.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 40, duration: 1000 });
            }
          }
        }
      }

      // Record drill-down state. Wait for the fly animation to finish, then
      // snapshot the destination zoom and set the threshold just below it so
      // the reversal triggers consistently as soon as the user zooms out.
      if (drillDown.hiddenLayers.length || drillDown.shownLayers.length || drillDown.filteredLayers.length) {
        // Use a fixed zoom threshold so the reversal feels consistent
        // regardless of state size. The initial view is zoom ~5; states
        // become clearly distinguishable around zoom 5.
        drillDown.zoomThreshold = 5;
        drillDownRef.current = null;
        // `once` is a MapLibre listener — use the raw instance, not the
        // hook (the hook has no `.once`).
        if (mapInstance) {
          mapInstance.once('idle', () => { drillDownRef.current = drillDown; });
        }
      }

      // Cross-layer actions handled. If the layer also declares clickContent,
      // fall through so the popup (e.g. a comparison chart) opens alongside
      // the drilldown. If clickContent is empty/unset, dismiss as before so
      // the drill-only behavior of older configs is preserved.
      if (!(interaction.clickContent ?? []).length) {
        setInteractionState(null);
        return;
      }
    }

    // ── Normal click interaction ─────────────────────────────────────────
    const clickContent = interaction.clickContent ?? ['infocard', 'timeseries'];
    if (!clickContent.length) return;
    const lc = map.state.configs.find((c) => c.id === layerId);
    const geomJoinKey = lc?.geometry?.join_key;
    const entityId = geomJoinKey ? String(info.object.properties?.[geomJoinKey] ?? '') : null;
    setInteractionState({
      layerId,
      entityId,
      feature: info.object,
      coordinate: { x: info.x, y: info.y, lng: info.coordinate?.[0], lat: info.coordinate?.[1] },
      trigger: 'click',
      content: clickContent,
    });
  }

  // ── Zoom-out reversal of cross-layer drill-down ────────────────────────
  // Track whether the user is actively interacting with the map
  const mapInteractingRef = useRef(false);
  const viewportDebounceRef = useRef(null);
  // Suppress viewport publishing while a sync-triggered flyTo is animating
  const syncFlyingRef = useRef(false);

  function handleMapMoveStart() {
    mapInteractingRef.current = true;
  }

  // Enforce the vertical-fill minimum zoom (see lib/mapCamera.js) on load and
  // on every resize, so a tall viewport can't lock the camera to the pole.
  function handleMapLoad(evt) {
    const m = evt?.target;
    if (!m) return;
    // Apply the operator's basemap feature toggles now, and re-apply on every
    // subsequent style swap (selecting a different basemap reloads the style,
    // which resets layer visibility). Reads the ref so it stays current.
    const applyBasemapFeatures = () => applyFeatureVisibility(m, hiddenBasemapCategoriesRef.current);
    applyBasemapFeatures();
    m.on('style.load', applyBasemapFeatures);
    const minZoom = applyVerticalFillMinZoom(m);
    const pixelRatio = applyRenderPixelRatio(m, displayScale);
    logViewport('load', {
      minZoom,
      pixelRatio,
      containerH: m.getContainer?.()?.clientHeight,
      containerW: m.getContainer?.()?.clientWidth,
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio : null,
    });
    m.on('resize', () => {
      const mz = applyVerticalFillMinZoom(m);
      logViewport('resize', {
        minZoom: mz,
        containerH: m.getContainer?.()?.clientHeight,
        containerW: m.getContainer?.()?.clientWidth,
      });
    });
  }

  function handleMapMoveEnd(evt) {
    mapInteractingRef.current = false;
    // Don't publish if this moveEnd was caused by an incoming sync flyTo
    if (syncFlyingRef.current) return;
    // Debounce: publish viewport after interaction stops + 150ms settle time
    if (viewportDebounceRef.current) clearTimeout(viewportDebounceRef.current);
    viewportDebounceRef.current = setTimeout(() => {
      if (evt.viewState) {
        // Include the visible lat/lon bounds so a follower in "fit to bounds"
        // mode can frame the same geography regardless of its viewport
        // size/aspect (see lib/viewportSyncMode.js).
        const m = mapRef.current?.getMap?.();
        const b = m?.getBounds?.();
        const boundsObj = b ? { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() } : null;
        const payload = {
          latitude: evt.viewState.latitude,
          longitude: evt.viewState.longitude,
          zoom: evt.viewState.zoom,
          bearing: evt.viewState.bearing ?? 0,
          pitch: evt.viewState.pitch ?? 0,
          bounds: boundsObj,
        };
        bus.publish('viewport', payload);
        logViewport('publish', payload);
        // Reload spatial layers for the new viewport (only fetches is_spatial
        // layers; no-op otherwise). Server + snapped-bbox cache keep this cheap.
        if (boundsObj) refetchSpatialViewport(boundsObj, evt.viewState.zoom);
      }
    }, 150);
  }

  function handleMapMove(evt) {
    const dd = drillDownRef.current;
    if (!dd) return;
    const zoom = evt.viewState?.zoom ?? evt.target?.getZoom?.() ?? null;
    if (zoom == null || zoom > dd.zoomThreshold) return;

    // Reverse: re-show hidden layers, re-hide shown layers, clear filters
    {
      const next = { ...map.state.visibility };
      for (const id of dd.hiddenLayers) next[id] = true;
      for (const id of dd.shownLayers) next[id] = false;
      map.replaceVisibilityMap(next);
    }
    {
      const next = { ...map.state.localStyle };
      for (const id of dd.filteredLayers) {
        next[id] = { ...(next[id] || {}), filterEnabled: false, filterCategories: [] };
      }
      map.replaceLocalStyleMap(next);
    }
    drillDownRef.current = null;
  }

  // ── Dataset invalidation callback for input controls ────────────────────
  // When an extension's input control changes and returns invalidated_datasets,
  // destroy affected timeseries buffers and re-initialize them so the map
  // picks up fresh data.
  // (autoRescaleColormap now lives in useScenarioLayerSync — destructured above.)

  const {
    handleAnchorToggle,
    handleChartAnchorToggle,
    handleGenericLayerVisibilityChange,
    handleGenericLayerLocalStyleChange,
    handleGenericLayerStyleMappingChange,
    handleGenericLayerDeleted,
    handleGenericLayerAdded,
    handleDatasetsInvalidated,
    handleLayerActions,
  } = useLayerActions({
    map,
    versions,
    chartDAG,
    clockState,
    timeseriesBuffersRef,
    layerToDatasetsRef,
    autoRescaleColormap,
    extensions,
    filterLayersByExtensions,
    bootstrapLayers,
  });

  // 'controls:effects' subscribe + AI chart mirror subscribe live in BusSyncHost.

  // AI-driven handlers (input controls, layer style/visibility, cross-layer,
  // hover chart, perspective/story/scenario triggers) live in useAiActions
  // and are called below, after handleApplyPerspective is defined.

  // ── Perspective round-trip ───────────────────────────────────────────────
  // Live state is read via captureLiveStateRef.current() at the moment a
  // perspective is created, and applied via applyViewState's dispatchers.
  // The ref pattern lets the helper functions (defined here) close over
  // the latest values without re-binding the callbacks on every render.
  const captureLiveStateRef = useRef(null);
  const applyDispatchersRef = useRef(null);

  const handleApplyPerspective = useCallback(async (perspectiveId) => {
    if (!perspectiveId) { layout.setActivePerspective(null); return; }
    try {
      const persp = await fetchPerspective(perspectiveId);
      const blob = persp?.config_json
        ? (typeof persp.config_json === 'string'
            ? JSON.parse(persp.config_json) : persp.config_json)
        : null;
      if (!blob) {
        layout.setActivePerspective(perspectiveId);
        return;
      }
      // Stage the chapter's presentation so an async scenario/extension reload
      // re-asserts it instead of clobbering it with default_style/painting.
      // Without this the FIRST click on a chapter that changes scenario landed
      // on defaults (the reload raced applyViewState) and only a second click
      // — same scenario, no reload — looked right. TTL covers the reload(s).
      pendingPerspectiveStyleRef.current = blob.layers ? {
        localStyle: blob.layers.localStyle || {},
        visibility: blob.layers.visibility || {},
        deadline: Date.now() + 3000,
      } : null;
      const dispatchers = applyDispatchersRef.current;
      if (dispatchers) applyViewState(blob, dispatchers);
      layout.setActivePerspective(perspectiveId);
    } catch (e) {
      console.warn('[App] applyPerspective error:', e);
    }
  }, []);

  const {
    handleAIInputControlChanged,
    handleAILayerStyleChanged,
    handleAILayerGeoMappingChanged,
    handleAILayerVisibilityChanged,
    handleAICrossLayerConfig,
    handleAIApplyPerspective,
    handleAICreatePerspective,
    handleAIApplyStory,
    handleAISwitchScenario,
    handleAIHoverChart,
  } = useAiActions({
    map,
    layout,
    ui,
    versions,
    updateScenarioState,
    handleDatasetsInvalidated,
    handleApplyPerspective,
    captureLiveStateRef,
  });

  // Build a set of disabled extension names for fast lookup. Memoized so
  // its identity is stable across unrelated re-renders (otherwise it'd
  // invalidate the layer-construction memo below every tick).
  const disabledExtensions = useMemo(
    () => new Set(extensions.filter(e => e.state === "disabled").map(e => e.name)),
    [extensions],
  );

  // Stable refs to the latest hover/click handlers. Layers capture stable
  // dispatchers that delegate through these refs, so we don't need to
  // include the per-render handler identities in the memo deps below.
  handleLayerClickRef.current = handleLayerClick;
  handleLayerHoverRef.current = handleLayerHover;

  // Line Loading (%) legend is now auto-derived inside LegendPanel from
  // TransmissionLayer visibility so it groups with the standard color-bar
  // container. No legacy single-legend auto-show here.

  const genericDeckLayers = useMemo(() => map.state.configs
    .filter((lc) => {
      if (map.state.visibility[lc.id] === false) return false;
      // Hide layers from disabled extensions
      const ext = lc.source_extension || lc.extension_name;
      if (ext && disabledExtensions.has(ext)) return false;
      return true;
    })
    .map((lc) => {
      const dsMap = layerToDatasetsRef.current.get(lc.id);
      // Primary buffer (backward compat for single-dataset layers)
      const primaryDsId = dsMap?.get('primary') ?? null;
      const tsBuf = primaryDsId != null ? timeseriesBuffersRef.current.get(primaryDsId) ?? null : null;
      // All buffers keyed by role (for multi-dataset layers like GeneratorLayer)
      const tsBufs = {};
      if (dsMap) {
        for (const [role, dsId] of dsMap) {
          tsBufs[role] = timeseriesBuffersRef.current.get(dsId) ?? null;
        }
      }
      const hasAnyBuf = tsBuf || Object.values(tsBufs).some(Boolean);
      return createGenericLayer(
        lc,
        map.state.geo[lc.id] ?? null,
        map.state.data[lc.id] ?? null,
        map.state.localStyle[lc.id] ?? {},
        tsBuf,
        versions.state.tsVersion,
        hasAnyBuf ? clockState.frequency : 0,
        stableLayerHover,
        stableLayerClick,
        tsBufs,
        clockState.animate,
        workerPrecompute.enabled,
        scheduleTsCommit,
        gpuTimeseries.enabled,
        versions.state.staticVersion,
      );
    })
    .filter(Boolean),
    [
      map.state.configs,
      map.state.visibility,
      disabledExtensions,
      map.state.geo,
      map.state.data,
      map.state.localStyle,
      versions.state.tsVersion,
      versions.state.staticVersion,
      clockState.frequency,
      clockState.animate,
      workerPrecompute.enabled,
      gpuTimeseries.enabled,
    ]);

  // Highlight layer: renders a bright ring around the entity referenced by interactionState
  let highlightLayer = null;
  if (interactionState?.trigger === 'click' && interactionState.feature) {
    const feat = interactionState.feature;
    const coords = feat.geometry?.coordinates;
    if (coords && feat.geometry?.type === 'Point') {
      highlightLayer = createHighlightLayer(coords);
    }
  }

  const layers = [...genericDeckLayers, highlightLayer].filter(Boolean);

  // Derive current timestamp label from the first active TimeseriesBuffer.
  const currentTime = useMemo(() => {
    const buffers = timeseriesBuffersRef.current;
    for (const [, buf] of buffers) {
      const ts = buf.getTimestampAtIndex(clockState.index);
      if (ts) return ts.replace("T", " ").replace(/\.\d+Z?$/, "").replace("Z", "");
    }
    return (clockState.timestamps?.[clockState.index] ?? "").split(".")[0];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clockState.index, versions.state.tsVersion]);

  const { buildGroupedAiCharts, renderAiPanel, renderScenarioPanel } = useChartFrameRenderers({
    chartDAG, aiAnchorFor, setAiAnchor, handleChartAnchorToggle, map,
    gpuCapabilities, layout, scenarioState, clockState, updateClockState,
    currentTime, handleApplyPerspective, captureLiveStateRef,
    handleGenericLayerStyleMappingChange, extensions, handleExtensionToggle,
    updateScenarioState, openScenarioChart, closeScenarioChart,
    setScenarioChartAnchor, setScenarioChartGeom, transferScenarioChart, openScenarioCharts,
    combineScenarioCharts, splitScenarioChart, candidateTitleFor,
    inputControlRefreshKey: versions.state.inputControlRefreshKey,
  });

  // The previous scrub path here POSTed /api/datasets/rows for one row per
  // visible dataset on every clock tick. It piled up requests during rapid
  // scrubbing AND raced with the partition-loading effect above (in-flight
  // single-row responses landed AFTER the user moved on, overwriting the
  // newer in-memory frame). Removed in favor of the partition path: load
  // the Arrow batch once per day, scrub instantly within it, and let the
  // cancellation flag in the partition effect drop stale loads.

  // ── Tray panel open/close state ──────────────────────────────────────────
  // listItemOpen, trayTop, mapLegend, previewSource, activePerspective,
  // activeStory, chatPendingMessage now live in `layout`.
  // chatOpen, legendCollapsed, colorPanelOpen, quickStyleOpen, giveControlOpen
  // now live in `ui`.
  const legendPosRef = useRef({ x: 0, y: 0 }); // tracks current drag offset
  const legendSavedPosRef = useRef({ x: 0, y: 0 }); // saved position before collapse
  const legendNodeRef = useRef(null);

  // 'story' sync channel + peer-join rebroadcast live in BusSyncHost.

  // Auto-open / close the story playback panel as a singleton. When a
  // story is selected we ensure the panel is mounted (via its default
  // anchor); when the story is cleared we close it. Users are free to
  // re-anchor or pop it out in the meantime — we only touch presence,
  // not placement.
  useEffect(() => {
    if (layout.state.activeStory) {
      openPanel('story-playback');
    } else {
      setOpenScenarioCharts((prev) => prev.filter(
        (e) => !(e.kind === 'panel' && e.panelId === 'story-playback')
      ));
    }
  }, [layout.state.activeStory, openPanel, setOpenScenarioCharts]);

  // True while Atlas's full drawer covers the bottom-right corner, so the
  // chat FAB hides instead of overlapping the composer's send button.
  const [chatDrawerExpanded, setChatDrawerExpanded] = useState(false);
  // Occupied width of the right-side ChartTray (0 when absent), reported by
  // ChartTray. Lets the chat bubble + FAB dock to the LEFT of the tray.
  const [trayWidth, setTrayWidth] = useState(0);

  // Suggested prompts authored on the active story step, surfaced as
  // tap-to-send chips in the Atlas chat.
  const activeStoryPrompts = useActiveStoryPrompts(
    layout.state.activeStory,
    layout.state.activePerspective,
  );

  function handleListItemClick(key, event) {
    const keyMap = { 0: 'layers', 1: 'data', 2: 'animation' };
    const resolved = keyMap[key] ?? key;
    // Toggle: if already open, close all trays.
    if (layout.state.listItemOpen[resolved]) {
      layout.setListItemOpen({ layers: false, data: false, inputControls: false, animation: false, display: false, extensions: false, agentIntegration: false, developer: false });
      return;
    }
    // Always anchor trays near the top of the drawer (first list item
    // position). If the drawer first-item query misses, fall back to a
    // small fixed offset rather than the clicked button's own position
    // — otherwise opening a settings section (last items) would anchor the
    // tray near the bottom of the drawer and leave no room for the panel.
    const firstItem = document.querySelector('.gridsight-drawer-first-item');
    if (firstItem) {
      layout.setTrayTop(firstItem.getBoundingClientRect().top);
    } else {
      layout.setTrayTop(64);
    }
    const next = { layers: false, data: false, inputControls: false, animation: false, display: false, extensions: false, agentIntegration: false, developer: false };
    next[resolved] = true;
    layout.setListItemOpen(next);
  }

  const listIcons = [
    <LayersIcon />,
    <FolderOpenIcon />,
    <AccessTimeIcon />,
  ];
  // ── Draggable clock position + size ──────────────────────────────────────
  // clockPosition, clockFontSize, clockColor now live in `clockUi`.

  const handleDragStop = (event) => {
    ui.setDeckControl(true);
    clockUi.setPosition({ x: event.layerX, y: event.layerY });
  };

  // Pointer-captured resize handle for the clock overlay.
  // Drag away from clock center (down-right) = bigger, towards center = smaller.
  function onClockResizePointerDown(e) {
    e.stopPropagation();
    e.target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = clockUi.state.fontSize;
    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Use the dominant axis, average both for diagonal drags
      const delta = (dx + dy) * 0.5;
      clockUi.setFontSize(Math.max(12, Math.min(72, startSize + delta * 0.2)));
    }
    function onUp(ev) {
      e.target.releasePointerCapture(ev.pointerId);
      e.target.removeEventListener("pointermove", onMove);
      e.target.removeEventListener("pointerup", onUp);
    }
    e.target.addEventListener("pointermove", onMove);
    e.target.addEventListener("pointerup", onUp);
  }

  // ── Viewport / hi-DPI ────────────────────────────────────────────────────
  const [viewState, setViewState] = useState({
    latitude: 39.0,
    longitude: -104.0,
    zoom: 5,
    width: 1920,
    height: 1080,
  });

  useEffect(() => {
    const adjustViewportforHiDPI = () => {
      const newWidth = window.innerWidth;
      const newHeight = window.innerHeight;
      console.log("screen resize detected", [newWidth, newHeight]);
      setViewState((vs) => ({ ...vs, width: newWidth, height: newHeight }));
    };
    adjustViewportforHiDPI();
    window.addEventListener("resize", adjustViewportforHiDPI);
    return () => window.removeEventListener("resize", adjustViewportforHiDPI);
  }, []);

  // Re-apply the vertical-fill minZoom whenever the viewport size or the
  // display scale changes. Changing `displayScale` (CSS body zoom) alters the
  // map container's effective height but does NOT always fire MapLibre's own
  // 'resize' event, so the minZoom computed at load goes stale and lets the
  // camera zoom out past the point where the world fills the screen (the
  // pole-lock). This effect keeps minZoom in lockstep with the real size.
  useEffect(() => {
    const m = mapRef.current?.getMap?.();
    if (m) {
      const mz = applyVerticalFillMinZoom(m);
      const pr = applyRenderPixelRatio(m, displayScale);
      logViewport('reapply', {
        minZoom: mz,
        pixelRatio: pr,
        displayScale,
        containerH: m.getContainer?.()?.clientHeight,
        winH: typeof window !== 'undefined' ? window.innerHeight : null,
      });
    }
  }, [displayScale, viewState.width, viewState.height]);

  // ── Bind perspective capture + apply refs (after all state is in scope)
  // Plain assignment outside an effect — this runs every render so the
  // refs always see the latest state without waiting for an effect tick.
  captureLiveStateRef.current = async () => {
    // The MapView is uncontrolled (initialViewState only) so React's
    // `viewState` is the initial default and doesn't reflect user pan/
    // zoom. Read the LIVE viewport from the map handle when available;
    // fall back to React state on the rare case the map isn't mounted.
    let liveView = viewState;
    try {
      const m = mapRef?.current?.getMap?.();
      if (m) {
        const c = m.getCenter();
        liveView = {
          ...viewState,
          latitude: c.lat,
          longitude: c.lng,
          zoom: m.getZoom(),
          bearing: m.getBearing(),
          pitch: m.getPitch(),
        };
      }
    } catch { /* fall back to React state */ }
    // Snapshot the focused extension's input-control values (e.g. Sector =
    // Data Center) so the chapter restores them on apply. The focused
    // extension owns the current project.
    let controls = null;
    try {
      const extName = extensions.find(
        (e) => (e.projects || []).includes(scenarioState.project),
      )?.name;
      if (extName && scenarioState.project && scenarioState.scenario) {
        const list = await fetchInputControls(
          extName, scenarioState.project, scenarioState.scenario,
        );
        const arr = Array.isArray(list) ? list : (list?.data ?? list?.controls ?? []);
        const values = {};
        for (const c of arr) {
          if (c?.name != null) values[c.name] = c.current_value;
        }
        controls = {
          extName, project: scenarioState.project,
          scenario: scenarioState.scenario, values,
        };
      }
    } catch (e) {
      console.warn('[capture] input-control capture failed:', e);
    }
    return captureViewState({
      viewState: liveView,
      baseLayer: BaseLayer,
      scenarioState,
      genericLayerVisibility: map.state.visibility,
      genericLayerLocalStyle: map.state.localStyle,
      clockState,
      openScenarioCharts,
      aiAnchorModes,
      sidebarMode: ui.state.sidebarMode,
      expandedExt: ui.state.expandedExt,
      extensions,
      controls,
    });
  };
  // ── MCP control channel ───────────────────────────────────────────────────
  // External agent (Claude Desktop via the MCP server) drives perspective/story
  // apply + "save current view". Kept off the 'story' sync channel so it can't
  // clobber cross-tab story state. Reads captureLiveStateRef lazily at event
  // time, so an empty dep array is correct.
  // Re-read extensions and rebuild the layer set from the new preferences.
  // Shared by the Settings toggle and the assistant's set_extension_state:
  // the preference is stored server-side but inert until the app reloads
  // both, so an agent enabling an extension without this would change a row
  // in the database and nothing on screen.
  const refreshExtensionsAndLayers = useCallback(async () => {
    try {
      const updatedExts = await fetchExtensions();
      setExtensions(updatedExts);
      // Collapse the open sub-tray if its extension just went away. Leaving it
      // expanded shows the panels of an extension whose data is no longer
      // loaded — controls that drive nothing and charts that cannot resolve.
      const stillUsable = new Set(
        updatedExts.filter((e) => e.state !== 'disabled' && e.state !== 'hidden')
          .map((e) => e.name),
      );
      // Read through a ref: setExpandedExt takes a value, not an updater, and
      // this callback is a bus-subscription dependency, so closing over the
      // state directly would either go stale or churn the subscription.
      const openExt = expandedExtRef.current;
      if (openExt && !stillUsable.has(openExt)) ui.setExpandedExt(null);
      const allLayers = await fetchAllLayers();
      await bootstrapLayers(filterLayersByExtensions(allLayers, updatedExts), { replace: true });
    } catch (e) {
      console.warn('[App] refreshExtensionsAndLayers:', e);
    }
  }, [bootstrapLayers, filterLayersByExtensions]);

  useEffect(() => {
    return bus.subscribe('mcp', async (payload) => {
      if (!payload) return;
      try {
        if (payload.type === 'apply-perspective' && payload.perspectiveId != null) {
          handleApplyPerspective(payload.perspectiveId);
        } else if (payload.type === 'apply-story' && payload.storyId != null) {
          layout.setActiveStory(payload.storyId);
        } else if (payload.type === 'set-basemap-detail' && Array.isArray(payload.hidden)) {
          // Declarative: the payload IS the hidden set, so the assistant does
          // not have to know the current state to reach a target one.
          const next = new Set(payload.hidden);
          setHiddenBasemapCategories(next);
          saveHiddenCategories(next);
        } else if (payload.type === 'extensions-changed') {
          await refreshExtensionsAndLayers();
        } else if (payload.type === 'reload-layers') {
          // A layer was created server-side (e.g. via MCP create_point_layer).
          // Re-fetch and merge so it appears live without a scenario reload.
          // User layers (no extension) always pass the filter; merge mode only
          // adds layers not already present, so stale `extensions` is harmless.
          const all = await fetchAllLayers();
          await bootstrapLayers(filterLayersByExtensions(all, extensions), {});
        } else if (payload.type === 'remove-layer' && payload.layerId != null) {
          // A layer was deleted server-side (e.g. via MCP remove_layer). Drop it
          // from the live map state (configs, visibility, localStyle, geo, data).
          map.removeLayer(Number(payload.layerId));
        } else if (payload.type === 'set-layer-visibility' && payload.layerId != null) {
          // Merge-safe single-layer visibility toggle from MCP or the chat.
          // Uses the targeted setter (NOT the layers:visibility sync channel,
          // which REPLACES the whole map and would hide every other layer).
          handleAILayerVisibilityChanged(Number(payload.layerId), !!payload.visible);
        } else if (payload.type === 'set-layer-style' && payload.layerId != null && payload.mapping) {
          // Merge-safe single style-mapping upsert from MCP or the chat
          // (updates or appends into the layer's style_mappings; no full-map replace).
          handleAILayerStyleChanged(Number(payload.layerId), payload.mapping);
        } else if (payload.type === 'set-layer-geo-mapping'
                   && payload.layerId != null && (payload.mapping || payload.style)) {
          // Geometry-property styling (geoMapping) and/or generic sizing knobs
          // (units/scale/pixel clamps) from the chat's style_layer tool — merges
          // into the layer's localStyle so an uploaded layer can be styled by a
          // feature property (e.g. planning_stage, planned_mw) live.
          handleAILayerGeoMappingChanged(
            Number(payload.layerId), payload.visualProperty, payload.mapping, payload.style,
          );
        } else if (payload.type === 'popout-legend' && payload.layerId != null) {
          // Auto-show the prominent interactive legend for a categorical layer
          // (fired by MCP create_point_layer when category_column is set),
          // mirroring the manual "pop out legend" action so the user doesn't
          // have to open it from the layer's Mappings.
          const all = await fetchAllLayers();
          const lc = all.find((l) => l.id === Number(payload.layerId));
          const gf = lc?.default_style?.geoMappings?.getFillColor;
          if (gf?.scale_type === 'categorical') {
            layout.setMapLegend({
              layerId: lc.id,
              filterProperty: gf.property,
              label: gf.label ?? gf.property,
              categoryColors: gf.categoryColors ?? {},
              categories: Object.keys(gf.categoryColors ?? {}),
            });
            ui.setLegendCollapsed(false);
          }
        } else if (payload.type === 'set-basemap' && payload.basemap) {
          // Agent/MCP-driven base-layer switch (e.g. "enhance" → satellite).
          // basemapById falls back to the default for an unknown id, so the
          // resolved .id is always valid.
          updateBaseLayer(basemapById(payload.basemap).id);
        } else if (payload.type === 'capture-perspective') {
          const capture = captureLiveStateRef.current;
          const blob = capture ? await capture() : null;
          if (!blob) return;
          const { id: perspectiveId } = await createPerspective({
            name: payload.name || 'Saved view',
            description: payload.description || '',
            config: blob,
          });
          if (payload.storyName && perspectiveId != null) {
            const { id: storyId } = await createStory({
              name: payload.storyName,
              description: payload.description || '',
            });
            if (storyId != null) {
              await addStoryStep(storyId, {
                perspective_id: perspectiveId,
                narration: payload.description || '',
              });
            }
          }
        }
      } catch (e) {
        console.warn('[App] mcp channel error:', e);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Extension on/off handler shared between the sidebar icon and the
  // registered ExtensionsPanel (inline or popped-out). Persists via
  // setExtensionPreference and re-bootstraps layers filtered by the
  // updated enabled set — identical side effects to the inline path.
  async function handleExtensionToggle(extName, newState) {
    try {
      await setExtensionPreference(extName, newState);
      const updated = extensions.map(
        (x) => x.name === extName ? { ...x, state: newState } : x
      );
      setExtensions(updated);
      const all = await fetchAllLayers();
      await bootstrapLayers(filterLayersByExtensions(all, updated), { replace: true });
    } catch (err) {
      console.error('[App] handleExtensionToggle failed:', err);
    }
  }

  applyDispatchersRef.current = {
    setViewState,
    setBaseLayer: updateBaseLayer,
    updateScenarioState,
    // When a perspective is applied, the chapter is the AUTHORITY for
    // which layers are visible. Layers absent from the chapter's
    // visibility map should be hidden, even if they were on locally.
    // Expand the desired map across every known layer id; anything not
    // explicitly true becomes false.
    setGenericLayerVisibility: (desired) => {
      const next = {};
      for (const lc of map.state.configs) {
        next[lc.id] = desired?.[lc.id] === true;
      }
      // Also preserve any explicit-false entries in the desired map for
      // layers we don't know about yet (loaded after the chapter saved).
      for (const [id, v] of Object.entries(desired || {})) {
        if (!(id in next)) next[id] = v === true;
      }
      map.replaceVisibilityMap(next);
    },
    setGenericLayerLocalStyle: map.replaceLocalStyleMap,
    updateClockState,
    setOpenScenarioCharts,
    setAiAnchorModes,
    setSidebarMode: ui.setSidebarMode,
    setExpandedExt: ui.setExpandedExt,
    mapRef,
    applyExtensionStates: async (enabledNames) => {
      // Diff the desired enabled-set against current state. Toggle only
      // those that need to change, then re-bootstrap layers once.
      const want = new Set(enabledNames || []);
      const changes = extensions
        .filter((e) => e?.state != null)
        .map((e) => ({
          ext: e,
          target: want.has(e.name) ? 'enabled' : 'disabled',
        }))
        .filter(({ ext, target }) => ext.state !== target);
      if (changes.length === 0) return;
      const updated = extensions.map((e) => {
        const c = changes.find((x) => x.ext.name === e.name);
        return c ? { ...e, state: c.target } : e;
      });
      // Apply the target enabled-set to local state SYNCHRONOUSLY, before the
      // preference PATCHes below. applyViewState calls this and then
      // updateScenarioState in the same tick; React batches both, so the
      // scenario-change layer bootstrap runs with the chapter's extension set
      // already applied. Without this, that bootstrap saw the stale
      // (pre-chapter) set and eagerly loaded a to-be-disabled extension's
      // geometries + partitions (e.g. all of GAT/Grid) before the toggle
      // took effect.
      setExtensions(updated);
      try {
        await Promise.all(changes.map(
          ({ ext, target }) => setExtensionPreference(ext.name, target)
        ));
        const allLayers = await fetchAllLayers();
        await bootstrapLayers(filterLayersByExtensions(allLayers, updated), { replace: true });
      } catch (err) {
        console.error('[App] applyExtensionStates failed:', err);
      }
    },
    // Restore a chapter's captured input-control values by POSTing each back
    // to the extension, then refresh the panels/charts/datasets that depend
    // on them (mirrors what an interactive control change would do).
    applyInputControls: async (controls) => {
      const { extName, project, scenario, values } = controls || {};
      if (!extName || !values) return;
      try {
        let invalidated = [];
        for (const [name, value] of Object.entries(values)) {
          const res = await setInputControl(extName, project, scenario, name, value);
          const ds = res?.invalidated_datasets;
          if (Array.isArray(ds)) invalidated = invalidated.concat(ds);
        }
        if (invalidated.length) handleDatasetsInvalidated(extName, invalidated);
        versions.bumpInputControl();
      } catch (e) {
        console.warn('[App] applyInputControls failed:', e);
      }
    },
  };

  // ── Render ────────────────────────────────────────────────────────────────
  // The `?view=chartTray` path used to live here as an early-return branch
  // that still paid the cost of initializing the full App (deck.gl, layer
  // state, extension discovery). It now routes to a separate lightweight
  // root (ChartTrayApp) at the main.jsx entry.
  //
  // TODO(shell-decomp): The Drawer + sidebar accordion + Tray container
  // ("LayoutShell") and the MapView + DeckGLOverlay + interaction
  // ("MapShell") still live inline here. LayoutShell would require ~30
  // props to keep the same surface area without state migration; the
  // boundary needs rethinking before extracting (e.g. lift the inline
  // extension-toggle handler out so the drawer doesn't need setExtensions
  // / bootstrapLayers / filterLayersByExtensions, then revisit). MapShell
  // is the most coupled (deck.gl overlay + clock-driven re-renders +
  // interaction state) and was intentionally skipped in this pass.

  const sessionColor = bus.getSessionColor();

  return (
    <Box sx={{
      display: "flex",
      ...(sessionBorderFlash && sessionColor ? {
        outline: `3px solid ${sessionColor}`,
        outlineOffset: -3,
        transition: 'outline 0.3s ease',
      } : {}),
    }}>
      <Box
        sx={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 99999,
          pointerEvents: 'none',
          color: '#ff0000',
          fontSize: '12vw',
          fontWeight: 900,
          letterSpacing: '0.05em',
          textShadow: '0 0 20px rgba(0,0,0,0.6)',
          userSelect: 'none',
        }}
      >
        TEST
      </Box>
      <BusSyncHost
        map={map}
        layout={layout}
        versions={versions}
        scenarioState={scenarioState}
        updateScenarioState={updateScenarioState}
        extensions={extensions}
        interactionState={interactionState}
        setInteractionState={setInteractionState}
        chartDAG={chartDAG}
        setAiAnchor={setAiAnchor}
        broadcastClockAnchor={broadcastClockAnchor}
        handlers={{
          onExtensionToggle: handleExtensionToggle,
          onApplyPerspective: handleApplyPerspective,
          onDatasetsInvalidated: handleDatasetsInvalidated,
        }}
        refs={{
          mapRef,
          mapInteractingRef,
          syncFlyingRef,
          handleLayerClickRef,
        }}
      />
      <MapView
        ref={mapRef}
        initialViewState={{
          latitude: viewState.latitude,
          longitude: viewState.longitude,
          zoom: viewState.zoom,
        }}
        // The map container must be sized in *logical* (pre-zoom) pixels:
        // DisplayScaleProvider applies `body { zoom: displayScale }`, so a
        // container styled at the full device width/height would render
        // displayScale× too large and overflow the screen — you'd only see
        // the top-left corner, and the camera would lock to the pole when
        // zoomed out (the world fills the oversized canvas, not your screen).
        // Dividing by displayScale makes the rendered canvas match the
        // visible viewport exactly. No-op when displayScale === 1.
        style={{ width: viewState.width / displayScale, height: viewState.height / displayScale }}
        mapStyle={basemapById(BaseLayer).style}
        maxCanvasSize={[maxCanvasSize.width, maxCanvasSize.height]}
        onLoad={handleMapLoad}
        onMoveStart={handleMapMoveStart}
        onMove={handleMapMove}
        onMoveEnd={handleMapMoveEnd}
      >
        {/* ── Side Drawer (hidden in display-only mode) ──────────────── */}
        {!isDisplay && <Drawer
          onMouseEnter={() => ui.setDrawerHovered(true)}
          onMouseLeave={() => ui.setDrawerHovered(false)}
          sx={{
            width: currentDrawerWidth,
            flexShrink: 0,
            "& .MuiDrawer-paper": {
              width: currentDrawerWidth,
              boxSizing: "border-box",
              opacity: (ui.state.drawerHovered || showLabels || Object.values(layout.state.listItemOpen).some(Boolean)) ? 1 : 0.08,
              transition: (t) => [
                t.transitions.create("width", {
                  easing: t.transitions.easing.easeOut,
                  duration: t.transitions.duration.enteringScreen,
                }),
                "opacity 0.25s ease",
              ].join(", "),
              overflowX: "hidden",
            },
          }}
          variant="permanent"
          anchor="left"
        >
          <DrawerHeader>
            <IconButton onClick={handleDrawerToggle}>
              {showLabels ? <ChevronLeftIcon /> : <ChevronRightIcon />}
            </IconButton>
          </DrawerHeader>
          {showLabels && (
            <SidebarHeader
              activeStory={layout.state.activeStory}
              activePerspective={layout.state.activePerspective}
              onActiveStoryChange={layout.setActiveStory}
              onApplyChapter={handleApplyPerspective}
              onCapture={() => captureLiveStateRef.current?.()}
              onGiveControlOpen={() => ui.setGiveControlOpen(true)}
            />
          )}
          <Divider />
          {showLabels && (
            <Typography variant="overline" color="text.secondary" sx={{ px: 2, pt: 1, display: "block", lineHeight: 1.5 }}>
              Map
            </Typography>
          )}
          <List>
            {["Layers", "Data Catalog", "Timeline"].map((text, idx) => (
              <ListItem key={text} disablePadding className={idx === 0 ? 'gridsight-drawer-first-item' : undefined}>
                <ListItemButton onClick={(e) => handleListItemClick(idx, e)}>
                  <ListItemIcon sx={{ minWidth: showLabels ? 56 : 'auto' }}>{listIcons[idx]}</ListItemIcon>
                  {showLabels && <ListItemText primary={text} />}
                </ListItemButton>
              </ListItem>
            ))}
          </List>
          <ExtensionsSection
            extensions={extensions}
            showLabels={showLabels}
            expandedExt={ui.state.expandedExt}
            setExpandedExt={ui.setExpandedExt}
            scenarioState={scenarioState}
            updateScenarioState={updateScenarioState}
            extDialogs={extDialogs}
            scenarioChartSpecs={scenarioChartSpecs}
            setChartsMenu={ui.setChartsMenu}
            onToggleExtension={handleExtensionToggle}
            onOpenInputControls={(e) => handleListItemClick('inputControls', e)}
          />
          <SidebarToolsList
            showLabels={showLabels}
            colorPanelOpen={ui.state.colorPanelOpen}
            onColorPaletteClick={() => {
              ui.setColorPanelOpen(!ui.state.colorPanelOpen);
              // Close tray panels when opening color palette
              layout.setListItemOpen({ layers: false, data: false, inputControls: false, animation: false, display: false, extensions: false, agentIntegration: false, developer: false });
            }}
            openKey={Object.entries(layout.state.listItemOpen).find(([, v]) => v)?.[0] ?? null}
            onSettingsSectionClick={handleListItemClick}
          />
        </Drawer>}

        {/* ── Main canvas area ─────────────────────────────────────────── */}
        <Main open={open} drawerWidth={currentDrawerWidth}>
          <DeckGLOverlay
            layers={layers}
            interleaved
            showStats={stats.show}
            useDevicePixelRatio={forceDpr1.enabled ? 1 : undefined}
          />

          <Suspense fallback={null}>
            <EntityInteractionManager
              interactionState={interactionState}
              onDismiss={() => setInteractionState(null)}
              genericLayerConfigs={map.state.configs}
              genericLayerLocalStyle={map.state.localStyle}
              genericLayerData={map.state.data}
              timeseriesBuffersRef={timeseriesBuffersRef}
              layerToDatasetsRef={layerToDatasetsRef}
              clockState={clockState}
              updateClockState={updateClockState}
              scenarioState={scenarioState}
              onPopOutChart={openEntityChart}
              onPopOutBuiltinTimeseries={openBuiltinTimeseries}
              webgpu={gpuCapabilities.webgpu}
              inputControlRefreshKey={versions.state.inputControlRefreshKey}
              onInputControlInvalidated={handleDatasetsInvalidated}
            />
          </Suspense>

          {Object.values(layout.state.listItemOpen).some(Boolean) && (
              <Box
                sx={{
                  maxWidth: DRAWER_FULL * 3.5,
                  // Divide both terms by displayScale so the rendered
                  // (post-zoom) height fits within the actual viewport.
                  // With scale=1 this collapses to the original
                  // `calc(100vh - trayTop)`.
                  maxHeight: `calc(${100 / displayScale}vh - ${
                    layout.state.trayTop / displayScale
                  }px)`,
                  overflowY: "auto",
                  position: "fixed",
                  // `left` is NOT divided by displayScale — the Drawer paper
                  // also lives under the body zoom, so its actual right edge
                  // is at `currentDrawerWidth × scale` real pixels. Setting
                  // CSS left = currentDrawerWidth (un-divided) lands the
                  // tray's left edge at the same real-pixel position.
                  // `top` is divided so the tray's actual top edge sits at
                  // `trayTop` real pixels (otherwise it'd be `trayTop ×
                  // scale`); maxHeight does the same so the bottom of the
                  // tray reaches exactly the viewport bottom.
                  left: currentDrawerWidth,
                  top: layout.state.trayTop / displayScale,
                  zIndex: 1100,
                }}
              >
                <Tray
                  trayFlags={layout.state.listItemOpen}
                  onInspectData={layout.setPreviewSource}
                  userState="test"
                  gpu={gpu}
                  stats={stats}
                  forceDpr1={forceDpr1}
                  maxCanvasSize={maxCanvasSize}
                  workerPrecompute={workerPrecompute}
                  gpuTimeseries={gpuTimeseries}
                  baseLayerProp={BaseLayer}
                  onBaseLayerChange={(val) => updateBaseLayer(val)}
                  hiddenBasemapCategories={hiddenBasemapCategories}
                  onToggleBasemapCategory={toggleBasemapCategory}
                  scenarioProp={scenarioState}
                  clockState={clockState}
                  onClockChange={updateClockState}
                  clockColor={clockUi.state.color}
                  onClockColorChange={clockUi.setColor}
                  currentTimeLabel={currentTime}
                  genericLayers={map.state.configs.filter(lc => {
                    const ext = lc.source_extension || lc.extension_name;
                    return !ext || !disabledExtensions.has(ext);
                  })}
                  genericLayerVisibility={map.state.visibility}
                  onGenericLayerVisibilityChange={handleGenericLayerVisibilityChange}
                  onGenericLayerAdded={handleGenericLayerAdded}
                  genericLayerLocalStyle={map.state.localStyle}
                  onGenericLayerLocalStyleChange={handleGenericLayerLocalStyleChange}
                  onGenericLayerStyleMappingChange={handleGenericLayerStyleMappingChange}
                  onGenericLayerDeleted={handleGenericLayerDeleted}
                  genericLayerGeo={map.state.geo}
                  genericLayerData={map.state.data}
                  extensions={extensions}
                  activeExtName={ui.state.expandedExt}
                  onDatasetsInvalidated={handleDatasetsInvalidated}
                  onLayerActions={handleLayerActions}
                  inputControlRefreshKey={versions.state.inputControlRefreshKey}
                  onExtensionPrefChanged={refreshExtensionsAndLayers}
                  onAskAI={(prompt) => {
                    layout.setChatPendingMessage(prompt);
                    ui.setChatOpen(true);
                  }}
                  onPopoutLegend={(legend) => {
                    layout.setMapLegend(legend);
                    ui.setLegendCollapsed(false);
                    legendPosRef.current = { x: 0, y: 0 };
                    legendSavedPosRef.current = { x: 0, y: 0 };
                    const node = legendNodeRef.current;
                    if (node) node.style.transform = 'translate(0px, 0px)';
                  }}
                  onQuickStyleOpen={() => ui.setQuickStyleOpen(true)}
                  anchoredLayers={map.state.anchoredLayers}
                  onAnchorToggle={handleAnchorToggle}
                />
              </Box>
          )}
        </Main>

        {/* ── Draggable + resizable clock overlay ─────────────────────── */}
        <ClockOverlay
          show={clockState.showClock}
          position={clockUi.state.position}
          fontSize={clockUi.state.fontSize}
          color={clockUi.state.color}
          displayText={currentTime}
          onDragStart={() => ui.setDeckControl(false)}
          onDragStop={handleDragStop}
          onResizePointerDown={onClockResizePointerDown}
        />
        {/* Data-provider attribution. The control aggregates each active
            style's source `attribution` (Carto + OpenStreetMap for the vector
            basemaps; Esri/Maxar for satellite) and re-reads it on every style
            swap, so the correct credit shows per basemap. MapLibre added
            explicitly as a courtesy (the library itself doesn't require it). */}
        <AttributionControl
          position="bottom-right"
          customAttribution='<a href="https://maplibre.org/" target="_blank" rel="noopener noreferrer">MapLibre</a>'
        />
      </MapView>
      <ViewportDebugHUD mapRef={mapRef} />
      {!isDisplay && <ChatPanel open={ui.state.chatOpen} onClose={() => ui.setChatOpen(false)} chartDAG={chartDAG} webgpu={gpuCapabilities.webgpu} onInputControlChanged={handleAIInputControlChanged} onLayerStyleChanged={handleAILayerStyleChanged} onLayerVisibilityChanged={handleAILayerVisibilityChanged} onCrossLayerConfig={handleAICrossLayerConfig} onApplyPerspective={handleAIApplyPerspective} onCreatePerspective={handleAICreatePerspective} onApplyStory={handleAIApplyStory} onSwitchScenario={handleAISwitchScenario} onHoverChart={handleAIHoverChart} anchoredLayers={map.state.anchoredLayers} anchoredCharts={map.state.anchoredCharts} activeExtensions={ui.state.expandedExt ? [ui.state.expandedExt] : extensions.filter(e => e.state !== "disabled").map(e => e.name)} pendingMessage={layout.state.chatPendingMessage} onPendingMessageConsumed={() => layout.setChatPendingMessage(null)} suggestedPrompts={activeStoryPrompts} activeStoryId={layout.state.activeStory} activePerspectiveId={layout.state.activePerspective} visibleLayerIds={Object.entries(map.state.visibility).filter(([, v]) => v).map(([k]) => Number(k))} onExpandedChange={setChatDrawerExpanded} trayInset={trayWidth} />}
      {layout.state.previewSource && <DataPreviewPanel source={layout.state.previewSource} onClose={() => layout.setPreviewSource(null)} />}
      <DialogsHost
        extDialogs={extDialogs}
        ui={ui}
        scenarioState={scenarioState}
        currentDrawerWidth={currentDrawerWidth}
        mapConfigs={map.state.configs}
        mapVisibility={map.state.visibility}
        mapLocalStyle={map.state.localStyle}
        onColorPanelClose={() => ui.setColorPanelOpen(false)}
        onColorPanelAskAI={(prompt) => {
          layout.setChatPendingMessage(prompt);
          ui.setChatOpen(true);
        }}
        onCreateScenarioCreated={async (result) => {
          // Refresh extensions so new project/scenario appears
          try {
            const exts = await fetchExtensions();
            setExtensions(exts);
            if (result.project_name && result.scenario_name) {
              updateScenarioState({ project: result.project_name, scenario: result.scenario_name });
            }
            const allLayers = await fetchAllLayers();
            await bootstrapLayers(filterLayersByExtensions(allLayers, exts), { replace: true });
          } catch (e) {
            console.error("[App] post-create refresh error:", e);
          }
        }}
        onBusGeoCreated={async () => {
          // Geometry doesn't change scenario membership, but layers/charts
          // may need a refresh once we hook the sidecars in. Best-effort.
          try {
            const allLayers = await fetchAllLayers();
            await bootstrapLayers(filterLayersByExtensions(allLayers, extensions), { replace: true });
          } catch (e) {
            console.error("[App] post-bus-geo refresh error:", e);
          }
        }}
        onQuickStyleVisibilityChange={handleGenericLayerVisibilityChange}
        onQuickStyleLocalStyleChange={handleGenericLayerLocalStyleChange}
        onQuickStyleMappingChange={handleGenericLayerStyleMappingChange}
        onSyncSettingsClose={() => ui.setSyncSettingsOpen(false)}
        onGiveControlClose={() => ui.setGiveControlOpen(false)}
        // GAT category overrides invalidate chart specs (and the
        // override-aware view). Bumping inputControlRefreshKey alone is
        // not enough — the per-extension chart spec list lives in
        // useExtensionsCatalog's local state, which is captured ONCE
        // on load and serves ChartsMenu directly. Without an explicit
        // refresh, re-opening the System Generation Stack chart
        // re-uses the original spec object (and its original colours).
        onDisplayGroupsInvalidated={() => {
          versions.bumpInputControl();
          refreshScenarioCharts('gat');
        }}
      />
      <LegendPanel
        layerConfigs={map.state.configs}
        visibility={map.state.visibility}
        localStyles={map.state.localStyle}
        bottomOffset={legendBottomOffset}
        onFilterChange={(layerId, filterProperty, { enabledCategories, hoverCategory }) => {
          if (!enabledCategories && !hoverCategory) {
            const ls = map.state.localStyle[layerId] ?? {};
            map.setLayerStyle(layerId, { ...ls, filterEnabled: false, filterProperty: null, filterCategories: [] });
          } else {
            const ls = map.state.localStyle[layerId] ?? {};
            map.setLayerStyle(layerId, {
              ...ls,
              filterEnabled: true,
              filterProperty,
              filterCategories: enabledCategories ? [...enabledCategories] : [],
              hoverCategory: hoverCategory ?? null,
            });
          }
        }}
      />

      <LegacyLegend
        mapLegend={layout.state.mapLegend}
        legendCollapsed={ui.state.legendCollapsed}
        legendBottomOffset={legendBottomOffset}
        legendNodeRef={legendNodeRef}
        legendPosRef={legendPosRef}
        legendSavedPosRef={legendSavedPosRef}
        mapConfigs={map.state.configs}
        mapLocalStyle={map.state.localStyle}
        setLayerStyle={map.setLayerStyle}
        setMapLegend={layout.setMapLegend}
        setLegendCollapsed={ui.setLegendCollapsed}
      />
      <FloatingActionButtons
        isDisplay={isDisplay}
        sessionColor={sessionColor}
        syncSettingsOpen={ui.state.syncSettingsOpen}
        chatOpen={ui.state.chatOpen}
        chatExpanded={chatDrawerExpanded}
        chatRightInset={trayWidth}
        onSyncSettingsToggle={() => ui.setSyncSettingsOpen(!ui.state.syncSettingsOpen)}
        onChatToggle={() => ui.setChatOpen(!ui.state.chatOpen)}
      />
      {/* Floating + docked AI chart frames are rendered alongside
          scenario charts via ChartDocks. Only tray-mode frames flow
          into the bottom ChartTray. */}
      {(() => {
        const groupedAiCharts = buildGroupedAiCharts();
        return (
          <>
            <ChartTrayContainer
              trayPoppedOut={layout.state.trayPoppedOut}
              chatExpanded={chatDrawerExpanded}
              webgpu={gpuCapabilities.webgpu}
              trayScenarioFrames={groupedScenarioCharts.tray.map(renderScenarioPanel)}
              trayAiFrames={groupedAiCharts.tray.map(renderAiPanel)}
              openScenarioCharts={openScenarioCharts}
              onAddPanel={(panelId) => openPanel(panelId, { anchorMode: 'tray' })}
              onTrayWidthChange={setTrayWidth}
            />
            <ChartsMenu
              chartsMenu={ui.state.chartsMenu}
              onClose={() => ui.setChartsMenu(null)}
              scenarioChartSpecs={scenarioChartSpecs}
              scenarioState={scenarioState}
              onOpenScenarioChart={openScenarioChart}
            />
            <ChartDocks
              floating={[
                ...groupedScenarioCharts.floating.map(renderScenarioPanel),
                ...groupedAiCharts.floating.map(renderAiPanel),
              ]}
              sideLeft={[
                ...groupedScenarioCharts['side-left'].map(renderScenarioPanel),
                ...groupedAiCharts['side-left'].map(renderAiPanel),
              ]}
              sideRight={[
                ...groupedScenarioCharts['side-right'].map(renderScenarioPanel),
                ...groupedAiCharts['side-right'].map(renderAiPanel),
              ]}
              bottom={[
                ...groupedScenarioCharts.bottom.map(renderScenarioPanel),
                ...groupedAiCharts.bottom.map(renderAiPanel),
              ]}
              onBottomSizeChange={setBottomDockSize}
            />
          </>
        );
      })()}
    </Box>
  );
}
