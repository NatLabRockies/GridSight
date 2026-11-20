/**
 * useChartFrames — owns the open-chart-frame list + its 'charts' bus
 * surface. Both `<App/>` and `<ChartTrayApp/>` track the same
 * { key, kind, charts | builtin | panelId, anchorMode } shape and
 * implement the same open / close / combine / split / transfer
 * lifecycle, so the duplication moved here.
 *
 * What stays at the call site:
 *   - App's "Charts" menu close (`setChartsMenu(null)` after open)
 *   - ChartTrayApp's mirror state + control-mode panel seeding
 *   - viewState capture/apply (uses `setFrames` directly)
 *
 * Options control the few real differences:
 *   - `defaultAnchor`   — anchor mode for newly-opened or untagged-receive
 *                         frames ('floating' on the host, 'tray' on the
 *                         tray tab)
 *   - `panelAnchorOverride` — non-null forces panel frames to this anchor
 *                         instead of the registry's defaultAnchor (the
 *                         tray tab pins panels to 'tray' mode for its
 *                         react-grid-layout)
 *   - `requestOnMount`  — late-joining tabs (the tray) ask paired tabs
 *                         for any tray-mode frames they should adopt
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import bus from '../lib/stateBus.js';
import { PANEL_REGISTRY } from '../lib/panelRegistry.jsx';
import {
  makeFrameKey,
  scenarioChartId,
  entityChartId,
  existingChartIdSet,
} from '../lib/chartFrameId.js';

// Map a canonical anchor (used by MCP/external drivers: right|left|bottom|
// floating|tray) to this frame system's vocabulary (side-right|side-left|…).
// Unknown/already-native values pass through.
function normalizeFrameAnchor(mode) {
  if (mode === 'right') return 'side-right';
  if (mode === 'left') return 'side-left';
  return mode;
}

// A stable, key-independent descriptor for matching the "same" frame across
// tabs (each tab assigns its own random frame key, so close/anchor sync must
// match on content identity instead).
function frameIdentity(entry) {
  if (entry.kind === 'panel') return { kind: 'panel', panelId: entry.panelId };
  if (entry.kind === 'builtin-ts') {
    const b = entry.builtin || {};
    return { kind: 'builtin-ts', layerId: b.layerId, entityId: b.entityId, dsId: b.dsId };
  }
  return { kind: 'charts', ids: (entry.charts || []).map((c) => entityChartId(c)) };
}

function frameMatchesIdentity(entry, ident) {
  if (!ident) return false;
  if (ident.kind === 'panel') return entry.kind === 'panel' && entry.panelId === ident.panelId;
  if (ident.kind === 'builtin-ts') {
    return entry.kind === 'builtin-ts'
      && entry.builtin?.layerId === ident.layerId
      && entry.builtin?.entityId === ident.entityId
      && entry.builtin?.dsId === ident.dsId;
  }
  if (ident.kind === 'charts') {
    const mine = new Set((entry.charts || []).map((c) => entityChartId(c)));
    return Array.isArray(ident.ids) && ident.ids.length === mine.size
      && ident.ids.every((id) => mine.has(id));
  }
  return false;
}

function buildTransferPayload(entry) {
  const base = { type: 'chart:open-frame', anchorMode: entry.anchorMode };
  if (entry.kind === 'panel') {
    return { ...base, kind: 'panel', panelId: entry.panelId };
  }
  if (entry.kind === 'builtin-ts') {
    return { ...base, kind: 'builtin-ts', builtin: entry.builtin };
  }
  return {
    ...base,
    // Self-contained: include the full chart spec so the receiver doesn't
    // need to re-resolve from list_chart_specs (which would race the
    // arrival and might not include charts from a different scenario).
    charts: (entry.charts || []).map((c) => ({
      extName: c.extName, spec: c.spec, entityId: c.entityId, entityName: c.entityName,
    })),
  };
}

export default function useChartFrames({
  defaultAnchor = 'floating',
  panelAnchorOverride = null,
  requestOnMount = false,
} = {}) {
  const [frames, setFrames] = useState([]);
  const framesRef = useRef(frames);
  framesRef.current = frames;

  const resolvePanelAnchor = useCallback((payloadAnchor, panelDef) => {
    if (panelAnchorOverride) return panelAnchorOverride;
    return payloadAnchor || panelDef?.defaultAnchor || defaultAnchor;
  }, [defaultAnchor, panelAnchorOverride]);

  // Broadcast a newly-opened frame so paired tabs (local OR remote display)
  // open the same chart. Previously only an explicit cross-window *transfer*
  // hit the bus, so opening a "Default"/extension chart on the control never
  // reached the display. `bus.publish` self-gates on the per-channel publish
  // flag and on being in a session, so this is a no-op when sync is off or
  // solo. The receive handler opens via setFrames (not these open* fns), so
  // there's no echo loop, and it dedups by chart identity.
  const broadcastOpen = useCallback((entry) => {
    bus.publish('charts', buildTransferPayload(entry), 'update');
  }, []);

  // ── Local opens ────────────────────────────────────────────────────────
  const openScenarioChart = useCallback((extName, spec) => {
    const id = scenarioChartId({ extName, spec });
    // Entityless dedup: if this chart name is already in any open frame,
    // don't open (or broadcast) a second copy.
    if (framesRef.current.some((e) => e.charts?.some((c) => scenarioChartId(c) === id))) return;
    const entry = { key: makeFrameKey(), charts: [{ extName, spec }], anchorMode: defaultAnchor };
    setFrames((prev) => (
      prev.some((e) => e.charts?.some((c) => scenarioChartId(c) === id)) ? prev : [...prev, entry]
    ));
    broadcastOpen(entry);
  }, [defaultAnchor, broadcastOpen]);

  const openEntityChart = useCallback((extName, spec, entityId, entityName) => {
    const id = entityChartId({ extName, spec, entityId });
    if (framesRef.current.some((e) => e.kind !== 'builtin-ts' && e.charts?.some(
      (c) => entityChartId(c) === id
    ))) return;
    // Carry the human-readable entityName resolved at click time (from the
    // GeoJSON feature). A popped-out frame only has the entityId, and counties
    // aren't in the FIPS→name fallback, so without this the title reverts to
    // the raw GEOID.
    const entry = { key: makeFrameKey(), charts: [{ extName, spec, entityId, entityName }], anchorMode: defaultAnchor };
    setFrames((prev) => (
      prev.some((e) => e.kind !== 'builtin-ts' && e.charts?.some((c) => entityChartId(c) === id))
        ? prev : [...prev, entry]
    ));
    broadcastOpen(entry);
  }, [defaultAnchor, broadcastOpen]);

  const openBuiltinTimeseries = useCallback(({ layerId, entityId, dsId, label }) => {
    const dup = (e) => e.kind === 'builtin-ts'
      && e.builtin?.layerId === layerId
      && e.builtin?.entityId === entityId
      && e.builtin?.dsId === dsId;
    if (framesRef.current.some(dup)) return;
    const entry = {
      key: makeFrameKey(),
      kind: 'builtin-ts',
      builtin: { layerId, entityId, dsId, label },
      anchorMode: defaultAnchor,
    };
    setFrames((prev) => (prev.some(dup) ? prev : [...prev, entry]));
    broadcastOpen(entry);
  }, [defaultAnchor, broadcastOpen]);

  const openPanel = useCallback((panelId, opts = {}) => {
    const def = PANEL_REGISTRY[panelId];
    const dup = (e) => e.kind === 'panel' && e.panelId === panelId;
    if (def?.singleton && framesRef.current.some(dup)) return;
    const entry = {
      key: makeFrameKey(),
      kind: 'panel',
      panelId,
      anchorMode: opts.anchorMode || resolvePanelAnchor(null, def),
    };
    setFrames((prev) => ((def?.singleton && prev.some(dup)) ? prev : [...prev, entry]));
    broadcastOpen(entry);
  }, [resolvePanelAnchor, broadcastOpen]);

  // ── Mutations ──────────────────────────────────────────────────────────
  // `closeFrame` broadcasts a close so a mirrored copy on a paired tab closes
  // too. `opts.broadcast === false` suppresses it — used by a 'move' transfer,
  // which closes the source locally but must NOT tell the move *target* (which
  // just opened the chart) to close it again.
  const closeFrame = useCallback((key, opts = {}) => {
    const entry = framesRef.current.find((c) => c.key === key);
    setFrames((prev) => prev.filter((c) => c.key !== key));
    if (entry && opts.broadcast !== false) {
      bus.publish('charts', { type: 'chart:close-frame', frame: frameIdentity(entry) }, 'update');
    }
  }, []);

  const setAnchor = useCallback((key, mode) => {
    const entry = framesRef.current.find((c) => c.key === key);
    setFrames((prev) => prev.map((c) => (
      c.key === key ? { ...c, anchorMode: mode } : c
    )));
    if (entry) {
      bus.publish('charts', { type: 'chart:set-anchor', frame: frameIdentity(entry), anchorMode: mode }, 'update');
    }
  }, []);

  // Store + broadcast a frame's floating geometry (viewport fractions) so the
  // same chart occupies the same proportion of every paired display. Fired by
  // ChartFrame on drag/resize/pinch END.
  const setGeom = useCallback((key, geom) => {
    const entry = framesRef.current.find((c) => c.key === key);
    setFrames((prev) => prev.map((c) => (c.key === key ? { ...c, geom } : c)));
    if (entry) {
      bus.publish('charts', { type: 'chart:set-geometry', frame: frameIdentity(entry), geom }, 'update');
    }
  }, []);

  const combine = useCallback((toKey, fromKey) => {
    setFrames((prev) => {
      const from = prev.find((e) => e.key === fromKey);
      if (!from) return prev;
      return prev
        .map((e) => (e.key === toKey ? { ...e, charts: [...e.charts, ...from.charts] } : e))
        .filter((e) => e.key !== fromKey);
    });
  }, []);

  const split = useCallback((entryKey, chartIndex) => {
    setFrames((prev) => {
      const entry = prev.find((e) => e.key === entryKey);
      if (!entry || !entry.charts || entry.charts.length <= 1) return prev;
      const extracted = entry.charts[chartIndex];
      const remaining = entry.charts.filter((_, i) => i !== chartIndex);
      return prev
        .map((e) => (e.key === entryKey ? { ...e, charts: remaining } : e))
        .concat({
          key: makeFrameKey(),
          charts: [extracted],
          anchorMode: entry.anchorMode,
        });
    });
  }, []);

  // Cross-window transfer. Broadcasts the frame on 'charts' addressed to
  // `targetTabId`. 'move' closes locally after send; 'mirror' keeps it.
  const transfer = useCallback((entryKey, targetTabId, mode) => {
    const entry = framesRef.current.find((e) => e.key === entryKey);
    if (!entry) return;
    bus.publish('charts', buildTransferPayload(entry), 'transfer', { targetTabId });
    // 'move' closes the source locally but must not broadcast a close — that
    // would tell the move target (which just opened it) to close it too.
    if (mode === 'move') closeFrame(entryKey, { broadcast: false });
  }, [closeFrame]);

  // ── 'charts' bus surface ───────────────────────────────────────────────
  useEffect(() => {
    const unsub = bus.subscribe('charts', (payload, msg) => {
      if (!payload) return;

      if (payload.type === 'chart:open-frame') {
        // Panel frame (e.g. story-playback). Singleton dedup so a
        // mirror+move crossing in flight doesn't leave two copies.
        if (payload.kind === 'panel' && payload.panelId) {
          const def = PANEL_REGISTRY[payload.panelId];
          setFrames((prev) => {
            if (def?.singleton && prev.some(
              (e) => e.kind === 'panel' && e.panelId === payload.panelId
            )) return prev;
            return [...prev, {
              key: makeFrameKey(),
              kind: 'panel',
              panelId: payload.panelId,
              anchorMode: resolvePanelAnchor(payload.anchorMode, def),
            }];
          });
          return;
        }
        // Built-in (entity timeseries) frame.
        if (payload.kind === 'builtin-ts' && payload.builtin) {
          const b = payload.builtin;
          setFrames((prev) => {
            if (prev.some((e) => e.kind === 'builtin-ts'
              && e.builtin?.layerId === b.layerId
              && e.builtin?.entityId === b.entityId
              && e.builtin?.dsId === b.dsId)) return prev;
            return [...prev, {
              key: makeFrameKey(),
              kind: 'builtin-ts',
              builtin: b,
              anchorMode: panelAnchorOverride || payload.anchorMode || defaultAnchor,
            }];
          });
          return;
        }
        // Scenario / extension frame. Dedup by chart identity so retry
        // sync-requests (or a mirror landing while a move is in flight)
        // don't pile up duplicates with fresh keys.
        if (!Array.isArray(payload.charts) || payload.charts.length === 0) return;
        setFrames((prev) => {
          const existing = existingChartIdSet(prev);
          const fresh = payload.charts.filter((c) => !existing.has(entityChartId(c)));
          if (fresh.length === 0) return prev;
          return [...prev, {
            key: makeFrameKey(),
            charts: fresh,
            anchorMode: panelAnchorOverride || normalizeFrameAnchor(payload.anchorMode) || defaultAnchor,
          }];
        });
        return;
      }

      // Bulk close (MCP "close all charts"): drop every frame. AI charts are
      // cleared separately by BusSyncHost.
      if (payload.type === 'chart:close-all') {
        setFrames([]);
        return;
      }

      // Bulk re-anchor (MCP "arrange charts"): dock every frame to one anchor.
      // Canonical anchors map to this system's vocab (right→side-right, etc.).
      if (payload.type === 'chart:reanchor-all' && payload.anchorMode) {
        const mode = normalizeFrameAnchor(payload.anchorMode);
        setFrames((prev) => prev.map((entry) => (
          { ...entry, anchorMode: panelAnchorOverride || mode }
        )));
        return;
      }

      // Close sync: a paired tab closed a frame; close the matching one here.
      // Matched by content identity (keys differ per tab) across all frame
      // kinds (charts, builtin-ts, panel).
      if (payload.type === 'chart:close-frame' && payload.frame) {
        setFrames((prev) => prev.filter((entry) => !frameMatchesIdentity(entry, payload.frame)));
        return;
      }

      // Anchor sync: a paired tab re-docked a frame (tray / bottom / side /
      // float). Apply to the matching frame. A tab that pins everything to a
      // fixed anchor (panelAnchorOverride, e.g. the tray's grid) keeps its
      // override rather than following the peer.
      if (payload.type === 'chart:set-anchor' && payload.frame && payload.anchorMode) {
        setFrames((prev) => prev.map((entry) => (
          frameMatchesIdentity(entry, payload.frame)
            ? { ...entry, anchorMode: panelAnchorOverride || payload.anchorMode }
            : entry
        )));
        return;
      }

      // Geometry sync: a paired tab moved/resized a floating frame. Apply the
      // viewport-fraction geometry to the matching frame; ChartFrame converts
      // it to local pixels (so it lands at the same proportion on this screen).
      if (payload.type === 'chart:set-geometry' && payload.frame && payload.geom) {
        setFrames((prev) => prev.map((entry) => (
          frameMatchesIdentity(entry, payload.frame) ? { ...entry, geom: payload.geom } : entry
        )));
        return;
      }

      // Un-mirror: close any local frame whose chart-set is fully covered
      // by the supplied identity tuples.
      if (payload.type === 'chart:close-frame' && Array.isArray(payload.identity)) {
        const targets = new Set(payload.identity.map(
          (id) => `${id.extName}::${id.specName}::${id.entityId || ''}`
        ));
        setFrames((prev) => prev.filter((entry) => {
          if (entry.kind === 'builtin-ts' || entry.kind === 'panel') return true;
          const allMatch = (entry.charts || []).every(
            (c) => targets.has(entityChartId(c))
          );
          return !allMatch;
        }));
        return;
      }

      // Late-joining tab asks any peer with tray-mode frames to send them
      // over. Respond with each tray frame individually addressed to the
      // requester. Tabs without tray frames don't respond (the .filter
      // below leaves nothing to do).
      if (payload.type === 'chart:sync-request') {
        const requesterId = msg?.sourceId;
        if (!requesterId) return;
        const trayFrames = (framesRef.current || [])
          .filter((e) => e.anchorMode === 'tray');
        for (const frame of trayFrames) {
          bus.publish(
            'charts',
            { ...buildTransferPayload(frame), anchorMode: 'tray' },
            'transfer',
            { targetTabId: requesterId },
          );
        }
      }
    });
    return unsub;
  }, [defaultAnchor, panelAnchorOverride, resolvePanelAnchor]);

  // ── Late-join sync request ─────────────────────────────────────────────
  useEffect(() => {
    if (!requestOnMount) return;
    let attempts = 0;
    const MAX_ATTEMPTS = 5;
    const fire = () => {
      // Stop once any frames have arrived — first peer's response is
      // enough; subsequent retries would double-deliver.
      if (framesRef.current.length > 0 || attempts >= MAX_ATTEMPTS) return;
      attempts++;
      bus.publish('charts', { type: 'chart:sync-request' }, 'sync-request');
    };
    const t0 = setTimeout(fire, 400);
    const iv = setInterval(fire, 2500);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [requestOnMount]);

  return {
    frames,
    setFrames,
    framesRef,
    openScenarioChart,
    openEntityChart,
    openBuiltinTimeseries,
    openPanel,
    closeFrame,
    setAnchor,
    setGeom,
    combine,
    split,
    transfer,
  };
}
