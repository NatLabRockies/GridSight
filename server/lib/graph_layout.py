"""Default force-directed layout for graph topologies.

Used when an extension declares ``GRAPH_PROVIDER`` but doesn't ship
precomputed (x, y) on every node. Implementation is a vectorized
Fruchterman-Reingold:

  - Repulsive force between every pair of nodes (O(N²) per iter).
  - Attractive force along edges (O(|E|) per iter).
  - Linear cooling schedule over a fixed iteration count.
  - Deterministic initial positions: each node's start is a hash of
    its id, so the layout is reproducible without seeding a global RNG
    and identical topologies always produce identical layouts.

Performance notes:
  - numpy vectorization keeps a Sienna-scale system (~1k buses) under
    1 second on a laptop. CONUS-scale (~50k+ buses) will need Barnes-
    Hut quadtree repulsion; the dense N×N matrix here is the
    bottleneck. That upgrade lives behind the same entry point — the
    function signature is stable so callers don't change.

Anything fancier (Sugiyama, edge-bundling, constraint-based layout)
lives behind the extension override path — the extension supplies its
own coordinates if it has them and this function becomes a no-op.
"""

from __future__ import annotations

import hashlib
import math
from typing import TYPE_CHECKING

import numpy as np

if TYPE_CHECKING:
    from gridsight.extensions.models import GraphTopology

# Output is in arbitrary world units; the frontend orthographic view
# fits the resulting bounds to the viewport on load.
_SCALE = 1000.0
_ITERATIONS = 80
_INITIAL_TEMP = 0.12


def apply_default_layout(topology: GraphTopology) -> None:
    """Fill in (x, y) on any node missing coordinates. Mutates in place.

    No-op if every node already has both x and y — extensions with a
    precomputed layout (their own physical bus coordinates, or a
    domain-specific layout) bypass this entirely.
    """
    nodes = topology.nodes
    if not nodes:
        return
    if all(n.x is not None and n.y is not None for n in nodes):
        return

    n_count = len(nodes)
    idx_by_id = {n.id: i for i, n in enumerate(nodes)}

    # Deterministic initial positions from a hash of each node's id.
    # Splitting the 128-bit md5 into two 32-bit chunks gives independent
    # x/y samples in [-1, 1).
    pos = np.empty((n_count, 2), dtype=np.float64)
    for i, n in enumerate(nodes):
        h = hashlib.md5(n.id.encode("utf-8")).digest()
        xi = int.from_bytes(h[0:4], "big") / 0xFFFFFFFF * 2 - 1
        yi = int.from_bytes(h[4:8], "big") / 0xFFFFFFFF * 2 - 1
        pos[i, 0] = xi
        pos[i, 1] = yi

    # Edge endpoint indices — skip any edge whose endpoints aren't in
    # the node list (lets extensions return slightly inconsistent data
    # without exploding the layout).
    edge_pairs: list[tuple[int, int]] = []
    for e in topology.edges:
        si = idx_by_id.get(e.source)
        ti = idx_by_id.get(e.target)
        if si is None or ti is None or si == ti:
            continue
        edge_pairs.append((si, ti))
    edge_idx = (
        np.array(edge_pairs, dtype=np.int32)
        if edge_pairs
        else np.zeros((0, 2), dtype=np.int32)
    )

    # Fruchterman-Reingold "ideal edge length" parameter — derived from
    # the assumed unit area so the layout naturally fills [-1, 1]² before
    # we scale it up.
    k = math.sqrt(1.0 / max(n_count, 1))
    temp = _INITIAL_TEMP
    cooling = _INITIAL_TEMP / _ITERATIONS

    for _ in range(_ITERATIONS):
        # Repulsion: pairwise (N, N, 2) delta, force ~ k²/d² along the
        # delta direction. Diagonal is zeroed so a node doesn't push
        # itself.
        delta = pos[:, np.newaxis, :] - pos[np.newaxis, :, :]
        dist2 = (delta * delta).sum(axis=2) + 1e-9
        rep = (k * k) / dist2
        np.fill_diagonal(rep, 0.0)
        disp = (delta * rep[:, :, np.newaxis]).sum(axis=1)

        # Attraction along edges: F_attr magnitude = d²/k along the
        # unit vector tgt-src. As a vector that means src pulled by
        # ed*(d/k) where ed = src - tgt; ``-f`` on src moves it toward
        # tgt, ``+f`` on tgt moves it toward src.
        #
        # The earlier version used ``(d / k) / d`` which collapses to
        # ``1/k`` — a constant attraction independent of distance.
        # That made connected components keep pulling together no
        # matter how close they were, producing a single dense blob
        # for any non-trivial graph.
        if len(edge_idx):
            src_pos = pos[edge_idx[:, 0]]
            tgt_pos = pos[edge_idx[:, 1]]
            ed = src_pos - tgt_pos
            d = np.sqrt((ed * ed).sum(axis=1)) + 1e-9
            f = ed * (d / k)[:, np.newaxis]
            np.add.at(disp, edge_idx[:, 0], -f)
            np.add.at(disp, edge_idx[:, 1], f)

        # Step in direction of total displacement, capped by current
        # temperature so the layout settles instead of oscillating.
        mag = np.sqrt((disp * disp).sum(axis=1, keepdims=True)) + 1e-9
        limited = np.minimum(mag, temp)
        pos += disp * (limited / mag)
        temp = max(temp - cooling, 0.0)

    # Center on origin and scale to world units. Centering avoids the
    # case where the random initial seeds happened to bias one half of
    # the plane.
    pos -= pos.mean(axis=0)
    pos *= _SCALE

    for i, n in enumerate(nodes):
        if n.x is None:
            n.x = float(pos[i, 0])
        if n.y is None:
            n.y = float(pos[i, 1])

    if topology.bounds is None:
        topology.bounds = {
            "minX": float(pos[:, 0].min()),
            "minY": float(pos[:, 1].min()),
            "maxX": float(pos[:, 0].max()),
            "maxY": float(pos[:, 1].max()),
        }
