import React, { useState, useRef } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Stack from '@mui/material/Stack';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import Divider from '@mui/material/Divider';
import Draggable from 'react-draggable';

const COLORMAPS = ['viridis', 'plasma', 'coolwarm', 'rdylgn'];

/**
 * QuickStylePanel — A floating, draggable, resizable panel that shows
 * simplified layer styling controls for each layer in the active extension.
 *
 * Controls per layer: visibility toggle, opacity slider, colormap selector,
 * domain range (min/max).
 */
export default function QuickStylePanel({
  layers,
  visibility,
  localStyles,
  onVisibilityChange,
  onLocalStyleChange,
  onStyleMappingChange,
  onClose,
}) {
  const [panelSize, setPanelSize] = useState({ width: 320, height: 400 });
  const nodeRef = useRef(null);

  function onResizePointerDown(e) {
    e.stopPropagation();
    e.target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = panelSize.width;
    const startH = panelSize.height;
    function onMove(ev) {
      setPanelSize({
        width: Math.max(260, startW + (ev.clientX - startX)),
        height: Math.max(200, startH + (ev.clientY - startY)),
      });
    }
    function onUp() {
      e.target.removeEventListener('pointermove', onMove);
      e.target.removeEventListener('pointerup', onUp);
    }
    e.target.addEventListener('pointermove', onMove);
    e.target.addEventListener('pointerup', onUp);
  }

  return (
    <Draggable handle=".qs-drag-handle" cancel=".qs-no-drag" nodeRef={nodeRef}>
      <Paper
        ref={nodeRef}
        elevation={8}
        sx={{
          position: 'fixed',
          top: 80,
          right: 24,
          width: panelSize.width,
          height: panelSize.height,
          zIndex: 1300,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 2,
        }}
      >
        {/* Header */}
        <Stack
          className="qs-drag-handle"
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          sx={{
            px: 1.5, py: 0.75,
            cursor: 'grab',
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            flexShrink: 0,
          }}
        >
          <Typography variant="subtitle1" fontWeight={600}>Layer Styling</Typography>
          <IconButton size="small" onClick={onClose} sx={{ color: 'inherit' }} className="qs-no-drag">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        {/* Scrollable body */}
        <Box className="qs-no-drag" sx={{ flex: 1, overflowY: 'auto', p: 1.5 }}>
          {layers.map((layer, idx) => (
            <LayerQuickControls
              key={layer.id}
              layer={layer}
              visible={visibility[layer.id] !== false}
              localStyle={localStyles[layer.id] ?? {}}
              onVisibilityChange={(v) => onVisibilityChange(layer.id, v)}
              onLocalStyleChange={(s) => onLocalStyleChange(layer.id, s)}
              onStyleMappingChange={(mappings) => onStyleMappingChange(layer.id, mappings)}
              showDivider={idx < layers.length - 1}
            />
          ))}
        </Box>

        {/* Resize grip */}
        <Box
          className="qs-no-drag"
          onPointerDown={onResizePointerDown}
          sx={{
            position: 'absolute', bottom: 0, right: 0,
            width: 16, height: 16, cursor: 'nwse-resize',
            opacity: 0.3, '&:hover': { opacity: 0.7 },
            '&::after': {
              content: '""', position: 'absolute', bottom: 3, right: 3,
              width: 0, height: 0, borderStyle: 'solid',
              borderWidth: '0 0 8px 8px',
              borderColor: 'transparent transparent currentColor transparent',
            },
          }}
        />
      </Paper>
    </Draggable>
  );
}

function LayerQuickControls({
  layer, visible, localStyle,
  onVisibilityChange, onLocalStyleChange, onStyleMappingChange,
  showDivider,
}) {
  const opacity = localStyle.opacity ?? 0.8;

  // Find the first color style mapping to expose colormap/domain controls
  const colorMapping = (layer.style_mappings ?? []).find(
    (m) => m.visual_property === 'getFillColor' || m.visual_property === 'getLineColor'
  );
  const overrides = localStyle.mappingOverrides ?? {};
  const ovr = colorMapping ? (overrides[colorMapping.id] ?? {}) : {};

  function updateOverride(updates) {
    if (!colorMapping) return;
    const newOvr = { ...ovr, ...updates };
    onLocalStyleChange({
      ...localStyle,
      mappingOverrides: { ...overrides, [colorMapping.id]: newOvr },
    });
  }

  const colormap = ovr.colormap ?? colorMapping?.colormap ?? 'viridis';
  const domainMin = ovr.domain_min ?? colorMapping?.domain_min ?? 0;
  const domainMax = ovr.domain_max ?? colorMapping?.domain_max ?? 1;

  return (
    <Box sx={{ mb: showDivider ? 1 : 0 }}>
      {/* Layer name + visibility */}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="body2" fontWeight={600} noWrap sx={{ flex: 1 }}>
          {layer.display_name ?? layer.name}
        </Typography>
        <Switch
          size="small"
          checked={visible}
          onChange={(e) => {
            const show = e.target.checked;
            onVisibilityChange(show);
            // When showing a layer that has an active filter with no categories
            // (i.e. filtering everything out), disable the filter so features appear.
            // When hiding, re-enable the empty filter to restore the initial state.
            if (localStyle.filterEnabled && (localStyle.filterCategories ?? []).length === 0) {
              onLocalStyleChange({
                ...localStyle,
                filterEnabled: !show,
              });
            }
          }}
        />
      </Stack>

      {visible && (
        <Box sx={{ pl: 0.5, mt: 0.5 }}>
          {/* Opacity */}
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
            <Typography variant="caption" sx={{ minWidth: 50 }}>Opacity</Typography>
            <Slider
              size="small"
              value={opacity}
              min={0} max={1} step={0.01}
              onChange={(_, v) => onLocalStyleChange({ ...localStyle, opacity: v })}
              sx={{ flex: 1 }}
            />
            <Typography variant="caption" sx={{ minWidth: 28, textAlign: 'right' }}>
              {opacity.toFixed(2)}
            </Typography>
          </Stack>

          {/* Colormap + domain (only if a color mapping exists) */}
          {colorMapping && (
            <>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Typography variant="caption" sx={{ minWidth: 50 }}>Colors</Typography>
                <FormControl size="small" fullWidth>
                  <Select
                    value={colormap}
                    onChange={(e) => updateOverride({ colormap: e.target.value })}
                    sx={{ fontSize: '0.75rem', '& .MuiSelect-select': { py: 0.5 } }}
                  >
                    {COLORMAPS.map((c) => (
                      <MenuItem key={c} value={c}>
                        <Typography variant="caption">{c}</Typography>
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Stack>

              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Typography variant="caption" sx={{ minWidth: 50 }}>Range</Typography>
                <Slider
                  size="small"
                  value={[domainMin, domainMax]}
                  min={colorMapping?.domain_min ?? 0}
                  max={colorMapping?.domain_max ?? 1}
                  onChange={(_, v) => updateOverride({ domain_min: v[0], domain_max: v[1] })}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0)}
                  sx={{ flex: 1 }}
                />
              </Stack>
            </>
          )}
        </Box>
      )}

      {showDivider && <Divider sx={{ mt: 1 }} />}
    </Box>
  );
}
