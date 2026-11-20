/**
 * LineageNode — custom React Flow node for lineage DAG visualization.
 *
 * Displays node type icon, label, review status badge, version count,
 * and AI model attribution chip.
 */
import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import StorageIcon from '@mui/icons-material/Storage';
import CodeIcon from '@mui/icons-material/Code';
import TableChartIcon from '@mui/icons-material/TableChart';
import BarChartIcon from '@mui/icons-material/BarChart';
import MonitorIcon from '@mui/icons-material/Monitor';
import { useTheme } from '@mui/material/styles';

const NODE_TYPE_ICONS = {
  data_source: StorageIcon,
  transform: CodeIcon,
  result: TableChartIcon,
  viz_config: BarChartIcon,
  output: MonitorIcon,
};

const REVIEW_COLORS = {
  unreviewed: '#666',
  ai_reviewed: '#9c27b0',
  human_reviewed: '#4caf50',
  ai_and_human_reviewed: '#2196f3',
};

const REVIEW_LABELS = {
  unreviewed: 'Unreviewed',
  ai_reviewed: 'AI Reviewed',
  human_reviewed: 'Human Reviewed',
  ai_and_human_reviewed: 'AI + Human Reviewed',
};

function LineageNodeComponent({ data, selected }) {
  const theme = useTheme();
  const Icon = NODE_TYPE_ICONS[data.node_type] || StorageIcon;
  const reviewColor = REVIEW_COLORS[data.review_status] || REVIEW_COLORS.unreviewed;
  const reviewLabel = REVIEW_LABELS[data.review_status] || 'Unreviewed';

  return (
    <>
      <Handle type="target" position={Position.Top} style={{ background: '#555' }} />
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderRadius: 1.5,
          border: selected ? `2px solid ${theme.palette.primary.main}` : '1px solid rgba(255,255,255,0.12)',
          bgcolor: theme.palette.background.paper,
          color: theme.palette.text.primary,
          minWidth: 180,
          maxWidth: 220,
          cursor: 'pointer',
          '&:hover': { borderColor: theme.palette.primary.main },
        }}
      >
        {/* Header row: icon + label */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
          <Icon sx={{ fontSize: 16, color: theme.palette.primary.main }} />
          <Typography
            variant="caption"
            sx={{
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}
          >
            {data.label || data.node_type}
          </Typography>
        </Box>

        {/* Bottom row: review badge, version, AI model */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <Tooltip title={reviewLabel} placement="top">
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: reviewColor,
                flexShrink: 0,
              }}
            />
          </Tooltip>

          {data.version > 1 && (
            <Chip
              label={`v${data.version}`}
              size="small"
              sx={{ height: 16, fontSize: 10, bgcolor: 'rgba(255,255,255,0.08)' }}
            />
          )}

          {data.ai_model && (
            <Chip
              label={data.ai_model.split('/').pop().slice(0, 16)}
              size="small"
              sx={{ height: 16, fontSize: 10, bgcolor: 'rgba(156,39,176,0.15)', color: '#ce93d8' }}
            />
          )}

          {data.creator_type === 'user' && (
            <Chip
              label="user"
              size="small"
              sx={{ height: 16, fontSize: 10, bgcolor: 'rgba(76,175,80,0.15)', color: '#81c784' }}
            />
          )}

          {/* Reviewer avatars */}
          {data.reviews?.length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.25, ml: 'auto' }}>
              {data.reviews.slice(0, 3).map((r, i) => (
                <Tooltip key={i} title={`${r.reviewer_type}: ${r.status}`}>
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      bgcolor: r.reviewer_type === 'ai' ? '#9c27b0' : '#4caf50',
                      fontSize: 8,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#fff',
                      fontWeight: 700,
                    }}
                  >
                    {r.reviewer_type === 'ai' ? 'A' : 'H'}
                  </Box>
                </Tooltip>
              ))}
            </Box>
          )}

          {/* Pending review indicator */}
          {data.pending_requests > 0 && (
            <Tooltip title={`${data.pending_requests} pending review(s)`}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  bgcolor: '#ff9800',
                  animation: 'pulse 1.5s ease-in-out infinite',
                  '@keyframes pulse': {
                    '0%, 100%': { opacity: 1 },
                    '50%': { opacity: 0.4 },
                  },
                }}
              />
            </Tooltip>
          )}
        </Box>
      </Box>
      <Handle type="source" position={Position.Bottom} style={{ background: '#555' }} />
    </>
  );
}

export default memo(LineageNodeComponent);
