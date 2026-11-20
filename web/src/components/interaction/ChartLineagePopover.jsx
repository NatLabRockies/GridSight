import React from 'react';
import Popover from '@mui/material/Popover';
import { zoomAnchorProps } from '../../lib/zoomAnchor.js';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import TuneIcon from '@mui/icons-material/Tune';
import StorageIcon from '@mui/icons-material/Storage';
import CodeIcon from '@mui/icons-material/Code';
import BarChartIcon from '@mui/icons-material/BarChart';

/**
 * ChartLineagePopover — shows a mini lineage DAG for a chart.
 *
 * Built purely from frontend state (no server round-trip).
 * Shows: Input Control → Dataset(s) → SQL Transform → Chart
 */
export default function ChartLineagePopover({ anchorEl, open, onClose, chart }) {
  if (!chart) return null;

  const spec = chart.spec || {};
  const datasets = chart.datasets || [];
  const sql = spec.sql || '';

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      {...zoomAnchorProps(anchorEl, { vertical: 'bottom', horizontal: 'left' })}
      slotProps={{
        paper: {
          sx: { p: 2, maxWidth: 340, bgcolor: 'grey.900' },
        },
      }}
    >
      <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
        Chart Lineage
      </Typography>

      {/* Input Control Node */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <TuneIcon sx={{ fontSize: 16, color: 'info.main' }} />
        <Chip label="Input Control" size="small" variant="outlined" color="info" />
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'center', my: 0.5 }}>
        <ArrowDownwardIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
      </Box>

      {/* Dataset Nodes */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5, flexWrap: 'wrap' }}>
        <StorageIcon sx={{ fontSize: 16, color: 'success.main' }} />
        {datasets.length > 0 ? (
          datasets.map((ds) => (
            <Chip key={ds} label={ds} size="small" variant="outlined" color="success" sx={{ fontSize: 11 }} />
          ))
        ) : (
          <Chip label="Unknown dataset" size="small" variant="outlined" />
        )}
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'center', my: 0.5 }}>
        <ArrowDownwardIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
      </Box>

      {/* SQL Transform Node */}
      <Box sx={{ mb: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
          <CodeIcon sx={{ fontSize: 16, color: 'warning.main' }} />
          <Chip label="SQL Transform" size="small" variant="outlined" color="warning" />
          <Chip label={chart.source === 'ai' ? 'AI' : 'Extension'} size="small" sx={{ fontSize: 10 }} />
        </Box>
        {sql && (
          <Box
            sx={{
              bgcolor: 'grey.800',
              borderRadius: 1,
              p: 1,
              fontSize: 11,
              fontFamily: 'monospace',
              maxHeight: 100,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              color: 'text.secondary',
            }}
          >
            {sql}
          </Box>
        )}
      </Box>

      <Box sx={{ display: 'flex', justifyContent: 'center', my: 0.5 }}>
        <ArrowDownwardIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
      </Box>

      {/* Chart Output Node */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <BarChartIcon sx={{ fontSize: 16, color: 'primary.main' }} />
        <Chip
          label={spec.title || spec.chart_type || 'Chart'}
          size="small"
          variant="outlined"
          color="primary"
        />
      </Box>
    </Popover>
  );
}
