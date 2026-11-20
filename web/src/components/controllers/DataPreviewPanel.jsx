/**
 * DataPreviewPanel — floating bottom panel that hosts <DataPreview>.
 *
 * Sits docked to the bottom of the viewport at full width so a wide
 * dataset's columns aren't squished into the narrow Data Catalog tray.
 * The panel is resizable vertically (drag handle at the top) and can be
 * dismissed via the X in the header.
 *
 * Mounted by App.jsx whenever `previewSource` is set. The catalog's
 * magnifier button + the (currently dormant) deep-link from the Layers
 * panel both target this single panel — there's only ever one preview
 * open at a time.
 */

import { useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import CloseIcon from '@mui/icons-material/Close';
import DataPreview from './DataPreview.jsx';

const DEFAULT_HEIGHT = 360;
const MIN_HEIGHT = 200;
const MAX_HEIGHT_RATIO = 0.85;

export default function DataPreviewPanel({ source, onClose }) {
  const [panelHeight, setPanelHeight] = useState(DEFAULT_HEIGHT);

  function onResizePointerDown(e) {
    e.stopPropagation();
    e.target.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = panelHeight;
    function onMove(ev) {
      const delta = startY - ev.clientY; // drag up → grow
      const max = window.innerHeight * MAX_HEIGHT_RATIO;
      setPanelHeight(Math.max(MIN_HEIGHT, Math.min(max, startHeight + delta)));
    }
    function onUp(ev) {
      e.target.releasePointerCapture(ev.pointerId);
      e.target.removeEventListener('pointermove', onMove);
      e.target.removeEventListener('pointerup', onUp);
    }
    e.target.addEventListener('pointermove', onMove);
    e.target.addEventListener('pointerup', onUp);
  }

  if (!source) return null;

  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: panelHeight,
        zIndex: 1200,
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
      }}
    >
      {/* Drag-to-resize handle. */}
      <Box
        onPointerDown={onResizePointerDown}
        sx={{
          height: 6,
          cursor: 'ns-resize',
          flexShrink: 0,
          bgcolor: 'divider',
          '&:hover': { bgcolor: 'primary.main', opacity: 0.7 },
        }}
      />
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          px: 2, py: 1,
          borderBottom: 1, borderColor: 'divider',
          bgcolor: 'background.paper',
          flexShrink: 0,
        }}
      >
        <Typography variant="subtitle2" sx={{ flex: 1, minWidth: 0 }} noWrap>
          {source.name}
        </Typography>
        <Chip label={source.type} size="small" sx={{ mr: 1, fontSize: 10, height: 18 }} />
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </Stack>
      <DataPreview source={source} />
    </Box>
  );
}
