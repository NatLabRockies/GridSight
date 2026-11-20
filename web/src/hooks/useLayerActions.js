import { useCallback } from 'react';
import { TimeseriesBuffer } from '../lib/TimeseriesBuffer.js';
import {
  fetchAllLayers,
  fetchDatasetData,
  invalidateCachePrefix,
} from '../lib/loaders.js';
import { buildDataIndex } from '../lib/layer_generators.js';

// Layer-data mutation handlers extracted from App.jsx. Bodies are moved
// VERBATIM — only the surrounding closure changed. `useCallback` deps are
// preserved as-is.
export function useLayerActions({
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
}) {
  const handleAnchorToggle = useCallback((layerId) => {
    map.toggleAnchoredLayer(layerId);
  }, [map]);

  const handleChartAnchorToggle = useCallback((chartId) => {
    map.toggleAnchoredChart(chartId);
  }, [map]);

  function handleGenericLayerVisibilityChange(layerId, visible) {
    map.setLayerVisibility(layerId, visible);
  }

  function handleGenericLayerLocalStyleChange(layerId, style) {
    const prev = map.state.localStyle;
    // Group-broadcast: if this layer is part of a UI group (e.g. GAT's
    // thermal+renewable share group_key="…__generation"), apply the
    // same style update to every member so the styler popover edits
    // both at once. Member-specific keys that mustn't propagate
    // (group_role, group_role_label, default_visible) are preserved
    // per-layer by merging *over* each existing entry rather than
    // copying `style` verbatim.
    const groupKey = prev[layerId]?.group_key ?? style?.group_key;
    if (!groupKey) {
      map.setLayerStyle(layerId, style);
      return;
    }
    const next = { ...prev };
    for (const id of Object.keys(prev)) {
      if (prev[id]?.group_key === groupKey) {
        next[id] = {
          ...prev[id],
          ...style,
          // Preserve identity fields each member uses to render its own
          // sub-toggle chip and deck.gl layer.
          group_role: prev[id]?.group_role,
          group_role_label: prev[id]?.group_role_label,
        };
      }
    }
    map.replaceLocalStyleMap(next);
  }

  // Optimistic update when a style mapping is added or deleted via GenericLayerStyler.
  function handleGenericLayerStyleMappingChange(layerId, newMappings) {
    map.setConfigs((prev) =>
      prev.map((lc) => (lc.id === layerId ? { ...lc, style_mappings: newMappings } : lc)),
    );
  }

  function handleGenericLayerDeleted(layerId) {
    map.removeLayer(layerId);
    layerToDatasetsRef.current.delete(layerId);
  }

  // When a new layer is created (quick-layer, associate tab, etc.), re-fetch all layers
  async function handleGenericLayerAdded() {
    try {
      const allLayers = await fetchAllLayers();
      if (!Array.isArray(allLayers)) return;
      const filtered = filterLayersByExtensions(allLayers, extensions);
      const existingIds = new Set(map.state.configs.map(lc => lc.id));
      const newLayers = filtered.filter(l => !existingIds.has(l.id));
      if (newLayers.length > 0) {
        await bootstrapLayers(newLayers, { replace: false });
      }
    } catch (e) {
      console.error('[App] handleGenericLayerAdded error:', e);
    }
  }

  const handleDatasetsInvalidated = useCallback((extensionName, datasetNames) => {
    console.log('[App] datasets invalidated:', extensionName, datasetNames);
    console.log('[App] genericLayerConfigs count:', map.state.configs.length);
    const nameSet = new Set(datasetNames);
    let matched = false;
    for (const lc of map.state.configs) {
      // API responses use `source_extension`; user-created layers may use
      // `extension_name`. Match on either so dataset invalidation actually
      // reaches the layers that need refreshing.
      const lcExt = lc.source_extension || lc.extension_name;
      console.log('[App] checking layer:', lc.id, 'ext:', lcExt);
      if (lcExt !== extensionName) continue;
      for (const ld of lc.layer_datasets ?? []) {
        if (!ld.dataset) continue;
        const dsMatchName = ld.dataset.extension_ref || ld.dataset.name;
        console.log('[App] checking dataset:', dsMatchName, 'vs', [...nameSet], 'id:', ld.dataset.id);
        if (!nameSet.has(dsMatchName)) continue;
        matched = true;
        console.log('[App] MATCHED — refreshing dataset', ld.dataset.id, 'for layer', lc.id);

        if (ld.dataset.timestamp_col) {
          // Timeseries dataset: re-init the buffer
          const dsId = ld.dataset.id;
          timeseriesBuffersRef.current.delete(dsId);
          const buf = new TimeseriesBuffer(dsId, ld.dataset.timestamp_col);
          buf.init()
            .then((b) => {
              timeseriesBuffersRef.current.set(dsId, b);
              if (b.getDataAtIndex(clockState.index ?? 0)) {
                versions.bumpTs();
              }
            })
            .catch((e) => console.warn(`[App] buffer re-init failed for dataset ${dsId}:`, e));
        } else {
          // Static dataset: re-fetch and rebuild data index
          fetchDatasetData(ld.dataset.id)
            .then((rows) => {
              const joinKey = ld.data_join_key ?? ld.dataset.join_key;
              if (joinKey) {
                map.setLayerData(lc.id, buildDataIndex(rows, joinKey));
                // Auto-rescale the colormap to the new value range so
                // sector/carrier flips don't leave bars stuck at the top
                // or bottom of the previous domain.
                autoRescaleColormap(lc, rows);
                // Bump so deck.gl's updateTriggers change for this layer's
                // accessors — without this, fillColor stays cached from the
                // first fetch even though dataIndex was replaced.
                versions.bumpStatic();
              }
            })
            .catch((e) => console.warn(`[App] static dataset re-fetch failed for ${ld.dataset.id}:`, e));
        }
      }
    }

    if (!matched) console.warn('[App] NO layers matched for invalidation!');

    // Refresh any active charts that depend on the invalidated datasets
    // Pass the extension too: a chart built from custom SQL depends on TABLES
    // (ext_demand_tldr.forecast), while invalidation names DATASETS
    // (county-view), so name matching alone can never connect them.
    chartDAG.refreshCharts(datasetNames, extensionName);

    // Entity-popup charts (ScenarioChartBody via EntityInteractionManager)
    // bypass chartDAG. Drop their caches and bump the refresh key so the
    // EntityInteractionManager re-fetches chart specs — extensions that bake
    // current control state into the spec name will get new specs, which
    // then triggers ScenarioChartBody's useEffect to re-fetch chart data.
    invalidateCachePrefix('ext-charts:');
    invalidateCachePrefix('chart-data:');
    versions.bumpInputControl();
  }, [map.state.configs, clockState.index, chartDAG]);

  // ── Layer actions from input controls (filter, show, hide, fly_to_bounds) ──
  const handleLayerActions = useCallback((actions) => {
    if (!actions?.length) return;
    for (const act of actions) {
      if (act.action === 'filter' && act.targetLayerName) {
        const target = map.state.configs.find((c) => c.name === act.targetLayerName);
        if (target) {
          map.patchLayerStyle(target.id, {
            filterEnabled: true,
            filterProperty: act.filterProperty,
            filterCategories: [String(act.filterValue ?? act.sourceValue ?? '')],
          });
        }
      } else if (act.action === 'clear_filter' && act.targetLayerName) {
        const target = map.state.configs.find((c) => c.name === act.targetLayerName);
        if (target) {
          map.patchLayerStyle(target.id, {
            filterEnabled: false,
            filterCategories: [],
          });
        }
      } else if (act.action === 'show' && act.targetLayerName) {
        const target = map.state.configs.find((c) => c.name === act.targetLayerName);
        if (target) map.setLayerVisibility(target.id, true);
      } else if (act.action === 'hide' && act.targetLayerName) {
        const target = map.state.configs.find((c) => c.name === act.targetLayerName);
        if (target) map.setLayerVisibility(target.id, false);
      }
    }
  }, [map]);

  return {
    handleAnchorToggle,
    handleChartAnchorToggle,
    handleGenericLayerVisibilityChange,
    handleGenericLayerLocalStyleChange,
    handleGenericLayerStyleMappingChange,
    handleGenericLayerDeleted,
    handleGenericLayerAdded,
    handleDatasetsInvalidated,
    handleLayerActions,
  };
}
