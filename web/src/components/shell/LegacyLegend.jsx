import React from "react";
import Box from "@mui/material/Box";
import Draggable from "react-draggable";
import ColorMapLegend from "../controllers/ColorMapLegend.jsx";

/**
 * Legacy single legend popup (e.g. "Line Loading %") — opened from the
 * styler popover via onPopoutLegend. Lives outside the LegendPanel because
 * it predates the unified panel.
 *
 * Rendering is gated by `mapLegend != null` from caller.
 *
 * Future: style_mappings carry an optional `shared_legend_group` string
 * populated by extensions. When set on multiple layers, those layers are
 * intended to render under a unified legend with a merged domain. v1
 * relies on extensions declaring matching colormap + domain_min/max so a
 * per-layer legend visually aligns; merge-aware rendering lands later.
 *
 * Self-contained: all DOM/ref bookkeeping for the collapse-and-restore
 * position dance is owned by App.jsx via the supplied refs and callbacks
 * (kept as-is — no behavior change).
 */
export default function LegacyLegend({
  mapLegend,
  legendCollapsed,
  legendBottomOffset,
  legendNodeRef,
  legendPosRef,
  legendSavedPosRef,
  mapConfigs,
  mapLocalStyle,
  setLayerStyle,
  setMapLegend,
  setLegendCollapsed,
}) {
  if (!mapLegend) return null;
  return (
    <Draggable
      handle=".legend-drag-handle"
      cancel=".legend-no-drag"
      bounds="body"
      nodeRef={legendNodeRef}
      onStop={(e, data) => {
        legendPosRef.current = { x: data.x, y: data.y };
      }}
    >
      <Box ref={legendNodeRef} sx={{
        position: 'fixed',
        // Dodge the bottom ChartDock like the main LegendPanel does —
        // this legacy single-legend ("Line Loading %") otherwise covers
        // the right edge of the dock.
        bottom: 48 + legendBottomOffset, right: 320,
        zIndex: 1400,
      }}>
        <ColorMapLegend
          colormap={mapLegend.colormap}
          domainMin={mapLegend.domainMin}
          domainMax={mapLegend.domainMax}
          categoryColors={mapLegend.categoryColors}
          categories={mapLegend.categories}
          label={mapLegend.label}
          draggable
          collapsed={legendCollapsed}
          onCollapsedChange={(c) => {
            const node = legendNodeRef.current;
            if (c) {
              legendSavedPosRef.current = { ...legendPosRef.current };
              if (node) node.style.transform = 'translate(0px, 0px)';
              legendPosRef.current = { x: 0, y: 0 };
            } else {
              let { x, y } = legendSavedPosRef.current;
              if (node) {
                const rect = node.getBoundingClientRect();
                if (rect.left + x < 0) x = -rect.left;
                if (rect.top + y < 0) y = -rect.top;
                node.style.transform = `translate(${x}px, ${y}px)`;
              }
              legendPosRef.current = { x, y };
            }
            setLegendCollapsed(c);
          }}
          onClose={() => {
            let closeLayerId = mapLegend?.layerId;
            if (!closeLayerId && mapLegend?.label) {
              for (const lc of mapConfigs) {
                const ls = mapLocalStyle[lc.id] ?? {};
                const gm = ls.geoMappings ?? {};
                for (const [, mapping] of Object.entries(gm)) {
                  if (mapping.property === mapLegend.label) { closeLayerId = lc.id; break; }
                }
                if (closeLayerId) break;
              }
            }
            if (closeLayerId) {
              const ls = mapLocalStyle[closeLayerId] ?? {};
              setLayerStyle(closeLayerId, { ...ls, filterEnabled: false, filterProperty: null, filterCategories: [] });
            }
            setMapLegend(null);
          }}
          onFilterChange={({ enabledCategories, hoverCategory }) => {
            // Resolve layerId: use explicit value, or fallback by matching label to layer geo mappings
            let legendLayerId = mapLegend?.layerId;
            let legendFilterProp = mapLegend?.filterProperty;
            if (!legendLayerId && mapLegend?.label) {
              for (const lc of mapConfigs) {
                const ls = mapLocalStyle[lc.id] ?? {};
                const gm = ls.geoMappings ?? {};
                for (const [, mapping] of Object.entries(gm)) {
                  if (mapping.property === mapLegend.label) {
                    legendLayerId = lc.id;
                    legendFilterProp = mapping.property;
                    break;
                  }
                }
                if (legendLayerId) break;
              }
            }
            if (!legendLayerId || !legendFilterProp) return;
            const ls = mapLocalStyle[legendLayerId] ?? {};
            if (!enabledCategories && !hoverCategory) {
              setLayerStyle(legendLayerId, { ...ls, filterEnabled: false, filterProperty: null, filterCategories: [] });
            } else {
              let visible;
              if (hoverCategory) {
                // Hover always isolates the single category, regardless of enabled/disabled
                visible = [hoverCategory];
              } else {
                visible = enabledCategories ? [...enabledCategories] : [];
              }
              setLayerStyle(legendLayerId, {
                ...ls,
                filterEnabled: true,
                filterProperty: legendFilterProp,
                filterCategories: visible,
              });
            }
          }}
        />
      </Box>
    </Draggable>
  );
}
