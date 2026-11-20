/**
 * LegendPanel — auto-shows stacked legends for all visible layers.
 *
 * Derives legend configs from layer style_mappings + local overrides.
 * Each layer with a color mapping gets a legend entry.
 * Categorical legends retain click-to-filter behavior.
 * Draggable and resizable.
 */

import React, { useMemo, useState, useCallback, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import Tooltip from '@mui/material/Tooltip';
import ColorMapLegend from './ColorMapLegend.jsx';
import { formatFieldLabel } from '../../lib/formatFieldLabel.js';

/**
 * Build legend configs from visible layers and their style mappings.
 *
 * Also synthesizes an entry for TransmissionLayer visibility since that
 * layer type colors lines by a calculated "Line Loading %" (flow / capacity)
 * rather than a declarative style_mapping — without this synthesis it would
 * show no legend despite being visually driven by a colormap.
 */
function deriveLegends(layerConfigs, visibility, localStyles) {
  const legends = [];
  for (const lc of layerConfigs) {
    if (visibility[lc.id] === false) continue;
    const ls = localStyles[lc.id] ?? {};
    const overrides = ls.styleOverrides ?? {};

    // TransmissionLayer — synthesize a Line Loading (%) legend entry.
    if (lc.deck_layer_type === 'TransmissionLayer') {
      legends.push({
        layerId: lc.id,
        layerName: lc.display_name || lc.name,
        filterProperty: 'loading_pct',
        label: 'Line Loading (%)',
        colormap: 'loading',
        domainMin: 0,
        domainMax: 100,
        type: 'continuous',
      });
    }

    for (const sm of lc.style_mappings ?? []) {
      // Only color mappings produce legends
      if (sm.visual_property !== 'fill_color' && sm.visual_property !== 'get_color'
          && sm.visual_property !== 'getColor' && sm.visual_property !== 'getFillColor') continue;

      const ovr = overrides[sm.id] ?? {};
      const stype = ovr.scale_type ?? sm.scale_type;
      const col = ovr.column ?? sm.column;

      if (stype === 'categorical') {
        const catColors = ovr.categoryColors ?? {};
        if (Object.keys(catColors).length === 0) continue;
        legends.push({
          layerId: lc.id,
          layerName: lc.display_name || lc.name,
          filterProperty: col,
          label: formatFieldLabel(col),
          categoryColors: catColors,
          categories: Object.keys(catColors),
          type: 'categorical',
        });
        continue;
      } else {
        const cmap = ovr.colormap ?? sm.colormap ?? 'viridis';
        const dMin = ovr.domain_min ?? sm.domain_min ?? 0;
        const dMax = ovr.domain_max ?? sm.domain_max ?? 1;
        legends.push({
          layerId: lc.id,
          layerName: lc.display_name || lc.name,
          filterProperty: col,
          label: formatFieldLabel(col),
          colormap: cmap,
          domainMin: dMin,
          domainMax: dMax,
          type: 'continuous',
        });
      }
    }

    // geoMappings-based categorical legend. Geometry-only layers (e.g. user
    // point layers from create_point_layer) carry their color rule in
    // geoMappings rather than a DB style_mapping. Prefer the live localStyle
    // override; fall back to the layer's default_style.geoMappings so the
    // legend auto-appears even when a layer arrives via the merge path
    // (reload-layers) that hasn't bootstrapped localStyle yet.
    const gm = ls.geoMappings ?? lc.default_style?.geoMappings ?? {};
    for (const vp of ['getFillColor', 'getColor']) {
      const m = gm[vp];
      if (!m || m.scale_type !== 'categorical') continue;
      const catColors = m.categoryColors ?? {};
      if (Object.keys(catColors).length === 0) continue;
      legends.push({
        layerId: lc.id,
        layerName: lc.display_name || lc.name,
        filterProperty: m.property,
        label: m.label ?? (m.property === '__category' ? 'Category' : formatFieldLabel(m.property)),
        categoryColors: catColors,
        categories: Object.keys(catColors),
        type: 'categorical',
      });
    }
  }
  // Collapse aliased/duplicate entries: a layer often carries the same color
  // rule under both getFillColor and getColor (e.g. an agent set both), which
  // would otherwise render two identical legend blocks for one layer. Dedupe
  // by (layer, property, type) so each distinct legend shows once.
  const seen = new Set();
  return legends.filter((l) => {
    const key = `${l.layerId}|${l.type}|${l.filterProperty}|${l.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function LegendPanel({
  layerConfigs,
  visibility,
  localStyles,
  onFilterChange,
  bottomOffset = 0,    // room to clear a bottom ChartDock
}) {
  const legends = useMemo(
    () => deriveLegends(layerConfigs, visibility, localStyles),
    [layerConfigs, visibility, localStyles],
  );

  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [collapsedEntries, setCollapsedEntries] = useState(new Set());
  // Pinned = stay open at a fixed spot regardless of hover. Dragging the panel
  // auto-pins it (otherwise it hides the moment the cursor leaves the
  // bottom-right hover zone, and can't be reached at its new position).
  const [pinned, setPinned] = useState(false);
  const panelRef = useRef(null);
  const posRef = useRef({ x: 0, y: 0 });

  const unpin = useCallback(() => {
    setPinned(false);
    posRef.current = { x: 0, y: 0 };
    if (panelRef.current) panelRef.current.style.transform = '';
  }, []);

  const toggleEntry = useCallback((key) => {
    setCollapsedEntries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleDragPointerDown = useCallback((e) => {
    e.preventDefault();
    // Moving it out of the way should keep it there — pin so it no longer
    // depends on hovering the bottom-right zone.
    setPinned(true);
    e.target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = { ...posRef.current };
    function onMove(ev) {
      posRef.current = {
        x: startPos.x + (ev.clientX - startX),
        y: startPos.y + (ev.clientY - startY),
      };
      if (panelRef.current) {
        panelRef.current.style.transform = `translate(${posRef.current.x}px, ${posRef.current.y}px)`;
      }
    }
    function onUp(ev) {
      e.target.releasePointerCapture(ev.pointerId);
      e.target.removeEventListener('pointermove', onMove);
      e.target.removeEventListener('pointerup', onUp);
    }
    e.target.addEventListener('pointermove', onMove);
    e.target.addEventListener('pointerup', onUp);
  }, []);

  if (legends.length === 0) return null;

  // The panel lives inside a fixed hover zone. At rest only a small pill tab
  // is visible; hovering the zone or the panel itself reveals the full panel.
  // This keeps map real-estate uncluttered while the legend stays reachable.
  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 48 + bottomOffset,
        right: 0,
        zIndex: 1400,
        width: 340,
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'flex-end',
        pb: 1,
        // The container never intercepts pointer events, so it can't block a
        // chart being scrubbed in the bottom-right corner. Only the small pill
        // (hover trigger) and the revealed/pinned body are interactive.
        pointerEvents: 'none',
        ...(pinned ? {
          // Pinned: always visible; the inline drag transform positions it.
          '& .legend-panel-body': { opacity: 1, pointerEvents: 'auto' },
        } : {
          '& .legend-panel-body': {
            opacity: 0,
            pointerEvents: 'none',
            transform: 'translateX(12px)',
            transition: 'opacity 0.2s ease, transform 0.2s ease',
          },
          // Reveal only when the pill (small target) or the panel itself is
          // hovered — so it doesn't pop up just because the cursor passed
          // through the bottom-right while working.
          '& .legend-pill:hover ~ .legend-panel-body, & .legend-panel-body:hover': {
            opacity: 1,
            pointerEvents: 'auto',
            transform: 'translateX(0)',
          },
        }),
      }}
    >
      {/* Visible-at-rest pill: the hover trigger (hidden once pinned). */}
      {!pinned && (
        <Box
          className="legend-pill"
          sx={{
            position: 'absolute',
            right: 0,
            bottom: 8,
            width: 6,
            height: Math.min(legends.length * 36 + 12, 120),
            borderRadius: '4px 0 0 4px',
            background: 'linear-gradient(to bottom, rgba(255,255,255,0.25), rgba(255,255,255,0.08))',
            pointerEvents: 'auto',
            cursor: 'pointer',
            // Invisible padding so the user doesn't have to hit a 6px sliver.
            '&::before': {
              content: '""',
              position: 'absolute',
              top: -10,
              bottom: -10,
              right: 0,
              left: -22,
            },
          }}
        />
      )}

      {/* Full panel — revealed on hover, or always shown when pinned */}
      <Box
        className="legend-panel-body"
        ref={panelRef}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 0.5,
          maxHeight: '60vh',
          maxWidth: 300,
          mr: 1.5,
          overflow: 'auto',
        }}
      >
        {/* Drag handle row — minimal, no counter label */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            bgcolor: 'rgba(20,20,20,0.85)',
            backdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 1.5,
            px: 1,
            py: 0.25,
          }}
        >
          <Box
            onPointerDown={handleDragPointerDown}
            sx={{ cursor: 'grab', display: 'flex', alignItems: 'center', '&:active': { cursor: 'grabbing' } }}
          >
            <DragIndicatorIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
          </Box>
          <Typography variant="caption" sx={{ flex: 1, fontWeight: 600, color: 'text.primary' }}>
            Legend
          </Typography>
          <Tooltip title={pinned ? 'Unpin — return to the corner' : 'Pin open'}>
            <IconButton size="small" onClick={() => (pinned ? unpin() : setPinned(true))} sx={{ p: 0.25 }}>
              {pinned ? <PushPinIcon sx={{ fontSize: 14 }} /> : <PushPinOutlinedIcon sx={{ fontSize: 14 }} />}
            </IconButton>
          </Tooltip>
          <IconButton size="small" onClick={() => setPanelCollapsed((p) => !p)} sx={{ p: 0.25 }}>
            {panelCollapsed ? <ExpandMoreIcon sx={{ fontSize: 14 }} /> : <ExpandLessIcon sx={{ fontSize: 14 }} />}
          </IconButton>
        </Box>

        {/* Legend entries */}
        {!panelCollapsed && legends.map((legend) => {
          const key = `${legend.layerId}-${legend.label}`;
          return (
            <Box key={key}>
              <ColorMapLegend
                colormap={legend.colormap}
                domainMin={legend.domainMin}
                domainMax={legend.domainMax}
                categoryColors={legend.categoryColors}
                categories={legend.categories}
                label={`${legend.layerName}: ${legend.label}`}
                collapsed={collapsedEntries.has(key)}
                onCollapsedChange={() => toggleEntry(key)}
                onFilterChange={onFilterChange ? (filter) => onFilterChange(legend.layerId, legend.filterProperty, filter) : undefined}
              />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
