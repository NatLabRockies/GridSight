import React, { useRef, useEffect } from 'react';
import Paper from '@mui/material/Paper';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { useDrag } from '@use-gesture/react';
import { useDisplayScale } from '../../lib/DisplayScaleContext.jsx';

/**
 * EntityFloatingPanel — draggable floating popup for entity-click content.
 *
 * Dragging uses @use-gesture/react so it works with mouse, pen, AND touch
 * (the wall is driven from a tablet) — the previous pointer-capture handler
 * had no touch-action handling and didn't account for the display zoom, so
 * on a scaled display a drag moved the panel by screen pixels in logical-
 * pixel space (jittery / barely-moving). Movement is divided by displayScale
 * to track the finger 1:1, matching ChartFrame.
 */
export default function EntityFloatingPanel({ onDismiss, persistent = true, children }) {
  const panelRef = useRef(null);
  const posRef = useRef({ x: 200, y: 100 });
  const theme = useTheme();
  const panel = theme.custom?.panel ?? {};
  const { scale: displayScale } = useDisplayScale();

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onDismiss?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const bindDrag = useDrag(({ movement: [mx, my], memo, first }) => {
    const base = first ? { ...posRef.current } : memo;
    const x = base.x + mx / displayScale;
    const y = base.y + my / displayScale;
    posRef.current = { x, y };
    if (panelRef.current) {
      panelRef.current.style.left = `${x}px`;
      panelRef.current.style.top = `${y}px`;
    }
    return base;
  }, { filterTaps: true, pointer: { touch: true } });

  return (
    <Paper
      ref={panelRef}
      elevation={12}
      sx={{
        position: 'fixed',
        left: posRef.current.x,
        top: posRef.current.y,
        zIndex: 1400,
        minWidth: 320,
        maxWidth: '90vw',
        maxHeight: '80vh',
        overflow: 'auto',
        p: 1.5,
        bgcolor: panel.bgcolor,
        backdropFilter: panel.backdropFilter,
        border: panel.border,
        color: panel.color,
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 0.5 }}>
        <Box
          {...bindDrag()}
          sx={{ cursor: 'grab', touchAction: 'none', display: 'flex', alignItems: 'center', color: panel.dragHandleColor, '&:active': { cursor: 'grabbing' } }}
        >
          <DragIndicatorIcon fontSize="small" />
        </Box>
        <IconButton size="small" onClick={onDismiss} sx={{ color: panel.closeBtnColor }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {children}
    </Paper>
  );
}
