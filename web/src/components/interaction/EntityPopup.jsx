import React, { useEffect, useRef } from 'react';
import Paper from '@mui/material/Paper';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';

/**
 * EntityPopup — inline popup pinned to a map coordinate (screen-space).
 *
 * @param {{
 *   x: number,
 *   y: number,
 *   onDismiss: () => void,
 *   persistent: boolean,
 *   children: React.ReactNode,
 * }} props
 */
export default function EntityPopup({ x, y, onDismiss, persistent = false, children }) {
  const ref = useRef(null);
  const theme = useTheme();
  const panel = theme.custom?.panel ?? {};

  // Dismiss on Escape
  useEffect(() => {
    if (!persistent) return;
    function onKey(e) {
      if (e.key === 'Escape') onDismiss?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [persistent, onDismiss]);

  // Smart edge avoidance: flip the popup if it would go off-screen
  const popupWidth = 420;
  const popupMaxHeight = Math.min(window.innerHeight * 0.8, 700);
  const margin = 12;

  const left = x + popupWidth + margin > window.innerWidth
    ? Math.max(margin, x - popupWidth - margin)
    : x + margin;
  const top = y + popupMaxHeight + margin > window.innerHeight
    ? Math.max(margin, window.innerHeight - popupMaxHeight - margin)
    : y + margin;

  return (
    <Paper
      ref={ref}
      elevation={8}
      sx={{
        position: 'fixed',
        left,
        top,
        zIndex: 1400,
        maxWidth: popupWidth,
        maxHeight: popupMaxHeight,
        overflow: 'auto',
        p: 1.5,
        bgcolor: panel.bgcolor,
        backdropFilter: panel.backdropFilter,
        border: panel.border,
        color: panel.color,
        pointerEvents: 'auto',
      }}
    >
      {persistent && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: -0.5, mr: -0.5 }}>
          <IconButton size="small" onClick={onDismiss} sx={{ color: panel.closeBtnColor }}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Box>
      )}
      {children}
    </Paper>
  );
}
