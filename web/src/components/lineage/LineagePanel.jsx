/**
 * LineagePanel — top-level DAG viewer for data lineage.
 *
 * Renders a React Flow canvas with dagre-laid-out lineage nodes.
 * Opens as a full-screen overlay / drawer from the sidebar.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
} from 'reactflow';
import 'reactflow/dist/style.css';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import CloseIcon from '@mui/icons-material/Close';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import CircularProgress from '@mui/material/CircularProgress';
import { useTheme } from '@mui/material/styles';

import LineageNodeComponent from './LineageNode';
import LineageInspector from './LineageInspector';
import { layoutDAG } from './lineageLayout';
import { searchLineageNodes, fetchLineageAncestors } from '../../lib/loaders';

const nodeTypes = { lineageNode: LineageNodeComponent };

export default function LineagePanel({ onClose }) {
  const theme = useTheme();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedNode, setSelectedNode] = useState(null);
  const [loading, setLoading] = useState(false);

  // Panel height — resizable via drag handle
  const [panelHeight, setPanelHeight] = useState(400);

  function onResizePointerDown(e) {
    e.stopPropagation();
    e.target.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startHeight = panelHeight;
    function onMove(ev) {
      const delta = startY - ev.clientY; // drag up = taller
      setPanelHeight(Math.max(200, Math.min(window.innerHeight * 0.85, startHeight + delta)));
    }
    function onUp(ev) {
      e.target.releasePointerCapture(ev.pointerId);
      e.target.removeEventListener('pointermove', onMove);
      e.target.removeEventListener('pointerup', onUp);
    }
    e.target.addEventListener('pointermove', onMove);
    e.target.addEventListener('pointerup', onUp);
  }

  // Filters
  const [nodeTypeFilter, setNodeTypeFilter] = useState('');
  const [direction, setDirection] = useState('TB');

  // Load all lineage nodes on mount / filter change
  useEffect(() => {
    setLoading(true);
    const params = {};
    if (nodeTypeFilter) params.node_type = nodeTypeFilter;

    searchLineageNodes(params)
      .then((dag) => {
        const laid = layoutDAG(dag.nodes || [], dag.edges || [], direction);
        setNodes(laid.nodes);
        setEdges(laid.edges);
      })
      .catch((e) => {
        console.error('[LineagePanel] fetch failed:', e);
        setNodes([]);
        setEdges([]);
      })
      .finally(() => setLoading(false));
  }, [nodeTypeFilter, direction]);

  const onNodeClick = useCallback((_event, node) => {
    setSelectedNode(node.data);
  }, []);

  // Focus on a node's ancestors when double-clicked
  const onNodeDoubleClick = useCallback((_event, node) => {
    setLoading(true);
    fetchLineageAncestors(node.data.id)
      .then((dag) => {
        const laid = layoutDAG(dag.nodes || [], dag.edges || [], direction);
        setNodes(laid.nodes);
        setEdges(laid.edges);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [direction]);

  return (
    <Box
      sx={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        height: panelHeight,
        zIndex: 1200,
        display: 'flex',
        bgcolor: theme.palette.background.default,
        boxShadow: '0 -4px 16px rgba(0,0,0,0.4)',
      }}
    >
      {/* Resize handle */}
      <Box
        onPointerDown={onResizePointerDown}
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 6,
          cursor: 'ns-resize',
          zIndex: 1,
          bgcolor: 'divider',
          '&:hover': { bgcolor: 'primary.main', opacity: 0.7 },
        }}
      />
      {/* Main canvas area */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', pt: '6px' }}>
        {/* Toolbar */}
        <Box
          sx={{
            p: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            borderBottom: `1px solid ${theme.palette.divider}`,
            bgcolor: theme.palette.background.paper,
          }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mr: 2 }}>
            Data Lineage
          </Typography>

          <FormControl size="small" sx={{ minWidth: 140 }}>
            <InputLabel>Node Type</InputLabel>
            <Select
              value={nodeTypeFilter}
              label="Node Type"
              onChange={(e) => setNodeTypeFilter(e.target.value)}
            >
              <MenuItem value="">All</MenuItem>
              <MenuItem value="data_source">Data Source</MenuItem>
              <MenuItem value="transform">Transform</MenuItem>
              <MenuItem value="result">Result</MenuItem>
              <MenuItem value="viz_config">Viz Config</MenuItem>
              <MenuItem value="output">Output</MenuItem>
            </Select>
          </FormControl>

          <ToggleButtonGroup
            size="small"
            value={direction}
            exclusive
            onChange={(_, v) => v && setDirection(v)}
          >
            <ToggleButton value="TB">Top-Down</ToggleButton>
            <ToggleButton value="LR">Left-Right</ToggleButton>
          </ToggleButtonGroup>

          {loading && <CircularProgress size={20} />}

          <Box sx={{ flex: 1 }} />
          <IconButton onClick={onClose}>
            <CloseIcon />
          </IconButton>
        </Box>

        {/* React Flow canvas */}
        <Box sx={{ flex: 1, position: 'relative' }}>
          {!loading && nodes.length === 0 && (
            <Box sx={{
              position: 'absolute', inset: 0,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: 1, zIndex: 1, pointerEvents: 'none',
            }}>
              <Typography variant="body1" color="text.secondary">
                No lineage data found.
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 340, textAlign: 'center' }}>
                Lineage is recorded when perspectives are saved or data transformations are run.
              </Typography>
            </Box>
          )}
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            style={{ background: theme.palette.background.default }}
          >
            <Background
              color={theme.palette.mode === 'dark' ? '#333' : '#ccc'}
              gap={20}
            />
            <Controls
              style={{
                button: { backgroundColor: theme.palette.background.paper, color: theme.palette.text.primary },
              }}
            />
            <MiniMap
              nodeColor={(n) => {
                const t = n.data?.node_type;
                if (t === 'data_source') return '#4fc3f7';
                if (t === 'transform') return '#ffb74d';
                if (t === 'result') return '#66bb6a';
                if (t === 'viz_config') return '#ce93d8';
                if (t === 'output') return '#ef5350';
                return '#888';
              }}
              style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
            />
          </ReactFlow>
        </Box>
      </Box>

      {/* Inspector panel */}
      {selectedNode && (
        <LineageInspector
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </Box>
  );
}
