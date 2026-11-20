"""Built-in demo extension that supplies a synthetic stratified
transmission graph so the GraphPanel has something to render before any
real extension is installed.

Topology: 30 buses arranged across three voltage classes (138 kV /
230 kV / 500 kV) with branches inside each stratum and transformers
crossing them. Coordinates are NOT supplied — the server's default
layout engine fills them in, which is also the most realistic way to
exercise that code path.
"""

from __future__ import annotations

from meridian.extensions import (
    Capability,
    ExtensionManifest,
    GraphEdge,
    GraphNode,
    GraphStratum,
    GraphTopology,
    GraphTopologyDescriptor,
    MeridianExtensionBase,
)


_TOPOLOGY_NAME = "demo_transmission"

# Synthetic bus list. Names follow ``B<stratum>_<n>`` for readability.
# Distribution chosen so each stratum has enough nodes to make the
# barycentric layout pass do real work: 16 / 10 / 4 buses across
# 138 / 230 / 500 kV respectively.
_BUSES_138 = [f"B138_{i:02d}" for i in range(1, 17)]
_BUSES_230 = [f"B230_{i:02d}" for i in range(1, 11)]
_BUSES_500 = [f"B500_{i:02d}" for i in range(1, 5)]

_STRATA = [
    GraphStratum(id="138", label="138 kV", order=0, color="#1e3f72"),
    GraphStratum(id="230", label="230 kV", order=1, color="#2a62a8"),
    GraphStratum(id="500", label="500 kV", order=2, color="#58a6ff"),
]


def _make_topology() -> GraphTopology:
    nodes: list[GraphNode] = []
    for bus in _BUSES_138:
        nodes.append(GraphNode(id=bus, label=bus, stratum="138", kind="bus"))
    for bus in _BUSES_230:
        nodes.append(GraphNode(id=bus, label=bus, stratum="230", kind="bus"))
    for bus in _BUSES_500:
        nodes.append(GraphNode(id=bus, label=bus, stratum="500", kind="bus"))

    edges: list[GraphEdge] = []

    # Within-stratum branches (chain + a couple of cross-links per
    # band so the layout has signal to work with).
    def _ring(buses: list[str], stratum: str) -> list[GraphEdge]:
        out: list[GraphEdge] = []
        for i in range(len(buses) - 1):
            out.append(GraphEdge(
                id=f"br_{stratum}_{i}",
                source=buses[i],
                target=buses[i + 1],
                kind="branch",
                attrs={"voltage_kv": int(stratum)},
            ))
        # A few non-adjacent cross-ties — gives the barycentric sweep
        # something interesting to settle.
        if len(buses) >= 6:
            out.append(GraphEdge(
                id=f"br_{stratum}_x1",
                source=buses[1], target=buses[4],
                kind="branch", attrs={"voltage_kv": int(stratum)},
            ))
            out.append(GraphEdge(
                id=f"br_{stratum}_x2",
                source=buses[3], target=buses[len(buses) // 2 + 1],
                kind="branch", attrs={"voltage_kv": int(stratum)},
            ))
        return out

    edges.extend(_ring(_BUSES_138, "138"))
    edges.extend(_ring(_BUSES_230, "230"))
    edges.extend(_ring(_BUSES_500, "500"))

    # Transformers crossing strata. Each is flagged ``is_inter_stratum``
    # so the renderer can tint them differently from in-band branches.
    transformer_pairs = [
        ("B138_02", "B230_01"),
        ("B138_05", "B230_03"),
        ("B138_09", "B230_05"),
        ("B138_12", "B230_07"),
        ("B138_15", "B230_09"),
        ("B230_02", "B500_01"),
        ("B230_05", "B500_02"),
        ("B230_07", "B500_03"),
        ("B230_09", "B500_04"),
    ]
    for i, (src, tgt) in enumerate(transformer_pairs):
        edges.append(GraphEdge(
            id=f"tx_{i:02d}",
            source=src, target=tgt,
            kind="transformer",
            is_inter_stratum=True,
            attrs={"primary_kv": int(src.split("_")[0][1:]),
                   "secondary_kv": int(tgt.split("_")[0][1:])},
        ))

    return GraphTopology(nodes=nodes, edges=edges, strata=_STRATA)


class DemoGraphExtension(MeridianExtensionBase):
    """Synthetic stratified transmission topology for the GraphPanel."""

    def get_manifest(self) -> ExtensionManifest:
        return ExtensionManifest(
            name="meridian_demo",
            display_name="Demo (built-in)",
            version="0.1.0",
            description="Built-in demonstration topologies for Meridian's "
                        "non-geospatial views.",
            capabilities=[Capability.GRAPH_PROVIDER],
            icon="hub",
        )

    def list_graph_topologies(self, project=None, scenario=None):
        return [GraphTopologyDescriptor(
            name=_TOPOLOGY_NAME,
            display_name="Synthetic 3-voltage transmission",
            description="30-bus demo network across 138 / 230 / 500 kV with "
                        "transformer crossings. Layout filled in server-side.",
            node_join_key="id",
            has_precomputed_layout=False,
        )]

    def get_graph_topology(self, topology_name, project=None, scenario=None):
        if topology_name != _TOPOLOGY_NAME:
            return None
        return _make_topology()
