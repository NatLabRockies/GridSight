/**
 * MapPanel — lightweight MapView for the command tab.
 *
 * Renders a MapLibre basemap with simple GeoJSON layer overlays for every
 * visible layer in the synced catalog. Geometry is fetched on demand per
 * visible layer (and cached locally) — the command tab does not run the
 * main display's deck.gl + TimeseriesBuffer pipeline. Live data-driven
 * coloring stays on the main display; the command tab shows static
 * geometry tinted by `localStyle.staticFillColor` if set.
 *
 * Interaction:
 *   - Pan/zoom is broadcast on the existing 'viewport' channel; the main
 *     display follows. The MapPanel itself listens for incoming viewport
 *     state and flies to it (mirrors the main App's pattern).
 *   - Clicks publish on the 'tooltip' channel as `{ trigger: 'click',
 *     layerId, entityId, feature, coordinate, content, sourceTabId }`.
 *     The main App receives that and opens its EntityInteractionManager
 *     popup with the same data — that side already has the live values
 *     and will fetch the appropriate sections.
 *
 * Render-suppression:
 *   - With static layers (no per-tick TimeseriesBuffer attached) there's
 *     nothing to suppress — the layers re-render only when the catalog,
 *     visibility, or style maps change. The "Live render" toggle in the
 *     header is reserved for a follow-up that wires per-frame buffer data.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import CircularProgress from '@mui/material/CircularProgress';
import MapView, { useControl } from 'react-map-gl/maplibre';
import { MapboxOverlay as DeckOverlay } from '@deck.gl/mapbox';
import { BASEMAP } from '@deck.gl/carto';
import LocationSearchingIcon from '@mui/icons-material/LocationSearching';

import bus from '../../lib/stateBus.js';
import { applyVerticalFillMinZoom, applyRenderPixelRatio } from '../../lib/mapCamera.js';
import { getViewportFitBounds } from '../../lib/viewportSyncMode.js';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';
import { fetchGeometryData, fetchDatasetData } from '../../lib/loaders.js';
import { createGenericLayer, buildDataIndex } from '../../lib/layer_generators.js';
import { useApplyDeckLayers } from '../../lib/useApplyDeckLayers.js';

function DeckGLOverlay(props) {
  const overlay = useControl(() => new DeckOverlay(props));
  overlay.setProps(props);
  useApplyDeckLayers(overlay, props.layers);
  return null;
}

const DEFAULT_BASEMAP = BASEMAP.DARK_MATTER;
const DEFAULT_VIEW = { longitude: -98, latitude: 39, zoom: 3, bearing: 0, pitch: 0 };

export default function MapPanel({
  layers,                 // genericLayerConfigs from synced catalog
  visibility,             // { layerId -> bool }
  localStyle,             // { layerId -> styleObj }
  scenarioState,
  // Bumps whenever an input control fires anywhere in the session — both
  // for local same-tab changes (ChartTrayApp bumps it directly) and for
  // remote tab changes (synced over the 'controls' bus channel). MapPanel
  // refetches every static dataset when this changes so the map reflects
  // the new control values without waiting for a 'controls:effects' bus
  // event (which the bus suppresses for same-tab subscribers by design).
  inputControlRefreshKey = 0,
  basemap = DEFAULT_BASEMAP,
}) {
  const mapRef = useRef(null);
  const [geoCache, setGeoCache] = useState({});  // { layerId -> GeoJSON }
  const [dataCache, setDataCache] = useState({}); // { layerId -> Map(joinKey -> rowObj) }
  const [loading, setLoading] = useState(new Set());

  // ── Viewport sync ────────────────────────────────────────────────────────
  // Mirror the main App's pattern: uncontrolled MapView, push moveend
  // to the bus, and listen for incoming viewport changes via flyTo. The
  // PUBLISH/RECEIVE direction is controlled centrally by the bus's
  // per-channel sync flags (operator can flip them in the Sync Settings
  // panel; ChartTrayApp also sets sensible defaults at mount time).
  const interactingRef = useRef(false);
  const flyingRef = useRef(false);

  useEffect(() => {
    return bus.subscribe('viewport', (payload) => {
      if (interactingRef.current || !payload) return;
      const map = mapRef.current?.getMap?.();
      if (!map) return;
      flyingRef.current = true;
      map.once('moveend', () => { flyingRef.current = false; });
      if ((getViewportFitBounds() || payload.fit) && payload.bounds) {
        // `payload.fit` forces the bounds path for an explicit fit-to-bounds
        // command (MCP) even when the viewport sync "fit bounds" toggle is off.
        const { w, s, e, n } = payload.bounds;
        map.fitBounds([[w, s], [e, n]], { duration: 800, essential: true });
      } else {
        map.flyTo({
          center: [payload.longitude, payload.latitude],
          zoom: payload.zoom,
          bearing: payload.bearing ?? 0,
          pitch: payload.pitch ?? 0,
          duration: 800,
          essential: true,
        });
      }
    });
  }, []);

  const { scale: displayScale } = useDisplayScale();

  // Enforce vertical-fill minZoom + a scale-compensated render pixel ratio on
  // load and resize (see lib/mapCamera.js) so the command-tab map neither
  // locks to the pole when zoomed out nor renders soft tiles under CSS zoom.
  const handleLoad = useCallback((evt) => {
    const m = evt?.target;
    if (!m) return;
    applyVerticalFillMinZoom(m);
    applyRenderPixelRatio(m, displayScale);
    m.on('resize', () => applyVerticalFillMinZoom(m));
  }, [displayScale]);

  // Re-apply when the display scale changes — CSS body zoom alters the
  // effective container height and render resolution without firing
  // MapLibre's own 'resize'.
  useEffect(() => {
    const m = mapRef.current?.getMap?.();
    if (m) {
      applyVerticalFillMinZoom(m);
      applyRenderPixelRatio(m, displayScale);
    }
  }, [displayScale]);

  const debounceRef = useRef(null);
  const handleMoveStart = useCallback(() => {
    if (flyingRef.current) return;
    interactingRef.current = true;
  }, []);
  const handleMoveEnd = useCallback((evt) => {
    if (flyingRef.current) { flyingRef.current = false; return; }
    interactingRef.current = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const v = evt.viewState;
      const b = mapRef.current?.getMap?.()?.getBounds?.();
      bus.publish('viewport', {
        longitude: v.longitude, latitude: v.latitude, zoom: v.zoom,
        bearing: v.bearing ?? 0, pitch: v.pitch ?? 0,
        bounds: b ? { w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() } : null,
      });
    }, 150);
  }, []);

  // ── Geometry fetch (visible layers only, cached) ─────────────────────────
  useEffect(() => {
    const visibleLayers = (layers || []).filter((lc) => {
      if (!lc?.geometry?.id) return false;
      // Spatial geometries are served per-viewport, not as one whole-GeoJSON
      // blob; the command-tab map doesn't drive viewport fetches yet, so skip
      // them here rather than fetching the raw stored file. (Follow-up: wire
      // useSpatialViewportLayers to this surface too.)
      if (lc.geometry?.is_spatial) return false;
      return visibility?.[lc.id] !== false;
    });
    for (const lc of visibleLayers) {
      if (geoCache[lc.id] || loading.has(lc.id)) continue;
      setLoading((prev) => new Set(prev).add(lc.id));
      fetchGeometryData(lc.geometry.id)
        .then((geo) => setGeoCache((prev) => ({ ...prev, [lc.id]: geo })))
        .catch((e) => console.warn('[MapPanel] geo fetch failed for', lc.id, e))
        .finally(() => setLoading((prev) => {
          const next = new Set(prev);
          next.delete(lc.id);
          return next;
        }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, visibility]);

  // Helper: fetch the static dataset rows for one layer config and
  // commit them to the data cache. Used both for first-time fetch and
  // for re-fetch when an input control invalidates a dataset.
  const fetchStaticDataFor = useCallback((lc) => {
    const ld = (lc.layer_datasets || []).find(
      (x) => x.dataset && !x.dataset.timestamp_col,
    );
    if (!ld) return;
    const joinKey = ld.data_join_key ?? ld.dataset.join_key;
    if (!joinKey) return;
    fetchDatasetData(ld.dataset.id)
      .then((rows) => setDataCache((prev) => ({
        ...prev, [lc.id]: buildDataIndex(rows, joinKey),
      })))
      .catch((e) => console.warn('[MapPanel] dataset fetch failed for', lc.id, e));
  }, []);

  // ── Static-dataset fetch (one-shot per visible layer) ────────────────────
  // The main display attaches a TimeseriesBuffer for every dataset with
  // a timestamp_col and pre-renders frames per tick. This panel doesn't
  // run that pipeline (would double the deck.gl + worker cost on the
  // command tab), so we only fetch *static* datasets here. The live
  // timeseries layers fall through to staticFillColor; coloring fidelity
  // for those is intentionally lower than the main display.
  useEffect(() => {
    const visibleLayers = (layers || []).filter((lc) => {
      if (visibility?.[lc.id] === false) return false;
      return (lc.layer_datasets ?? []).some(
        (ld) => ld.dataset && !ld.dataset.timestamp_col,
      );
    });
    for (const lc of visibleLayers) {
      if (dataCache[lc.id]) continue;
      fetchStaticDataFor(lc);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, visibility, fetchStaticDataFor]);

  // ── Refetch on input-control change ──────────────────────────────────────
  // Bus 'controls:effects' is cross-tab only: a same-tab publish never
  // reaches its own subscribers (stateBus.receive filters by sourceId).
  // So when the operator moves a slider on the command tab itself, no
  // controls:effects event lands here. Instead we ride the
  // inputControlRefreshKey prop, which is bumped in ChartTrayApp on every
  // input-control fire (local AND remote — useStateBusSync('controls')
  // keeps it aligned across tabs). On bump, refetch every static dataset
  // we have cached so coloring re-evaluates with new control values.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current) { firstRunRef.current = false; return; }
    for (const lc of layers || []) {
      const hasStatic = (lc.layer_datasets || []).some(
        (ld) => ld.dataset && !ld.dataset.timestamp_col,
      );
      if (hasStatic) fetchStaticDataFor(lc);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputControlRefreshKey]);

  // ── Click handler — publish tooltip intent on the bus ────────────────────
  const handleLayerClick = useCallback((info, layerId) => {
    if (!info?.object) return;
    const lc = (layers || []).find((c) => c.id === layerId);
    const geomJoinKey = lc?.geometry?.join_key;
    const entityId = geomJoinKey
      ? String(info.object.properties?.[geomJoinKey] ?? '')
      : null;
    const interaction = lc?.style_mappings?.[0]?.interaction
      || localStyle?.[layerId]?.interaction
      || {};
    const content = interaction.clickContent ?? ['infocard', 'timeseries'];
    bus.publish('tooltip', {
      layerId,
      entityId,
      feature: info.object,
      coordinate: { x: info.x, y: info.y, lng: info.coordinate?.[0], lat: info.coordinate?.[1] },
      trigger: 'click',
      content,
      sourceTabId: bus.getTabId(),
    });
    // Also fit the panel's own map to the clicked polygon so the operator
    // sees the same zoom-in feedback on the command tab. flyingRef guards
    // the moveend handler from re-publishing a viewport update for this
    // animated camera move (the main display picks up the viewport via
    // its own subscription, no double-publish needed here).
    const map = mapRef.current?.getMap?.();
    const feat = info.object;
    if (map && feat?.geometry?.type?.includes('Polygon')) {
      const flat = [];
      const walk = (arr) => {
        if (Array.isArray(arr) && arr.length && Array.isArray(arr[0])
            && typeof arr[0][0] === 'number') {
          for (const c of arr) flat.push(c);
        } else if (Array.isArray(arr)) {
          for (const c of arr) walk(c);
        }
      };
      walk(feat.geometry.coordinates);
      if (flat.length) {
        let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
        for (const [x, y] of flat) {
          if (x < minLng) minLng = x;
          if (y < minLat) minLat = y;
          if (x > maxLng) maxLng = x;
          if (y > maxLat) maxLat = y;
        }
        flyingRef.current = true;
        try {
          map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
            padding: 40, duration: 800, maxZoom: 9,
          });
        } catch { flyingRef.current = false; }
      }
    } else if (map && Number.isFinite(info.coordinate?.[0])) {
      flyingRef.current = true;
      map.flyTo({
        center: [info.coordinate[0], info.coordinate[1]],
        zoom: Math.max(map.getZoom(), 7), duration: 800,
      });
    }
  }, [layers, localStyle]);

  // ── Build deck.gl layers via the shared factory ─────────────────────────
  // Reuses createGenericLayer so visual mappings (colormaps, geoMappings,
  // staticFillColor / lineWidth scales) match the main display 1:1 for
  // any layer whose data is static. Live timeseries layers render with
  // their staticFillColor fallback — they don't have per-tick data on
  // this tab and faking it would lie about the demo.
  const deckLayers = useMemo(() => {
    return (layers || [])
      .filter((lc) => visibility?.[lc.id] !== false && geoCache[lc.id])
      .map((lc) => createGenericLayer(
        lc,
        geoCache[lc.id],
        dataCache[lc.id] ?? null,
        localStyle?.[lc.id] ?? {},
        null,                             // no TimeseriesBuffer on this tab
        0,                                // tsVersion irrelevant without buffer
        0,                                // no per-frame transitions
        null,                             // hover stays local on main; skip here
        (info) => handleLayerClick(info, lc.id),
      ))
      .filter(Boolean);
  }, [layers, visibility, localStyle, geoCache, dataCache, handleLayerClick]);

  const someLoading = loading.size > 0;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Box sx={{ width: '100%', height: '100%', position: 'relative', minHeight: 240 }}>
      <Box sx={{
        position: 'absolute', top: 4, right: 4, zIndex: 2,
        display: 'flex', alignItems: 'center', gap: 0.5,
        bgcolor: 'background.paper', px: 0.75, py: 0.25,
        borderRadius: 1, opacity: 0.85,
      }}>
        {someLoading && <CircularProgress size={12} />}
        <Tooltip title="Recenter on extent">
          <IconButton size="small" onClick={() => {
            const map = mapRef.current?.getMap?.();
            if (map) map.flyTo({ center: [DEFAULT_VIEW.longitude, DEFAULT_VIEW.latitude],
                                  zoom: DEFAULT_VIEW.zoom, duration: 600 });
          }}>
            <LocationSearchingIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {scenarioState?.scenario || ''}
        </Typography>
      </Box>
      <MapView
        ref={mapRef}
        initialViewState={DEFAULT_VIEW}
        onLoad={handleLoad}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        mapStyle={basemap}
        style={{ width: '100%', height: '100%' }}
      >
        <DeckGLOverlay layers={deckLayers} interleaved />
      </MapView>
    </Box>
  );
}
