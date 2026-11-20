/**
 * GraphPanel — non-geospatial graph view sibling of MapPanel.
 *
 * Renders a stratified network (e.g. transmission system stacked by
 * voltage class) using deck.gl's OrthographicView so the same layer
 * abstractions, picking, and instanced renderers from the map carry
 * over. Strata are drawn as horizontal bands, edges as straight
 * segments; transformer-style edges that span strata appear as the
 * vertical connectors that drop out of the layout naturally.
 *
 * Clicks publish on the shared ``tooltip`` bus channel using a
 * synthetic ``layerId`` of ``graph:<ext>:<topology>`` so the existing
 * entity-inspector flow keys off them without changes.
 *
 * Phase 1 keeps the renderer simple: ScatterplotLayer for nodes,
 * LineLayer for edges, stratum bands as faint background polygons.
 * The ``deckLayers`` memo is the only deck.gl-specific code; a future
 * three.js/WebXR renderer will replace just that block.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import CircularProgress from '@mui/material/CircularProgress';
import DeckGL from '@deck.gl/react';
import { OrthographicView } from '@deck.gl/core';
import { ScatterplotLayer, LineLayer } from '@deck.gl/layers';

import bus from '../../lib/stateBus.js';
import {
  fetchGraphTopologies,
  fetchGraphTopologyData,
} from '../../lib/loaders.js';

const NODE_RADIUS_PX = 5;
const EDGE_COLOR = [120, 160, 220, 200];
const EDGE_COLOR_INTER = [240, 200, 100, 230];

// Node fill palette indexed by stratum order — purely cosmetic, gives
// the operator a visual cue when the data has voltage groupings without
// imposing a stratified layout.
const NODE_PALETTE = [
  [120, 200, 255, 255],
  [140, 220, 200, 255],
  [240, 200, 100, 255],
  [240, 150, 180, 255],
  [200, 180, 240, 255],
];

function fitInitialView({ width, height, bounds }) {
  if (!bounds || !width || !height) return { target: [0, 0, 0], zoom: 0 };
  const w = Math.max(bounds.maxX - bounds.minX, 1);
  const h = Math.max(bounds.maxY - bounds.minY, 1);
  // OrthographicView: zoom maps to 2^zoom screen-pixels per world unit.
  // Fit bounds with ~15% padding on each side.
  const zoomX = Math.log2((width * 0.85) / w);
  const zoomY = Math.log2((height * 0.85) / h);
  return {
    target: [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, 0],
    zoom: Math.min(zoomX, zoomY),
  };
}

// Single shared view instance so deck.gl doesn't re-create the
// controller on every render.
const ORTHO_VIEW = new OrthographicView({ id: 'ortho', controller: true });

export default function GraphPanel({
  extensions = [],
  scenarioState,
}) {
  const [providers, setProviders] = useState([]); // [{ extName, descriptor }]
  const [selected, setSelected] = useState(null); // { extName, topologyName }
  const [topology, setTopology] = useState(null); // { nodes, edges, strata, bounds }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [viewState, setViewState] = useState({ target: [0, 0, 0], zoom: 0 });

  const canvasRef = useRef(null);

  // Discover providers from the extension manifest list.
  useEffect(() => {
    let cancelled = false;
    const graphExts = (extensions || []).filter(
      (e) => e?.capabilities?.includes('graph_provider'),
    );
    if (graphExts.length === 0) {
      setProviders([]);
      setSelected(null);
      return undefined;
    }
    (async () => {
      const collected = [];
      for (const ext of graphExts) {
        try {
          const list = await fetchGraphTopologies(ext.name, {
            project: scenarioState?.project,
            scenario: scenarioState?.scenario,
          });
          for (const d of list) collected.push({ extName: ext.name, descriptor: d });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[GraphPanel] ${ext.name} list failed:`, e);
        }
      }
      if (cancelled) return;
      setProviders(collected);
      setSelected((prev) => {
        if (prev && collected.some(
          (p) => p.extName === prev.extName && p.descriptor.name === prev.topologyName,
        )) return prev;
        const first = collected[0];
        return first ? { extName: first.extName, topologyName: first.descriptor.name } : null;
      });
    })();
    return () => { cancelled = true; };
  }, [extensions, scenarioState?.project, scenarioState?.scenario]);

  // Fetch the selected topology.
  useEffect(() => {
    if (!selected) { setTopology(null); return undefined; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchGraphTopologyData(selected.extName, selected.topologyName, {
      project: scenarioState?.project,
      scenario: scenarioState?.scenario,
    }).then((data) => {
      if (cancelled) return;
      setTopology(data);
      // Reset view on topology change. The canvas dimensions live on
      // canvasRef so we don't need a separate size-tracking state.
      const el = canvasRef.current;
      if (el) {
        setViewState(fitInitialView({
          width: el.clientWidth,
          height: el.clientHeight,
          bounds: data?.bounds,
        }));
      }
    }).catch((e) => {
      if (cancelled) return;
      setError(String(e?.message || e));
      setTopology(null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [selected, scenarioState?.project, scenarioState?.scenario]);

  // Re-fit on container resize.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      if (!topology?.bounds) return;
      setViewState(fitInitialView({
        width: el.clientWidth,
        height: el.clientHeight,
        bounds: topology.bounds,
      }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [topology]);

  const nodeById = useMemo(() => {
    const m = new Map();
    for (const n of topology?.nodes || []) m.set(n.id, n);
    return m;
  }, [topology]);

  // Build a stratum → palette index map so nodes inherit a stable tint
  // by voltage class (or whatever stratum the extension uses). Order is
  // the extension's declared ``GraphStratum.order`` if strata exist,
  // otherwise the discovery order from the node list.
  const stratumColor = useMemo(() => {
    if (!topology) return null;
    const out = new Map();
    const declared = (topology.strata || [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    declared.forEach((s, i) => {
      out.set(s.id, NODE_PALETTE[i % NODE_PALETTE.length]);
    });
    // Fall back: any stratum mentioned by a node but not declared.
    let next = declared.length;
    for (const n of topology.nodes || []) {
      if (n.stratum != null && !out.has(n.stratum)) {
        out.set(n.stratum, NODE_PALETTE[next % NODE_PALETTE.length]);
        next += 1;
      }
    }
    return out;
  }, [topology]);

  const deckLayers = useMemo(() => {
    if (!topology) return [];
    return [
      new LineLayer({
        id: 'graph-edges',
        data: topology.edges || [],
        pickable: true,
        getSourcePosition: (e) => {
          const s = nodeById.get(e.source);
          return s ? [s.x, s.y] : [0, 0];
        },
        getTargetPosition: (e) => {
          const t = nodeById.get(e.target);
          return t ? [t.x, t.y] : [0, 0];
        },
        getColor: (e) => (e.is_inter_stratum ? EDGE_COLOR_INTER : EDGE_COLOR),
        getWidth: 1.5,
        widthUnits: 'pixels',
      }),
      new ScatterplotLayer({
        id: 'graph-nodes',
        data: topology.nodes || [],
        pickable: true,
        getPosition: (n) => [n.x, n.y],
        getRadius: NODE_RADIUS_PX,
        radiusUnits: 'pixels',
        getFillColor: (n) => (
          (n.stratum != null && stratumColor?.get(n.stratum))
          || [230, 230, 250, 255]
        ),
        getLineColor: [255, 255, 255, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 1.2,
        stroked: true,
      }),
    ];
  }, [topology, nodeById, stratumColor]);

  const handleClick = useCallback((info) => {
    if (!info?.object || !selected) return;
    const obj = info.object;
    const isNode = info.layer?.id === 'graph-nodes';
    const entityId = isNode ? obj.id : null;
    bus.publish('tooltip', {
      layerId: `graph:${selected.extName}:${selected.topologyName}`,
      entityId,
      feature: {
        type: 'Feature',
        properties: { ...(obj.attrs || {}), id: obj.id, label: obj.label, kind: obj.kind },
        graph: { kind: isNode ? 'node' : 'edge', payload: obj },
      },
      coordinate: { x: info.x, y: info.y, lng: null, lat: null },
      trigger: 'click',
      content: ['infocard', 'timeseries'],
      sourceTabId: bus.getTabId(),
    });
  }, [selected]);

  return (
    <Box sx={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 1,
        px: 1, py: 0.5, borderBottom: 1, borderColor: 'divider', flexShrink: 0,
      }}>
        {providers.length > 0 ? (
          <Select
            size="small"
            value={selected ? `${selected.extName}::${selected.topologyName}` : ''}
            onChange={(e) => {
              const [extName, topologyName] = e.target.value.split('::');
              setSelected({ extName, topologyName });
            }}
            variant="outlined"
            sx={{ fontSize: 12, height: 28, minWidth: 220, '& .MuiSelect-select': { py: 0.5, px: 1 } }}
          >
            {providers.map((p) => (
              <MenuItem
                key={`${p.extName}::${p.descriptor.name}`}
                value={`${p.extName}::${p.descriptor.name}`}
                sx={{ fontSize: 12 }}
              >
                {p.descriptor.display_name || p.descriptor.name}
              </MenuItem>
            ))}
          </Select>
        ) : (
          <Typography variant="caption" color="text.secondary">
            No graph providers — install an extension that declares <code>graph_provider</code>.
          </Typography>
        )}
        {loading && <CircularProgress size={14} />}
        {error && <Typography variant="caption" color="error">{error}</Typography>}
        {topology && !loading && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto', pr: 1 }}>
            {topology.nodes?.length || 0} nodes · {topology.edges?.length || 0} edges
          </Typography>
        )}
      </Box>
      {/* Canvas wrapper. position:relative so DeckGL's absolute canvas
          fits to it; the explicit min-height makes sure it has size
          even before topology data arrives. */}
      <Box
        ref={canvasRef}
        sx={{
          flex: 1,
          minHeight: 200,
          position: 'relative',
          background: '#0d1117',
          overflow: 'hidden',
        }}
      >
        {topology && (
          <DeckGL
            views={ORTHO_VIEW}
            viewState={viewState}
            controller
            onViewStateChange={(p) => setViewState(p.viewState)}
            layers={deckLayers}
            onClick={handleClick}
            getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
            style={{ position: 'absolute', inset: 0 }}
          />
        )}
        {!topology && !loading && providers.length > 0 && (
          <Box sx={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Typography variant="caption" color="text.secondary">
              Select a topology to render
            </Typography>
          </Box>
        )}
        {providers.length === 0 && (
          <Box sx={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            textAlign: 'center', px: 2,
          }}>
            <Typography variant="caption" color="text.secondary">
              No extensions declare <code>graph_provider</code> for this project.
              <br />
              Restart the server to pick up the built-in demo extension if it
              was just added.
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
