/**
 * useSpatialViewportLayers
 *
 * Viewport-driven geometry loading for `is_spatial` layers (large line/polygon
 * datasets ingested into DuckDB spatial — see server/lib/geometry_spatial.py).
 * Instead of fetching one whole-GeoJSON blob, these layers fetch only the
 * features inside the current map bounds, at a zoom-appropriate simplification,
 * with optional per-category zoom gating.
 *
 * Usage:
 *   const refetchViewport = useSpatialViewportLayers({
 *     layers, visibility, localStyle,
 *     onGeo: (layerId, featureCollection) => map.setLayerGeo(layerId, featureCollection),
 *   });
 *   // in the map's debounced moveend handler:
 *   refetchViewport({ w, s, e, n }, zoom);
 *
 * Per-layer viewport config is read from localStyle:
 *   - localStyle[id].categoryMinZoom : { "<category>": minZoom }  (zoom gating)
 *   - localStyle[id].viewportColumns : string[]                   (property pruning)
 * Both are optional; the server applies lean defaults when absent.
 */
import { useCallback, useRef } from 'react';
import { fetchGeometryViewport } from '../lib/loaders.js';

/** True for layer configs backed by a spatial (viewport-served) geometry. */
export function isSpatialLayer(lc) {
  return !!(lc?.geometry?.is_spatial && lc?.geometry?.id != null);
}

export default function useSpatialViewportLayers({ layers, visibility, localStyle, onGeo }) {
  // One AbortController per layer so a fast pan cancels the stale request
  // instead of racing it against the newer one.
  const inflightRef = useRef(new Map()); // layerId -> AbortController

  const refetchViewport = useCallback((bounds, zoom) => {
    if (!bounds || zoom == null) return;
    const { w, s, e, n } = bounds;
    if ([w, s, e, n].some((v) => typeof v !== 'number' || Number.isNaN(v))) return;

    for (const lc of layers || []) {
      if (!isSpatialLayer(lc)) continue;
      if (visibility?.[lc.id] === false) continue;

      const style = localStyle?.[lc.id] || {};
      // "Load whole dataset" mode: fetch the layer's full extent (not just the
      // viewport). Defaults ON for now while the viewport-clipped line render
      // is being sorted out. Panning still re-fires but hits the same full
      // bbox → served from the snapped-bbox cache; only a zoom change refetches
      // (to refine simplification).
      const loadAll = style.spatialLoadAll ?? lc.default_style?.spatialLoadAll ?? true;
      const fullBbox = lc.geometry?.bbox;
      const useFull = loadAll && Array.isArray(fullBbox) && fullBbox.length === 4;
      const bbox = useFull ? fullBbox : [w, s, e, n];
      const cap = useFull ? 200000 : undefined;

      const prev = inflightRef.current.get(lc.id);
      if (prev) prev.abort();
      const ctrl = new AbortController();
      inflightRef.current.set(lc.id, ctrl);

      fetchGeometryViewport(lc.geometry.id, {
        bbox,
        zoom,
        columns: style.viewportColumns,
        categoryMinZoom: style.categoryMinZoom,
        cap,
        signal: ctrl.signal,
      })
        .then((fc) => {
          if (ctrl.signal.aborted) return;
          onGeo?.(lc.id, fc);
          if (fc?.truncated) {
            console.warn(
              `[spatial] layer ${lc.id}: ${fc.count} features in view exceeded cap ${fc.cap}; ` +
              `showing ${fc.features?.length ?? 0}. Zoom in or gate low-value categories.`,
            );
          }
        })
        .catch((err) => {
          if (err?.name === 'AbortError') return;
          console.warn(`[spatial] viewport fetch failed for layer ${lc.id}:`, err);
        })
        .finally(() => {
          if (inflightRef.current.get(lc.id) === ctrl) {
            inflightRef.current.delete(lc.id);
          }
        });
    }
  }, [layers, visibility, localStyle, onGeo]);

  return refetchViewport;
}
