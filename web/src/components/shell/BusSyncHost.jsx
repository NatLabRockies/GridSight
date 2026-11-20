import { useEffect, useRef } from "react";
import bus from "../../lib/stateBus.js";
import useStateBusSync from "../../hooks/useStateBusSync.js";
import { logViewport } from "../../lib/viewportDebug.js";
import { getViewportFitBounds } from "../../lib/viewportSyncMode.js";
import { setInputControl } from "../../lib/loaders.js";

/**
 * BusSyncHost — renders null; owns all of App's cross-tab sync side effects.
 *
 * State hooks remain in App.jsx; this shell is purely effects. All inputs
 * are passed as props so the component stays presentational.
 */
export default function BusSyncHost({
  map,
  layout,
  versions,
  scenarioState,
  updateScenarioState,
  extensions,
  interactionState,
  setInteractionState,
  chartDAG,
  setAiAnchor,
  broadcastClockAnchor,
  handlers,
  refs,
}) {
  const { onExtensionToggle, onApplyPerspective, onDatasetsInvalidated } = handlers;
  const { mapRef, mapInteractingRef, syncFlyingRef, handleLayerClickRef } = refs;

  // ── StateBus sync hooks ──────────────────────────────────────────────────
  // `requestOnMount` makes a late-joining tab actively request the current
  // layer catalog/visibility/style from peers (with a retry loop). This is
  // what fixes the choropleth/base-map dropping out on a remote (WebSocket)
  // display: the host's proactive peer-join rebroadcast (below) keys off
  // LOCAL BroadcastChannel discovery, which a cross-machine WS peer never
  // appears in — so without an explicit request the WS display never learns
  // the layer set. The retry loop also recovers from a dropped relay packet.
  //
  // `onSyncRequest` guards each responder: only a tab that actually HOLDS the
  // state answers, so an empty tab (e.g. another late joiner) can't clobber a
  // peer's real catalog with an empty one.
  const respondIfPresent = (channel, value) => {
    const present = Array.isArray(value)
      ? value.length > 0
      : value && typeof value === 'object'
        ? Object.keys(value).length > 0
        : value != null;
    if (present) bus.publish(channel, value, 'sync-response', { force: true });
  };
  useStateBusSync('layers:visibility', map.state.visibility, map.replaceVisibilityMap, {
    requestOnMount: true,
    onSyncRequest: () => respondIfPresent('layers:visibility', map.state.visibility),
  });
  useStateBusSync('layers:style', map.state.localStyle, map.replaceLocalStyleMap, {
    requestOnMount: true,
    onSyncRequest: () => respondIfPresent('layers:style', map.state.localStyle),
  });
  useStateBusSync('layers:catalog', map.state.configs, map.setConfigs, {
    requestOnMount: true,
    onSyncRequest: () => respondIfPresent('layers:catalog', map.state.configs),
  });
  useStateBusSync('controls', versions.state.inputControlRefreshKey, versions.setInputControl);
  // Scenario must also be requested on join: a late tab that only receives
  // `layers:catalog` gets the geometry (outlines/hover) but no FILL COLORS,
  // because the dataset fetch that builds the color arrays is gated on
  // scenarioState (project+scenario) in useScenarioLayerSync. Requesting it
  // on mount triggers that fetch on the joined tab. Only a tab with a real
  // project+scenario responds, so an unconfigured joiner can't clobber it.
  useStateBusSync('scenario', scenarioState, updateScenarioState, {
    requestOnMount: true,
    onSyncRequest: () => {
      if (scenarioState?.project && scenarioState?.scenario) {
        bus.publish('scenario', scenarioState, 'sync-response', { force: true });
      }
    },
  });

  // Extensions catalog two-way sync (can't use useStateBusSync naively — the
  // host needs to run the full setExtensionPreference + rebootstrap side
  // effect, not just a setter).
  const extPubRef = useRef(null);
  useEffect(() => {
    const sig = extensions.map((e) => `${e.name}:${e.state}`).join(',');
    if (extPubRef.current === sig) return;
    extPubRef.current = sig;
    bus.publish('extensions', extensions);
  }, [extensions]);
  useEffect(() => {
    return bus.subscribe('extensions', (payload, msg) => {
      if (msg?.action === 'sync-request') {
        bus.publish('extensions', extensions, 'sync-response');
        return;
      }
      if (!Array.isArray(payload)) return;
      extPubRef.current = payload.map((e) => `${e.name}:${e.state}`).join(',');
      for (const inc of payload) {
        const cur = extensions.find((e) => e.name === inc.name);
        if (cur && cur.state !== inc.state) {
          onExtensionToggle(inc.name, inc.state);
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);

  // Viewport sync: subscribe to viewport changes from other windows
  useEffect(() => {
    const unsub = bus.subscribe('viewport', (payload) => {
      logViewport('receive', { ...payload, applied: !mapInteractingRef.current });
      if (mapInteractingRef.current) return;
      const m = mapRef.current?.getMap?.();
      if (m) {
        syncFlyingRef.current = true;
        m.once('moveend', () => { syncFlyingRef.current = false; });
        if (typeof payload.zoomDelta === 'number') {
          // Relative zoom (agent/MCP zoom_map): keep the current center, nudge
          // the zoom by the delta. No absolute lat/lng needed — the assistant
          // rarely knows the live center.
          m.easeTo({ zoom: m.getZoom() + payload.zoomDelta, duration: 500, essential: true });
        } else if ((getViewportFitBounds() || payload.fit) && payload.bounds) {
          // Frame the same geography as the source, letting this display's
          // own size/aspect choose the zoom. `payload.fit` is set by an explicit
          // "fit to bounds" command (MCP) so it works even when the viewport
          // sync "fit bounds" toggle is off.
          const { w, s, e, n } = payload.bounds;
          m.fitBounds([[w, s], [e, n]], { duration: 800, essential: true });
        } else {
          m.flyTo({
            center: [payload.longitude, payload.latitude],
            zoom: payload.zoom,
            bearing: payload.bearing ?? 0,
            pitch: payload.pitch ?? 0,
            duration: 800,
            essential: true,
          });
        }
      }
    });
    return unsub;
  }, []);

  // ── 'tooltip' sync ────────────────────────────────────────────────────────
  const lastTooltipPubRef = useRef(null);
  useEffect(() => {
    if (interactionState?.trigger === 'hover') return;
    if (interactionState?.sourceTabId
        && interactionState.sourceTabId !== bus.getTabId()) return;
    const sig = interactionState
      ? `${interactionState.layerId}::${interactionState.entityId}`
      : 'null';
    if (lastTooltipPubRef.current === sig) return;
    lastTooltipPubRef.current = sig;
    bus.publish('tooltip', interactionState
      ? { ...interactionState, sourceTabId: bus.getTabId() }
      : null);
  }, [interactionState]);
  useEffect(() => {
    return bus.subscribe('tooltip', (payload, msg) => {
      if (msg?.action === 'sync-request') return;
      if (payload?.sourceTabId === bus.getTabId()) return;
      lastTooltipPubRef.current = payload
        ? `${payload.layerId}::${payload.entityId}`
        : 'null';
      if (payload?.trigger === 'click' && payload.feature && payload.layerId != null) {
        const fn = handleLayerClickRef.current;
        if (fn) {
          fn({
            object: payload.feature,
            layerId: payload.layerId,
            x: payload.coordinate?.x ?? 0,
            y: payload.coordinate?.y ?? 0,
            coordinate: [payload.coordinate?.lng, payload.coordinate?.lat],
          });
          return;
        }
      }
      setInteractionState(payload || null);
    });
  }, []);

  // ── Side effects from a remote-tab input-control commit ──────────────────
  useEffect(() => {
    return bus.subscribe('controls:effects', (payload) => {
      if (!payload) return;
      if (payload.type === 'datasets-invalidated'
          && payload.extName
          && Array.isArray(payload.datasets)) {
        onDatasetsInvalidated(payload.extName, payload.datasets);
        return;
      }
      // A peer changed an input control. Control state lives in a per-backend
      // singleton, so apply the value to THIS backend (a no-op if we share the
      // peer's backend; a real convergence if we're a different one, e.g. the
      // desktop sidecar vs the wall), then re-fetch via the invalidation path
      // so this tab's widgets + data update.
      if (payload.type === 'control-set' && payload.extName && payload.controlName) {
        setInputControl(payload.extName, payload.project, payload.scenario, payload.controlName, payload.value)
          .then((result) => {
            if (result?.invalidated_datasets?.length) {
              onDatasetsInvalidated(payload.extName, result.invalidated_datasets);
            }
          })
          .catch((e) => console.warn('[BusSyncHost] control-set apply failed:', e));
      }
    });
  }, [onDatasetsInvalidated]);

  // ── AI chart mirror + bulk ops from a remote tab / MCP ────────────────────
  // Ref so bulk handlers see the current AI chart set without re-subscribing.
  const aiChartsRef = useRef(chartDAG.charts);
  aiChartsRef.current = chartDAG.charts;
  // Canonical anchors from external drivers (MCP: right|left|bottom|floating|
  // tray) → the dock vocabulary AI charts group by (side-right|side-left|…).
  const normalizeAnchor = (mode) => (
    mode === 'right' ? 'side-right' : mode === 'left' ? 'side-left' : mode
  );
  useEffect(() => {
    return bus.subscribe('charts', (payload) => {
      if (!payload) return;
      // Close every AI chart (frames are cleared by useChartFrames).
      if (payload.type === 'chart:close-all') {
        chartDAG.clearCharts();
        return;
      }
      // Re-anchor every AI chart to one dock.
      if (payload.type === 'chart:reanchor-all' && payload.anchorMode) {
        const mode = normalizeAnchor(payload.anchorMode);
        for (const id of Object.keys(aiChartsRef.current || {})) {
          setAiAnchor(id, mode);
        }
        return;
      }
      if (payload.type !== 'chart:open-ai') return;
      if (!payload.spec) return;
      const newId = chartDAG.registerChart(
        payload.spec,
        'ai',
        payload.datasets || [],
        payload.plotlySpec || null,
        payload.format || 'plotly',
        payload.vegaLiteSpec || null,
      );
      setAiAnchor(newId, normalizeAnchor(payload.anchorMode || 'floating'));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartDAG]);

  // ── 'story' sync channel ──────────────────────────────────────────────────
  const storyEchoRef = useRef(null);
  useEffect(() => {
    const key = `${layout.state.activeStory ?? ''}::${layout.state.activePerspective ?? ''}`;
    if (storyEchoRef.current === key) return;
    storyEchoRef.current = key;
    bus.publish('story', {
      storyId: layout.state.activeStory,
      activePerspectiveId: layout.state.activePerspective,
    });
  }, [layout.state.activeStory, layout.state.activePerspective]);
  useEffect(() => {
    return bus.subscribe('story', (payload, msg) => {
      if (msg?.action === 'sync-request') {
        bus.publish('story', {
          storyId: layout.state.activeStory,
          activePerspectiveId: layout.state.activePerspective,
        }, 'sync-response');
        return;
      }
      if (!payload) return;
      const incomingKey = `${payload.storyId ?? ''}::${payload.activePerspectiveId ?? ''}`;
      storyEchoRef.current = incomingKey;
      if (payload.storyId !== layout.state.activeStory) layout.setActiveStory(payload.storyId || null);
      if (payload.activePerspectiveId != null
          && payload.activePerspectiveId !== layout.state.activePerspective) {
        onApplyPerspective(payload.activePerspectiveId);
      }
    });
  }, [layout.state.activeStory, layout.state.activePerspective, onApplyPerspective, layout]);

  // Peer-join rebroadcast
  const peerCountRef = useRef(0);
  useEffect(() => {
    return bus.discovery.onChange((tabs) => {
      const sameSession = tabs.filter((t) => t.sessionId === bus.getSessionId());
      const count = sameSession.length;
      if (count > peerCountRef.current) {
        const f = { force: true };
        bus.publish('story', {
          storyId: layout.state.activeStory,
          activePerspectiveId: layout.state.activePerspective,
        }, 'update', f);
        bus.publish('extensions', extensions, 'update', f);
        bus.publish('scenario', scenarioState, 'update', f);
        bus.publish('layers:catalog', map.state.configs, 'update', f);
        bus.publish('layers:visibility', map.state.visibility, 'update', f);
        bus.publish('layers:style', map.state.localStyle, 'update', f);
        broadcastClockAnchor({ force: true });
      }
      peerCountRef.current = count;
    });
  }, [layout.state.activeStory, layout.state.activePerspective, extensions, scenarioState,
      map.state.configs, map.state.visibility, map.state.localStyle,
      broadcastClockAnchor]);

  return null;
}
