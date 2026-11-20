import React, { useRef, useState } from 'react';
import Paper from '@mui/material/Paper';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import PushPinIcon from '@mui/icons-material/PushPin';
import LockIcon from '@mui/icons-material/Lock';
import LockOpenIcon from '@mui/icons-material/LockOpen';
import Tooltip from '@mui/material/Tooltip';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import ChartTabs from './ChartTabs.jsx';

/**
 * ChartFloatingPanel — draggable floating chart over the map.
 *
 * Uses ChartTabs for the tabbed Chart | JSON | Data | SQL | DAG view.
 */
export default function ChartFloatingPanel({ chart, onClose, onPinToTray, anchored = false, onAnchorToggle, webgpu = false }) {
  const panelRef = useRef(null);
  const posRef = useRef({ x: 300, y: 120 });
  const theme = useTheme();
  const panel = theme.custom?.panel ?? {};

  const plotlySpec = chart?.plotlySpec;
  const spec = chart?.spec;
  const title = spec?.title || 'Chart';

  function onDragPointerDown(e) {
    e.preventDefault();
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
        panelRef.current.style.left = `${posRef.current.x}px`;
        panelRef.current.style.top = `${posRef.current.y}px`;
      }
    }
    function onUp(ev) {
      e.target.releasePointerCapture(ev.pointerId);
      e.target.removeEventListener('pointermove', onMove);
      e.target.removeEventListener('pointerup', onUp);
    }
    e.target.addEventListener('pointermove', onMove);
    e.target.addEventListener('pointerup', onUp);
  }

  return (
    <Paper
      ref={panelRef}
      elevation={12}
      sx={{
        position: 'fixed',
        left: posRef.current.x,
        top: posRef.current.y,
        zIndex: 1400,
        minWidth: 540,
        maxWidth: '90vw',
        maxHeight: '80vh',
        overflow: 'auto',
        width: 'auto',
        p: 1.5,
        bgcolor: panel.bgcolor,
        backdropFilter: panel.backdropFilter,
        border: panel.border,
        color: panel.color,
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Box
            onPointerDown={onDragPointerDown}
            sx={{ cursor: 'grab', display: 'flex', alignItems: 'center', color: panel.dragHandleColor }}
          >
            <DragIndicatorIcon fontSize="small" />
          </Box>
          <Typography variant="subtitle2" noWrap sx={{ maxWidth: 350 }}>
            {title}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 0.25 }}>
          {onAnchorToggle && (
            <Tooltip title={anchored ? "Unlock chart (allow AI changes)" : "Lock chart (prevent AI changes)"}>
              <IconButton size="small" onClick={() => onAnchorToggle(chart.id)} sx={{ color: anchored ? 'warning.main' : panel.closeBtnColor }}>
                {anchored ? <LockIcon fontSize="small" /> : <LockOpenIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          )}
          {onPinToTray && (
            <Tooltip title="Pin to chart tray">
              <IconButton size="small" onClick={() => onPinToTray(chart.id)} sx={{ color: panel.closeBtnColor }}>
                <PushPinIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <IconButton size="small" onClick={onClose} sx={{ color: panel.closeBtnColor }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      </Box>
      <ChartTabs plotlySpec={plotlySpec} chart={chart} width={500} height={360} webgpu={webgpu} />
    </Paper>
  );
}
