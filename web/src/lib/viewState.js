/**
 * viewState.js
 *
 * Capture and apply the live UI view state as a JSON-serializable blob.
 * Used by the perspective + story system to record "what the user is
 * seeing right now" and replay it later.
 *
 * Pure functions (no React); App.jsx supplies the live values to capture
 * and the setter functions to dispatch on apply. Schema is versioned
 * (`VIEW_STATE_VERSION`) so old snapshots can be migrated forward as the
 * shape evolves.
 *
 * v1 captures: map viewport, basemap, scenario, per-layer visibility +
 * local style, clock, open chart frames (scenario + builtin-ts), AI
 * chart anchor modes, sidebar mode, expanded extension. Things that are
 * intentionally out of scope: chart-tray internal state (collapsed /
 * maximized / RGL layouts), clock-overlay position/font/color,
 * interactionState (transient), sync session state (runtime topology).
 */

import { makeFrameKey } from './chartFrameId.js';

export const VIEW_STATE_VERSION = 1;

/** Per-layer style keys that are transient UI state (never saved or shared). */
export const TRANSIENT_STYLE_KEYS = ['hoverCategory'];

/**
 * Copy of a { layerId -> style } map without transient UI keys, e.g. the
 * category a legend hover isolates. Used when a view is captured (so it is
 * not saved in perspectives or stories) and when one is applied (so views
 * saved before this rule are clean too).
 */
export function withoutTransientStyle(localStyle) {
  const out = {};
  for (const [id, style] of Object.entries(localStyle || {})) {
    if (!style || typeof style !== 'object') { out[id] = style; continue; }
    const copy = { ...style };
    for (const k of TRANSIENT_STYLE_KEYS) delete copy[k];
    out[id] = copy;
  }
  return out;
}

/**
 * Capture the live UI state into a plain JSON-serializable object.
 * Caller passes the current values; this function does not touch React.
 */
export function captureViewState({
  viewState,
  baseLayer,
  scenarioState,
  genericLayerVisibility,
  genericLayerLocalStyle,
  clockState,
  openScenarioCharts,
  aiAnchorModes,
  sidebarMode,
  expandedExt,
  legendOpen,
  extensions,
  controls,
} = {}) {
  // Deep clone object-shaped state so later mutations don't reach back
  // into the captured snapshot.
  const cloneShallow = (obj) => (obj ? JSON.parse(JSON.stringify(obj)) : {});

  return {
    version: VIEW_STATE_VERSION,
    view: viewState ? {
      latitude: viewState.latitude,
      longitude: viewState.longitude,
      zoom: viewState.zoom,
      bearing: viewState.bearing ?? 0,
      pitch: viewState.pitch ?? 0,
    } : null,
    basemap: baseLayer ?? null,
    scenario: {
      project: scenarioState?.project ?? '',
      scenario: scenarioState?.scenario ?? '',
    },
    layers: {
      visibility: { ...(genericLayerVisibility || {}) },
      localStyle: withoutTransientStyle(cloneShallow(genericLayerLocalStyle)),
    },
    clock: clockState ? {
      index: clockState.index ?? 0,
      animate: !!clockState.animate,
      frequency: clockState.frequency ?? 750,
      start_index: clockState.start_index ?? 0,
      end_index: clockState.end_index ?? 0,
      showClock: !!clockState.showClock,
    } : null,
    // Chart frames: identify charts by (extName, chartName, entityId) AND
    // include the full chart spec so the destination doesn't have to
    // re-resolve it from list_chart_specs (which would race the apply
    // and might not include charts from a different scenario).
    chartFrames: (openScenarioCharts || []).map((entry) => {
      const base = {
        kind: entry.kind || 'scenario',
        anchorMode: entry.anchorMode || 'floating',
      };
      if (entry.kind === 'builtin-ts') {
        return { ...base, builtin: { ...entry.builtin } };
      }
      return {
        ...base,
        charts: (entry.charts || []).map((c) => ({
          extName: c.extName,
          chartName: c.spec?.name,
          chartSpec: c.spec,                    // self-contained restore
          entityId: c.entityId || null,
          entityName: c.entityName || null,     // keep county/state label on restore
        })),
      };
    }),
    aiAnchorModes: { ...(aiAnchorModes || {}) },
    ui: {
      sidebarMode: sidebarMode ?? null,
      expandedExt: expandedExt ?? null,
      legendOpen: legendOpen ?? false,
    },
    // Per-extension on/off. Captures only the names that were enabled at
    // capture time; on apply, every extension not in this list is forced
    // to "disabled" so the chapter restores the exact tool palette.
    extensions: {
      enabled: (extensions || [])
        .filter((e) => e?.state === 'enabled')
        .map((e) => e.name),
    },
    // Input-control values for the focused extension, captured so a chapter
    // restores them (e.g. Sector = Data Center). Shape:
    //   { extName, project, scenario, values: { controlName: value } }
    controls: controls ?? null,
  };
}

/**
 * Apply a previously-captured blob to the live UI. Caller supplies the
 * setter functions; missing setters silently no-op so partial dispatchers
 * are valid (e.g. the controller machine doesn't need to dispatch chart
 * frames, just the clock + scenario).
 */
export function applyViewState(blob, dispatchers = {}) {
  if (!blob || typeof blob !== 'object') return;
  const v = blob.version ?? 1;
  if (v > VIEW_STATE_VERSION) {
    console.warn('[viewState] blob version', v, '> supported', VIEW_STATE_VERSION,
      '— attempting best-effort apply');
  }

  const {
    setViewState, setBaseLayer, updateScenarioState,
    setGenericLayerVisibility, setGenericLayerLocalStyle,
    updateClockState, setOpenScenarioCharts, setAiAnchorModes,
    setSidebarMode, setExpandedExt, setLegendOpen, mapRef,
    applyExtensionStates, applyInputControls,
    flyDurationMs = 1000,
  } = dispatchers;

  // Extensions first — toggling triggers a layer refetch that we want to
  // happen before per-layer visibility/style is applied below.
  if (blob.extensions?.enabled && applyExtensionStates) {
    applyExtensionStates(blob.extensions.enabled);
  }

  // Scenario first — switching scenarios may trigger downstream layer
  // reloads that race with the rest of the apply, so do it up front.
  if (blob.scenario && updateScenarioState
      && (blob.scenario.project || blob.scenario.scenario)) {
    updateScenarioState(blob.scenario);
  }

  // Restore captured input-control values (e.g. Sector = Data Center) after
  // the extension is enabled and its scenario is active. Fire-and-forget; the
  // dispatcher POSTs each value and refreshes dependent panels/charts.
  if (blob.controls?.values && applyInputControls) {
    applyInputControls(blob.controls);
  }

  if (blob.basemap && setBaseLayer) {
    setBaseLayer(blob.basemap);
  }

  if (blob.layers?.visibility && setGenericLayerVisibility) {
    // Replace visibility map wholesale; layers not in the blob fall back
    // to defaults via the existing visibility lookup (`!== false` is
    // visible by default).
    setGenericLayerVisibility(blob.layers.visibility);
  }
  if (blob.layers?.localStyle && setGenericLayerLocalStyle) {
    setGenericLayerLocalStyle(withoutTransientStyle(blob.layers.localStyle));
  }

  if (blob.clock && updateClockState) {
    // Preserve `timestamps` from the live state — the buffer-derived
    // array isn't part of the snapshot (it's expensive to serialize and
    // is re-derived from scenario data).
    updateClockState((prev) => ({ ...prev, ...blob.clock, timestamps: prev.timestamps }));
  }

  if (Array.isArray(blob.chartFrames) && setOpenScenarioCharts) {
    setOpenScenarioCharts(blob.chartFrames.map((f) => {
      const base = { key: makeFrameKey(), anchorMode: f.anchorMode || 'floating' };
      if (f.kind === 'builtin-ts') {
        return { ...base, kind: 'builtin-ts', builtin: f.builtin || {} };
      }
      // Tolerate both blob shapes:
      //   - newer captures store the chart spec under `chartSpec`
      //     (so the destination doesn't re-resolve from the registry)
      //   - older captures stored it directly under `spec`
      // Drop any entry that ends up specless — downstream renderers
      // dereference c.spec.name without optional chaining and would
      // crash with "undefined is not an object (evaluating 'e.spec')".
      const charts = (f.charts || [])
        .map((c) => ({
          extName: c.extName,
          spec: c.chartSpec ?? c.spec ?? null,
          entityId: c.entityId || '',
          entityName: c.entityName || null,
        }))
        .filter((c) => c.spec && c.extName);
      return { ...base, charts };
    }));
  }

  if (blob.aiAnchorModes && setAiAnchorModes) {
    setAiAnchorModes(blob.aiAnchorModes);
  }

  if (blob.ui) {
    if (blob.ui.sidebarMode && setSidebarMode) setSidebarMode(blob.ui.sidebarMode);
    if (blob.ui.expandedExt !== undefined && setExpandedExt) {
      setExpandedExt(blob.ui.expandedExt);
    }
    if (setLegendOpen) setLegendOpen(!!blob.ui.legendOpen);
  }

  // Map viewport last — animated `flyTo` if the map is mounted and the
  // duration is positive, else instant via setViewState. Do this AFTER
  // state mutations so the new layers are already requesting render
  // when the camera lands.
  if (blob.view) {
    const map = mapRef?.current?.getMap?.();
    if (map && flyDurationMs > 0 && Number.isFinite(blob.view.latitude)) {
      try {
        map.flyTo({
          center: [blob.view.longitude, blob.view.latitude],
          zoom: blob.view.zoom,
          bearing: blob.view.bearing ?? 0,
          pitch: blob.view.pitch ?? 0,
          duration: flyDurationMs,
        });
      } catch {
        if (setViewState) setViewState((prev) => ({ ...prev, ...blob.view }));
      }
    } else if (setViewState) {
      setViewState((prev) => ({ ...prev, ...blob.view }));
    }
  }
}

/**
 * Compare two blobs for "is the live state still on the captured chapter"?
 * Used by the playback bar's drift indicator. Cheap shallow checks on
 * the keys most likely to differ from user interaction.
 */
export function viewStateMatches(blobA, blobB) {
  if (!blobA || !blobB) return false;
  // Map viewport — round to 4 decimal places (~10m at the equator) so
  // tiny floating-point jitter doesn't flag as drift.
  const round = (n, d = 4) => Number.isFinite(n)
    ? Math.round(n * Math.pow(10, d)) / Math.pow(10, d) : null;
  if (round(blobA.view?.latitude) !== round(blobB.view?.latitude)) return false;
  if (round(blobA.view?.longitude) !== round(blobB.view?.longitude)) return false;
  if (round(blobA.view?.zoom, 2) !== round(blobB.view?.zoom, 2)) return false;
  if (blobA.basemap !== blobB.basemap) return false;
  if (blobA.scenario?.project !== blobB.scenario?.project) return false;
  if (blobA.scenario?.scenario !== blobB.scenario?.scenario) return false;
  if (blobA.clock?.index !== blobB.clock?.index) return false;
  if (blobA.clock?.animate !== blobB.clock?.animate) return false;
  // Layer visibility — string-ify both maps and compare. Cheap enough.
  if (JSON.stringify(blobA.layers?.visibility || {})
      !== JSON.stringify(blobB.layers?.visibility || {})) return false;
  // Chart frame identity (count + each frame's chart names) — ignore key.
  const frameSig = (frames) => (frames || []).map((f) => {
    if (f.kind === 'builtin-ts') {
      return `b:${f.builtin?.layerId}:${f.builtin?.entityId}:${f.builtin?.dsId}`;
    }
    return 's:' + (f.charts || []).map(
      (c) => `${c.extName}::${c.chartName}::${c.entityId || ''}`
    ).join('|');
  }).join('//');
  if (frameSig(blobA.chartFrames) !== frameSig(blobB.chartFrames)) return false;
  // Extension on/off — sort to ignore order.
  const extSig = (b) => [...(b.extensions?.enabled || [])].sort().join('|');
  if (extSig(blobA) !== extSig(blobB)) return false;
  return true;
}
