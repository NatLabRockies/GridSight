import React from 'react';
import MuiDrawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';

/**
 * EntityDrawerPanel — MUI Drawer from the right side.
 */
export default function EntityDrawerPanel({ onDismiss, open = true, children }) {
  const theme = useTheme();
  const panel = theme.custom?.panel ?? {};

  return (
    <MuiDrawer
      anchor="right"
      open={open}
      onClose={onDismiss}
      variant="persistent"
      sx={{
        '& .MuiDrawer-paper': {
          width: 400,
          bgcolor: panel.bgcolor,
          color: panel.color,
          p: 2,
          pt: 8,
        },
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
        <IconButton size="small" onClick={onDismiss} sx={{ color: panel.closeBtnColor }}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {children}
    </MuiDrawer>
  );
}
