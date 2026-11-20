/**
 * LayerControlPanel — registered panel that hosts the full LayerFactory
 * styling UI. Reuses the same component the sidebar uses, so the command
 * tab gets visibility toggles, opacity, colormaps, categorical mappings,
 * and everything else without code duplication.
 *
 * Works in two modes:
 *   - **Inline** (App.jsx passes its live genericLayerConfigs): full data,
 *     full callbacks, identical to the sidebar view.
 *   - **Popped-out** (ChartTrayApp passes the bus-synced catalog): the
 *     catalog and visibility/style state come over the 'layers:*' sync
 *     channels, and the server API is used directly for style-mapping
 *     mutations (both tabs are equally authorized).
 *
 * The underlying GenericLayerStyler needs `geoData` and `layerData` to
 * compute categorical suggestions and value ranges. Neither is synced
 * over the bus (too heavy) — in a popped-out tab those props are empty
 * and the UI degrades: you still see the layer list, the toggle, the
 * colormap/opacity controls, and any already-configured mappings.
 */

import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CircularProgress from '@mui/material/CircularProgress';

import LayerFactory from '../controllers/Layers.jsx';
import { fetchScenarioLayers } from '../../lib/loaders.js';

const NOOP = () => {};

export default function LayerControlPanel({
  layers,                     // pre-supplied by App.jsx, or null in popouts
  scenarioState,
  visibility,
  localStyle,
  onToggleVisibility,
  onLocalStyleChange,
  onStyleMappingsChange,      // LayerFactory passes (layerId, newMappings)
}) {
  // Fallback fetch when both `layers` and the bus-synced catalog are
  // missing (rare — only if the command tab mounts before the main tab
  // publishes). Keyed on scenarioState so it re-runs when that arrives.
  const [fetchedLayers, setFetchedLayers] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (layers && layers.length > 0) { setFetchedLayers(null); return; }
    const project = scenarioState?.project;
    const scenario = scenarioState?.scenario;
    if (!project || !scenario) { setFetchedLayers(null); return; }
    let cancelled = false;
    setLoading(true);
    fetchScenarioLayers(project, scenario)
      .then((list) => { if (!cancelled) setFetchedLayers(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setFetchedLayers([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [layers, scenarioState?.project, scenarioState?.scenario]);

  const effectiveLayers = (layers && layers.length > 0) ? layers : (fetchedLayers ?? []);

  // LayerFactory calls these with (layerId, value). Forward as-is to the
  // host; the host owns the state and the bus sync. For a popped-out
  // tab, the host's wiring pushes every change onto the 'layers:*'
  // channels, so the main tab sees the update in real time.
  const handleVisibility = useCallback((layerId, visible) => {
    onToggleVisibility?.(layerId, visible);
  }, [onToggleVisibility]);
  const handleLocalStyle = useCallback((layerId, next) => {
    onLocalStyleChange?.(layerId, next);
  }, [onLocalStyleChange]);
  const handleMapping = useCallback((layerId, newMappings) => {
    onStyleMappingsChange?.(layerId, newMappings);
  }, [onStyleMappingsChange]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (effectiveLayers.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', p: 1 }}>
        <Typography variant="caption" color="text.secondary">No layers to control.</Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ width: '100%', height: '100%', overflowY: 'auto' }}>
      <LayerFactory
        embedded
        scenarioProp={scenarioState}
        genericLayers={effectiveLayers}
        genericLayerVisibility={visibility || {}}
        genericLayerLocalStyle={localStyle || {}}
        onGenericLayerVisibilityChange={handleVisibility}
        onGenericLayerLocalStyleChange={handleLocalStyle}
        onGenericLayerStyleMappingChange={handleMapping}
        onGenericLayerDeleted={NOOP}
        onGenericLayerAdded={NOOP}
        genericLayerGeo={{}}
        genericLayerData={{}}
        onAskAI={NOOP}
        onPopoutLegend={NOOP}
        onQuickStyleOpen={NOOP}
        anchoredLayers={new Set()}
        onAnchorToggle={NOOP}
      />
    </Box>
  );
}
