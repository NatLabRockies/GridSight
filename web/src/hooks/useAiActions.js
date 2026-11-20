import { useCallback } from 'react';
import { updatePerspective } from '../lib/loaders.js';

// AI-chat-driven handlers extracted from App.jsx. Bodies are moved
// VERBATIM — `useCallback` dep arrays are preserved as-is.
export function useAiActions({
  map,
  layout,
  ui,
  versions,
  updateScenarioState,
  handleDatasetsInvalidated,
  handleApplyPerspective,
  captureLiveStateRef,
}) {
  // ── AI-driven input control change ──────────────────────────────────────
  const handleAIInputControlChanged = useCallback((extName, controlName, value, invalidatedDatasets) => {
    console.log('[App] AI changed input control:', extName, controlName, '=', value);
    if (invalidatedDatasets.length > 0) {
      handleDatasetsInvalidated(extName, invalidatedDatasets);
    }
    // Bump refresh key so InputControlPanel re-fetches and slider syncs
    versions.bumpInputControl();
  }, [handleDatasetsInvalidated]);

  // ── AI-driven layer style change ────────────────────────────────────────
  // Upsert: updates the matching style mapping, or appends it when the agent
  // just CREATED a new one (style_layer) that isn't in the layer's config yet.
  const handleAILayerStyleChanged = useCallback((layerId, updatedMapping) => {
    console.log('[App] AI changed layer style:', layerId, updatedMapping);
    // A dataset mapping is a DB row; without its id there is nothing to upsert
    // against and nothing the styler's delete button can target. Appending one
    // anyway is what produced the undeletable "Point Radius ← dataset" row.
    // Refuse rather than inventing an entry keyed on undefined.
    if (updatedMapping?.style_id == null) {
      console.warn(
        '[App] ignoring style mapping with no style_id for layer', layerId, updatedMapping,
      );
      return;
    }
    map.setConfigs((prev) =>
      prev.map((lc) => {
        if (lc.id !== layerId) return lc;
        const existing = lc.style_mappings || [];
        const has = existing.some((sm) => sm.id === updatedMapping.style_id);
        const newMappings = has
          ? existing.map((sm) =>
              sm.id === updatedMapping.style_id ? { ...sm, ...updatedMapping } : sm)
          : [...existing, { ...updatedMapping, id: updatedMapping.style_id }];
        return { ...lc, style_mappings: newMappings };
      }),
    );
  }, [map]);

  // ── AI-driven geometry-property styling (geoMapping) ─────────────────────
  // For layers styled by a feature property (e.g. an uploaded shapefile's
  // voltage), the mapping lives in localStyle.geoMappings, not the DB
  // style_mappings. Merge the single visual_property in without clobbering
  // any other geoMappings the layer already has.
  const handleAILayerGeoMappingChanged = useCallback((layerId, visualProperty, mapping, stylePatch) => {
    console.log('[App] AI set layer geoMapping:', layerId, visualProperty, mapping, stylePatch);
    // Merge inside the reducer rather than reading map.state here. Styling a
    // layer usually takes two calls in a row (size, then colour); reading
    // state in this closure meant both saw the same pre-state and the second
    // clobbered the first's geoMapping, so the layer ended up sized OR
    // coloured and the assistant reported doing both.
    map.patchLayerGeoMapping(layerId, visualProperty, mapping, stylePatch || {});
  }, [map]);

  // ── AI-driven layer visibility toggle ────────────────────────────────────
  const handleAILayerVisibilityChanged = useCallback((layerId, visible) => {
    console.log('[App] AI toggled layer visibility:', layerId, visible);
    map.setLayerVisibility(layerId, visible);
  }, [map]);

  // ── AI-driven cross-layer interaction config ────────────────────────────
  const handleAICrossLayerConfig = useCallback((sourceLayerName, actions) => {
    console.log('[App] AI configured cross-layer interaction:', sourceLayerName, actions);
    const source = map.state.configs.find((c) => c.name === sourceLayerName);
    if (!source) {
      console.warn('[App] Source layer not found:', sourceLayerName);
      return;
    }
    const cur = map.state.localStyle[source.id] || {};
    map.setLayerStyle(source.id, {
      ...cur,
      interaction: {
        ...(cur.interaction || {}),
        clickContent: [],
        crossLayerActions: actions,
      },
    });
  }, [map]);

  // AI variant — same flow; the AI tool already created the row server-side
  // (via the create_perspective tool) but didn't capture state yet, so the
  // first apply will bring back whatever the AI saved (likely empty for now).
  const handleAIApplyPerspective = useCallback((perspectiveId /*, config */) => {
    handleApplyPerspective(perspectiveId);
  }, [handleApplyPerspective]);

  const handleAICreatePerspective = useCallback(async (perspectiveId, name) => {
    // The AI tool created the row with an empty config; capture the live
    // view state and PATCH it back so re-applying the perspective restores
    // what the user is looking at right now.
    try {
      const capture = captureLiveStateRef.current;
      const blob = capture ? capture() : null;
      if (blob) {
        await updatePerspective(perspectiveId, { config: blob });
      }
    } catch (e) {
      console.warn('[App] handleAICreatePerspective capture failed:', e);
    }
    layout.setActivePerspective(perspectiveId);
  }, [layout]);

  // ── AI-driven story playback ────────────────────────────────────────────
  // Story-channel sync + panel auto-open live further down, after the
  // activeStory/activePerspective useState declarations.
  const handleAIApplyStory = useCallback((storyId) => {
    console.log('[App] AI playing story:', storyId);
    layout.setActiveStory(storyId);
  }, [layout]);

  // ── AI-driven scenario switch ───────────────────────────────────────────
  const handleAISwitchScenario = useCallback((extension, project, scenario) => {
    console.log('[App] AI switching scenario:', extension, project, scenario);
    ui.setExpandedExt(extension);
    updateScenarioState({ project, scenario });
  }, [ui]);

  // ── AI-driven hover/click chart attachment ───────────────────────────────
  const handleAIHoverChart = useCallback((config) => {
    console.log('[App] AI attached hover chart to layer:', config.layer_name);
    const layer = map.state.configs.find((c) => c.name === config.layer_name);
    if (!layer) {
      console.warn('[App] Layer not found for hover chart:', config.layer_name);
      return;
    }
    const cur = map.state.localStyle[layer.id] || {};
    map.setLayerStyle(layer.id, {
      ...cur,
      interaction: {
        ...(cur.interaction || {}),
        hoverChart: {
          sql_template: config.sql_template,
          chart_type: config.chart_type,
          x_column: config.x_column,
          y_column: config.y_column,
          title_template: config.title_template,
          trigger: config.trigger,
          color_column: config.color_column,
        },
      },
    });
  }, [map]);

  return {
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
  };
}
