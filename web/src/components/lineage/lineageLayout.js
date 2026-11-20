/**
 * lineageLayout.js — dagre-based automatic layout for lineage DAGs.
 *
 * Takes a list of nodes and edges from the lineage API and produces
 * React Flow-compatible positioned nodes and edges.
 */
import dagre from 'dagre';

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

/**
 * Apply dagre layout to a set of nodes and edges.
 *
 * @param {{ id, node_type, label }[]} nodes - Lineage nodes from the API
 * @param {{ parent_node_id, child_node_id, edge_type }[]} edges - Lineage edges
 * @param {'TB'|'LR'} direction - Layout direction (top-to-bottom or left-to-right)
 * @returns {{ nodes: object[], edges: object[] }} React Flow nodes and edges
 */
export function layoutDAG(nodes, edges, direction = 'TB') {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 40, ranksep: 60, marginx: 20, marginy: 20 });

  for (const node of nodes) {
    g.setNode(String(node.id), { width: NODE_WIDTH, height: NODE_HEIGHT });
  }

  for (const edge of edges) {
    g.setEdge(String(edge.parent_node_id), String(edge.child_node_id));
  }

  dagre.layout(g);

  const rfNodes = nodes.map((node) => {
    const pos = g.node(String(node.id));
    return {
      id: String(node.id),
      type: 'lineageNode',
      position: {
        x: pos.x - NODE_WIDTH / 2,
        y: pos.y - NODE_HEIGHT / 2,
      },
      data: { ...node },
    };
  });

  const rfEdges = edges.map((edge, i) => ({
    id: `e-${edge.parent_node_id}-${edge.child_node_id}-${i}`,
    source: String(edge.parent_node_id),
    target: String(edge.child_node_id),
    label: edge.edge_type === 'derives_from' ? '' : edge.edge_type?.replace('_', ' '),
    animated: edge.edge_type === 'derives_from',
    style: { stroke: edgeColor(edge.edge_type) },
    markerEnd: { type: 'arrowclosed', color: edgeColor(edge.edge_type) },
  }));

  return { nodes: rfNodes, edges: rfEdges };
}

function edgeColor(edgeType) {
  switch (edgeType) {
    case 'derives_from': return '#4fc3f7';
    case 'configured_by': return '#ffb74d';
    case 'renders': return '#66bb6a';
    default: return '#888';
  }
}

export { NODE_WIDTH, NODE_HEIGHT };
