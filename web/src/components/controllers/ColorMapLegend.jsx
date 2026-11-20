import React, { useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';

// Colormap RGB stops (same data as layer_generators.js)
const COLORMAP_STOPS = {
  viridis: [
    [68,1,84],[72,40,120],[62,74,137],[49,104,142],[38,130,142],
    [31,158,137],[53,183,121],[109,205,89],[180,222,44],[253,231,37],
  ],
  plasma: [
    [13,8,135],[75,3,161],[125,3,168],[168,34,150],[203,70,121],
    [229,107,93],[248,148,65],[253,195,40],[240,249,33],[240,249,33],
  ],
  coolwarm: [
    [59,76,192],[90,113,228],[134,156,249],[181,197,254],[214,220,255],
    [255,255,255],[255,220,198],[249,168,130],[228,111,84],[192,59,59],
  ],
  rdylgn: [
    [165,0,38],[215,48,39],[244,109,67],[253,174,97],[254,224,139],
    [255,255,191],[217,239,139],[166,217,106],[102,189,99],[26,152,80],
  ],
  loading: [
    [46,125,50],[76,175,80],[139,195,74],[255,235,59],[255,152,0],[244,67,54],[183,28,28],
  ],
};

function buildGradient(colormap) {
  const stops = COLORMAP_STOPS[colormap] ?? COLORMAP_STOPS.viridis;
  const css = stops
    .map((rgb, i) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${Math.round((i / (stops.length - 1)) * 100)}%`)
    .join(', ');
  return `linear-gradient(to right, ${css})`;
}

/**
 * Format a numeric legend value for display.
 * - Integers or large numbers (>=1): no decimals
 * - Small decimals (0 < |x| < 1): up to 3 significant digits
 * - Very small numbers: scientific notation
 */
function formatLegendValue(v) {
  if (v == null) return '0';
  if (typeof v !== 'number') return String(v);
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return v.toLocaleString(undefined, { maximumFractionDigits: 0, notation: 'compact' });
  if (abs >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 0.001) return v.toPrecision(3);
  return v.toExponential(2);
}

/**
 * ColorMapLegend — floating overlay with interactive filtering.
 *
 * Categorical mode:
 *   - Click a swatch to permanently toggle that category on/off
 *   - Hover a swatch to temporarily isolate that category
 *   - Calls onFilterChange({ enabledCategories, hoverCategory }) on interaction
 *
 * Props:
 *   colormap / domainMin / domainMax – continuous mode
 *   categoryColors – { name: [r,g,b,a] } for categorical mode
 *   categories     – string[] ordered list of all category values
 *   label          – legend title
 *   draggable      – enables drag handle styling
 *   onClose        – dismiss handler
 *   onFilterChange – ({ enabledCategories: Set|null, hoverCategory: string|null }) => void
 */
export default function ColorMapLegend({
  colormap, domainMin, domainMax, label,
  categoryColors, categories,
  onClose, draggable, onFilterChange,
  collapsed = false, onCollapsedChange,
}) {
  const isCategorical = categoryColors && Object.keys(categoryColors).length > 0;
  const categoryList = categories ?? Object.keys(categoryColors ?? {});

  // Track which categories are enabled (null = all enabled)
  const [disabledSet, setDisabledSet] = useState(new Set());
  const [hoverCat, setHoverCat] = useState(null);

  const emitFilter = useCallback((disabled, hover) => {
    if (!onFilterChange) return;
    const allEnabled = disabled.size === 0 && hover == null;
    if (allEnabled) {
      onFilterChange({ enabledCategories: null, hoverCategory: null });
    } else {
      // Build enabled set: all categories minus disabled, or just hover if hovering
      const enabled = new Set(
        categoryList.filter(c => !disabled.has(c))
      );
      onFilterChange({ enabledCategories: enabled, hoverCategory: hover });
    }
  }, [onFilterChange, categoryList]);

  function handleClick(name) {
    setDisabledSet(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      emitFilter(next, hoverCat);
      return next;
    });
  }

  function handleMouseEnter(name) {
    setHoverCat(name);
    emitFilter(disabledSet, name);
  }

  function handleMouseLeave() {
    setHoverCat(null);
    emitFilter(disabledSet, null);
  }

  return (
    <Box
      className={draggable ? undefined : 'legend-no-drag'}
      sx={{
        bgcolor: 'rgba(20,20,20,0.85)',
        backdropFilter: 'blur(6px)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 1.5,
        minWidth: 180,
        maxWidth: 280,
        boxShadow: 4,
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Header — drag handle */}
      <Box
        className="legend-drag-handle"
        sx={{
          display: 'flex', alignItems: 'center', px: 1.5, py: 0.5,
          cursor: draggable ? 'grab' : 'default',
          '&:active': draggable ? { cursor: 'grabbing' } : {},
        }}
      >
        <Typography variant="caption" sx={{ flex: 1, color: 'text.primary', fontWeight: 600 }}>
          {label || colormap || 'Legend'}
        </Typography>
        <IconButton size="small" onClick={() => onCollapsedChange?.(!collapsed)} sx={{ p: 0.25 }} className="legend-no-drag">
          {collapsed ? <ExpandMoreIcon sx={{ fontSize: 14 }} /> : <ExpandLessIcon sx={{ fontSize: 14 }} />}
        </IconButton>
        <IconButton size="small" onClick={onClose} sx={{ p: 0.25 }} className="legend-no-drag">
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>

      {collapsed ? null : isCategorical ? (
        /* Category swatches — interactive */
        <Box className="legend-no-drag" sx={{ display: 'flex', flexDirection: 'column' }}>
          {/* Select all / Deselect all */}
          <Box sx={{ display: 'flex', gap: 1, px: 1.5, pb: 0.5 }}>
            <Typography
              variant="caption"
              sx={{ cursor: 'pointer', color: 'primary.light', '&:hover': { textDecoration: 'underline' } }}
              onClick={() => {
                setDisabledSet(new Set());
                emitFilter(new Set(), hoverCat);
              }}
            >
              All
            </Typography>
            <Typography
              variant="caption"
              sx={{ cursor: 'pointer', color: 'primary.light', '&:hover': { textDecoration: 'underline' } }}
              onClick={() => {
                const allDisabled = new Set(categoryList);
                setDisabledSet(allDisabled);
                emitFilter(allDisabled, hoverCat);
              }}
            >
              None
            </Typography>
          </Box>
          <Box
            onMouseLeave={handleMouseLeave}
            sx={{ display: 'flex', flexDirection: 'column', gap: 0.1, px: 1.5, pb: 1, maxHeight: 350, overflowY: 'auto' }}
          >
          {categoryList.map(name => {
            const rgba = categoryColors[name];
            const [r, g, b] = Array.isArray(rgba) ? rgba : [128, 128, 128];
            const isDisabled = disabledSet.has(name);
            const isHovered = hoverCat === name;
            const dimmed = hoverCat != null && !isHovered;

            return (
              <Box
                key={name}
                onClick={() => handleClick(name)}
                onMouseEnter={() => handleMouseEnter(name)}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 0.75,
                  py: 0.25, px: 0.5, borderRadius: 0.5,
                  cursor: 'pointer',
                  opacity: isDisabled ? 0.3 : dimmed ? 0.4 : 1,
                  bgcolor: isHovered ? 'rgba(255,255,255,0.08)' : 'transparent',
                  transition: 'opacity 0.15s, background-color 0.15s',
                  '&:hover': { bgcolor: 'rgba(255,255,255,0.08)' },
                }}
              >
                <Box sx={{
                  width: 14, height: 14, borderRadius: 0.5, flexShrink: 0,
                  bgcolor: isDisabled ? 'rgba(80,80,80,0.5)' : `rgb(${r},${g},${b})`,
                  border: '1px solid rgba(255,255,255,0.15)',
                  textDecoration: isDisabled ? 'line-through' : 'none',
                }} />
                <Typography
                  variant="caption"
                  noWrap
                  sx={{
                    color: isDisabled ? 'text.disabled' : 'text.secondary',
                    textDecoration: isDisabled ? 'line-through' : 'none',
                  }}
                >
                  {name}
                </Typography>
              </Box>
            );
          })}
          </Box>
        </Box>
      ) : (
        /* Continuous gradient */
        <Box sx={{ px: 1.5, pb: 1 }}>
          <Box
            sx={{
              height: 14,
              borderRadius: 0.5,
              background: buildGradient(colormap),
              mb: 0.25,
            }}
          />
          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">
              {formatLegendValue(domainMin ?? 0)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {formatLegendValue(domainMax ?? 1)}
            </Typography>
          </Box>
        </Box>
      )}
    </Box>
  );
}
