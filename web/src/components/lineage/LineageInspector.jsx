/**
 * LineageInspector — side panel that shows details for a selected lineage node.
 *
 * Displays content (SQL, config, data source info), provenance metadata,
 * review history, and allows requesting reviews.
 */
import React, { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import Button from '@mui/material/Button';
import { useTheme } from '@mui/material/styles';
import { fetchLineageNodeReviews, addLineageReview } from '../../lib/loaders';

const NODE_TYPE_LABELS = {
  data_source: 'Data Source',
  transform: 'Transform',
  result: 'Result',
  viz_config: 'Viz Config',
  output: 'Output',
};

const TRANSFORM_KIND_LABELS = {
  sql_manual: 'Manual SQL',
  sql_ai: 'AI SQL Query',
  input_control: 'Input Control',
  data_control: 'Data Control',
};

export default function LineageInspector({ node, onClose }) {
  const theme = useTheme();
  const [reviews, setReviews] = useState([]);

  useEffect(() => {
    if (node?.id) {
      fetchLineageNodeReviews(node.id).then(setReviews).catch(() => setReviews([]));
    }
  }, [node?.id]);

  if (!node) return null;

  const content = (() => {
    try {
      return typeof node.content_json === 'string'
        ? JSON.parse(node.content_json)
        : node.content_json || {};
    } catch {
      return {};
    }
  })();

  const handleApprove = async () => {
    try {
      await addLineageReview(node.id, {
        reviewer_type: 'human',
        status: 'approved',
        comment: 'Approved via LineageInspector',
      });
      const updated = await fetchLineageNodeReviews(node.id);
      setReviews(updated);
    } catch (e) {
      console.error('Failed to add review:', e);
    }
  };

  return (
    <Box
      sx={{
        width: 360,
        height: '100%',
        bgcolor: theme.palette.background.paper,
        borderLeft: `1px solid ${theme.palette.divider}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Box sx={{ p: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {NODE_TYPE_LABELS[node.node_type] || node.node_type}
        </Typography>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      <Divider />

      {/* Content */}
      <Box sx={{ flex: 1, overflow: 'auto', p: 1.5 }}>
        {/* Label */}
        <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
          {node.label}
        </Typography>

        {/* Metadata chips */}
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1.5 }}>
          {node.creator_type && (
            <Chip label={`Creator: ${node.creator_type}`} size="small" variant="outlined" />
          )}
          {node.ai_model && (
            <Chip label={node.ai_model} size="small" sx={{ bgcolor: 'rgba(156,39,176,0.15)', color: '#ce93d8' }} />
          )}
          {node.extension_name && (
            <Chip label={`ext: ${node.extension_name}`} size="small" variant="outlined" />
          )}
          {node.transform_kind && (
            <Chip
              label={TRANSFORM_KIND_LABELS[node.transform_kind] || node.transform_kind}
              size="small"
              color="info"
              variant="outlined"
            />
          )}
          <Chip label={`v${node.version || 1}`} size="small" variant="outlined" />
        </Box>

        {/* Timestamps */}
        {node.created_at && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Created: {new Date(node.created_at).toLocaleString()}
          </Typography>
        )}
        {node.updated_at && node.updated_at !== node.created_at && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Updated: {new Date(node.updated_at).toLocaleString()}
          </Typography>
        )}

        <Divider sx={{ my: 1 }} />

        {/* Content details */}
        <Typography variant="caption" sx={{ fontWeight: 700, mb: 0.5, display: 'block' }}>
          Content
        </Typography>

        {/* SQL content */}
        {content.sql && (
          <Box
            sx={{
              bgcolor: 'rgba(0,0,0,0.3)',
              borderRadius: 1,
              p: 1,
              mb: 1,
              fontFamily: 'monospace',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxHeight: 200,
              overflow: 'auto',
              color: theme.palette.text.secondary,
            }}
          >
            {content.sql}
          </Box>
        )}

        {/* Control change details */}
        {content.control_name && (
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Control: <strong>{content.control_name}</strong>
            </Typography>
            {content.old_value !== undefined && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {String(content.old_value)} → {String(content.new_value)}
              </Typography>
            )}
            {content.new_value !== undefined && !content.old_value && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                Value: {String(content.new_value)}
              </Typography>
            )}
          </Box>
        )}

        {/* Data source details */}
        {content.table_name && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Table: <code>{content.table_name}</code>
          </Typography>
        )}
        {content.source_type && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Source type: {content.source_type}
          </Typography>
        )}

        {/* Chart/viz config */}
        {content.chart_type && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Chart type: {content.chart_type}
          </Typography>
        )}
        {content.tier && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Tier: {content.tier}
          </Typography>
        )}

        {/* Row count */}
        {content.row_count != null && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            Rows: {content.row_count.toLocaleString()}
          </Typography>
        )}

        {/* Generic JSON fallback for any other content */}
        {!content.sql && !content.control_name && !content.table_name && !content.chart_type && Object.keys(content).length > 0 && (
          <Box
            sx={{
              bgcolor: 'rgba(0,0,0,0.3)',
              borderRadius: 1,
              p: 1,
              fontFamily: 'monospace',
              fontSize: 11,
              whiteSpace: 'pre-wrap',
              maxHeight: 200,
              overflow: 'auto',
              color: theme.palette.text.secondary,
            }}
          >
            {JSON.stringify(content, null, 2)}
          </Box>
        )}

        {/* Reviews section */}
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="caption" sx={{ fontWeight: 700, mb: 0.5, display: 'block' }}>
          Reviews ({reviews.length})
        </Typography>

        {reviews.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            No reviews yet.
          </Typography>
        ) : (
          reviews.map((r, i) => (
            <Box
              key={i}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                mb: 0.5,
                p: 0.5,
                borderRadius: 0.5,
                bgcolor: 'rgba(255,255,255,0.03)',
              }}
            >
              <Box
                sx={{
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  bgcolor: r.reviewer_type === 'ai' ? '#9c27b0' : '#4caf50',
                  fontSize: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {r.reviewer_type === 'ai' ? 'A' : 'H'}
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  {r.status}
                </Typography>
                {r.ai_model && (
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                    ({r.ai_model})
                  </Typography>
                )}
                {r.comment && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {r.comment}
                  </Typography>
                )}
              </Box>
            </Box>
          ))
        )}

        {/* Approve button */}
        <Box sx={{ mt: 1.5 }}>
          <Button size="small" variant="outlined" color="success" onClick={handleApprove}>
            Approve
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
