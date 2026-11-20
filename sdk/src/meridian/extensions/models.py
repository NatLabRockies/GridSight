"""
Data models shared between extensions and the Meridian server.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Capability(str, Enum):
    """Capabilities an extension can declare in its manifest."""

    DATA_PROVIDER = "data_provider"
    DATA_CONTROLS = "data_controls"
    CHART_TYPES = "chart_types"
    LAYER_EXTENSIONS = "layer_extensions"
    AI_QUERYABLE = "ai_queryable"
    DUCKDB_TABLES = "duckdb_tables"
    INPUT_CONTROLS = "input_controls"
    FILE_UPLOAD = "file_upload"
    GRAPH_PROVIDER = "graph_provider"


@dataclass
class ExtensionManifest:
    """Metadata every extension must provide."""

    name: str                    # unique machine name, e.g. "nlr-reeds"
    display_name: str            # human-readable, e.g. "ReEDS Results"
    version: str                 # semver string
    description: str = ""
    capabilities: list[Capability] = field(default_factory=list)
    icon: str | None = None              # Material Icon name (e.g. "bolt") or URL
    min_meridian_version: str | None = None


@dataclass
class ExtensionProject:
    """A project provided by an extension."""

    name: str                    # machine name (unique within extension)
    display_name: str
    description: str = ""
    tags: list[str] = field(default_factory=list)


@dataclass
class ExtensionScenario:
    """A scenario within an extension project."""

    name: str
    display_name: str
    project_name: str            # references ExtensionProject.name
    description: str = ""
    tags: list[str] = field(default_factory=list)
    parent_scenario_name: str | None = None  # references another ExtensionScenario.name for hierarchy


@dataclass
class GeometryDescriptor:
    """Describes a geometry file an extension can provide on demand."""

    name: str                    # unique within extension
    display_name: str
    format: str                  # "geojson", "geoparquet", "shapefile"
    join_key: str | None = None
    description: str = ""
    shared: bool = False         # If True, scope="global" in meridian DB (visible across projects)


@dataclass
class DatasetDescriptor:
    """Describes a dataset an extension can provide on demand."""

    name: str                    # unique within extension
    display_name: str
    format: str                  # "parquet", "csv"
    join_key: str | None = None
    timestamp_col: str | None = None  # None = static dataset
    columns: list[str] = field(default_factory=list)
    description: str = ""
    shared: bool = False         # If True, scope="global" in meridian DB (visible across projects)


@dataclass
class DatasetTimeInfo:
    """Fast time-range metadata for a timeseries dataset.

    Returned by get_dataset_metadata() so the server can populate
    the animation timeline without deserializing every partition.
    Works for both extension datasets and uploaded datasets.
    """

    dates: list[str]                                # sorted partition date strings (YYYY-MM-DD)
    row_counts: dict[str, int] = field(default_factory=dict)  # date → rows per partition
    entity_columns: list[str] = field(default_factory=list)   # non-timestamp column names
    start: str = ""                                 # first timestamp (ISO 8601)
    end: str = ""                                   # last timestamp (ISO 8601)
    total_rows: int = 0                             # sum of all row_counts
    resolution_seconds: int | None = None           # uniform step size if known (e.g. 3600 for hourly)


@dataclass
class DefaultLayerConfig:
    """Pre-configured layer an extension provides out-of-the-box.

    Created automatically during extension data sync. Users can still
    edit style mappings, delete the layer, or add new layers via the UI.
    """

    name: str                    # unique within extension
    display_name: str
    deck_layer_type: str         # "GeoJsonLayer", "ScatterplotLayer", etc.
    geometry_ref: str            # references GeometryDescriptor.name
    dataset_ref: str | None = None
    geom_join_key: str | None = None
    data_join_key: str | None = None
    style_mappings: list[dict] = field(default_factory=list)
    # Each dict: {"visual_property": str, "column": str, "colormap"?: str,
    #             "scale_type"?: str, "domain_min"?: float, "domain_max"?: float,
    #             "category_map_ref"?: str}
    default_style: dict = field(default_factory=dict)
    # Initial local style applied on first load. Supports geoMappings,
    # radiusScale, opacity, and other localStyle keys.


@dataclass
class LayerDefinition:
    """A complete layer definition with lazily-built geometry.

    Extensions return these from list_layers(). The server creates the
    Layer + GeometryFile records at sync time. Geometry data is fetched
    lazily via get_layer_geometry() when the frontend first requests it.
    """

    name: str                    # unique within extension
    display_name: str
    deck_layer_type: str         # "GeoJsonLayer", "ScatterplotLayer", etc.
    geom_join_key: str | None = None
    dataset_ref: str | None = None   # references DatasetDescriptor.name (primary dataset)
    data_join_key: str | None = None
    dataset_refs: list[dict] | None = None
    # Additional datasets for multi-dataset layers.
    # Each dict: {"ref": str, "join_key": str, "role": str}
    # "ref" references a DatasetDescriptor.name, "role" is a semantic label
    # (e.g. "availability", "capacity"). The primary dataset_ref gets role="primary".
    style_mappings: list[dict] = field(default_factory=list)
    # Each dict: {"visual_property": str, "column": str, "colormap"?: str,
    #             "scale_type"?: str, "domain_min"?: float, "domain_max"?: float,
    #             "category_map_ref"?: str, "dataset_role"?: str,
    #             "shared_legend_group"?: str}
    # "dataset_role" links the mapping to a specific dataset (default: "primary").
    # "shared_legend_group" — opaque string. Style mappings with the same group
    # (across layers, even across extensions) are intended to render under a
    # unified legend. v1 ships as metadata pass-through only; extensions should
    # also set matching colormap + domain_min/max so the layers visually align.
    default_style: dict = field(default_factory=dict)
    # Initial local style: geoMappings, radiusScale, opacity, etc.
    #
    # Two reserved UI-only keys may live inside `default_style`:
    #   group_key            — layers sharing this key collapse into one
    #                          row in the layer panel and one styler popover.
    #                          Editing any member broadcasts to all members.
    #   group_display_name   — heading shown for the group row.
    # These are UI hints; deck.gl rendering stays per-layer.


@dataclass
class CategoryMapDescriptor:
    """Describes an entity→category mapping an extension can provide.

    Category maps enable grouped aggregation of timeseries data
    (e.g., generators grouped by fuel type for stacked dispatch charts).
    """

    name: str                    # unique within extension, e.g. "technology"
    display_name: str            # e.g. "Technology Type"
    entity_column: str           # column in the mapping table holding entity IDs
    category_column: str         # column holding category labels
    description: str = ""
    applies_to: list[str] = field(default_factory=list)  # dataset names this map applies to
    colors: dict[str, str] = field(default_factory=dict)  # category → hex color


@dataclass
class DuckDBTableInfo:
    """Metadata about a table registered in DuckDB by an extension."""

    table_name: str              # fully qualified, e.g. "ext_reeds.generation"
    description: str
    columns: list[dict] = field(default_factory=list)
    # Each dict: {"name": str, "type": str, "description": str}
    extension_name: str = ""


# -- File Upload models --


@dataclass
class FileGroupSpec:
    """Describes one group of files within an upload spec."""

    name: str                    # e.g. "system_file", "simulation_files"
    display_name: str            # e.g. "System JSON", "Simulation HDF5 Files"
    accepted_extensions: list[str] = field(default_factory=list)  # e.g. [".json"], [".h5"]
    min_files: int = 1
    max_files: int = 1           # >1 for multi-file groups
    description: str = ""


@dataclass
class UploadFormField:
    """A form field the extension needs alongside file uploads."""

    name: str                    # e.g. "project_name"
    display_name: str = ""
    type: str = "text"           # "text", "select"
    required: bool = True
    default: str = ""
    options: list[str] = field(default_factory=list)  # for "select" type
    # Hidden fields are populated programmatically (e.g. a scenario's
    # system_path threaded in by the dialog). The UI must not render them.
    hidden: bool = False


@dataclass
class FileUploadSpec:
    """Top-level specification for what files an extension accepts."""

    name: str                    # unique identifier, e.g. "sienna_scenario"
    display_name: str            # e.g. "Sienna Scenario"
    description: str = ""
    file_groups: list[FileGroupSpec] = field(default_factory=list)
    form_fields: list[UploadFormField] = field(default_factory=list)
    existing_systems: list[dict] = field(default_factory=list)
    # Optional list of reusable system files: [{"label": "...", "system_path": "..."}]
    # Whether this spec exposes a `handle_preview` step that the UI can call
    # before commit (e.g. to detect columns / preview a join).
    supports_preview: bool = False
    # Free-form extension-specific metadata the frontend dialog can read
    # (e.g. a scenario_systems map for `bus_geometry`). Treat as opaque
    # at the SDK boundary; the dialog and the extension agree on shape.
    meta: dict = field(default_factory=dict)


@dataclass
class UploadResult:
    """Result returned after an extension processes uploaded files."""

    success: bool
    message: str = ""
    project_name: str = ""
    scenario_name: str = ""
    error: str = ""


# -- Graph (non-geospatial network) models --


@dataclass
class GraphStratum:
    """One horizontal band in a stratified graph layout.

    For transmission networks the natural stratum is voltage class
    (138 kV, 230 kV, 500 kV...). Strata are stacked vertically in the
    rendered view and edges crossing strata (e.g. transformers) are
    drawn as vertical-ish segments connecting bands.
    """

    id: str                      # unique within topology, e.g. "138kV"
    label: str                   # display label, e.g. "138 kV"
    order: int                   # stack position (lower = bottom)
    color: str | None = None     # optional hex tint for the band background


@dataclass
class GraphNode:
    """A node in a network graph (e.g. a bus, substation, generator)."""

    id: str
    label: str = ""
    stratum: str | None = None   # GraphStratum.id, or None for unstratified
    kind: str = "node"           # extension-defined classifier ("bus", "gen", ...)
    attrs: dict = field(default_factory=dict)
    # Optional precomputed position. If both x and y are present the
    # server skips the default layout for this node. Coordinates are in
    # whatever units the extension chose; the renderer fits them to the
    # viewport on first load.
    x: float | None = None
    y: float | None = None


@dataclass
class GraphEdge:
    """An edge in a network graph (e.g. a transmission line or transformer)."""

    id: str
    source: str                  # GraphNode.id
    target: str                  # GraphNode.id
    kind: str = "edge"           # extension-defined ("branch", "transformer", ...)
    attrs: dict = field(default_factory=dict)
    # When set, hints to the layout engine that this edge represents a
    # transformer between strata and should be drawn as a vertical
    # segment regardless of the layout's preferred path.
    is_inter_stratum: bool = False


@dataclass
class GraphTopologyDescriptor:
    """Metadata about a graph topology an extension can provide.

    Mirrors GeometryDescriptor / DatasetDescriptor — returned from
    ``list_graph_topologies()`` so the server can register the topology
    in the catalog and the UI can list it for selection.
    """

    name: str                    # unique within extension
    display_name: str
    description: str = ""
    # Suggested entity column for joining timeseries datasets onto nodes.
    # If set, the UI can wire animation/colormap mappings the same way
    # the map does with geometry join_key.
    node_join_key: str | None = None
    # If the extension supplies precomputed (x, y) on every node, set
    # this to True so the server skips its default layout pass. If False
    # or any node is missing coordinates, the default layout fills them
    # in.
    has_precomputed_layout: bool = False
    shared: bool = False


@dataclass
class GraphTopology:
    """The actual graph payload returned by ``get_graph_topology_data``.

    Serialized to JSON over the wire. Nodes without (x, y) get filled in
    by the server-side layout pass before the response reaches the
    client, so renderers can assume every node has coordinates.
    """

    nodes: list[GraphNode] = field(default_factory=list)
    edges: list[GraphEdge] = field(default_factory=list)
    strata: list[GraphStratum] = field(default_factory=list)
    # Optional bounds the renderer can use for initial framing. If
    # absent, the renderer derives them from the node positions.
    bounds: dict | None = None   # {"minX": ..., "minY": ..., "maxX": ..., "maxY": ...}


@dataclass
class PreviewResult:
    """Result returned by `handle_preview` for an upload spec.

    Extensions return arbitrary preview data via `data` — the UI knows the
    shape per spec (e.g. for `bus_geometry` it will include columns,
    auto-detected lat/lon/id fields, sample rows, and a join match
    summary). `success=False` surfaces a user-facing `error` without
    crashing the UI; the dialog can then prompt for a different file.
    """

    success: bool
    data: dict = field(default_factory=dict)
    error: str = ""
