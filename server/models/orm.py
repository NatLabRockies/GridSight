from typing import List, Optional

from sqlalchemy import ForeignKey, Float, String, Text, INT, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128))
    owner: Mapped[str] = mapped_column(String(128))
    public: Mapped[int] = mapped_column(INT, default=1)
    display_name: Mapped[Optional[str]]
    description: Mapped[Optional[str]]
    extension_name: Mapped[Optional[str]] = mapped_column(String(128))

    scenarios: Mapped[List["Scenario"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Scenario(Base):
    __tablename__ = "scenarios"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    name: Mapped[str] = mapped_column(String(128))
    public: Mapped[int] = mapped_column(INT, default=1)
    display_name: Mapped[Optional[str]]
    description: Mapped[Optional[str]]
    parent_scenario_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("scenarios.id"), nullable=True
    )

    project: Mapped["Project"] = relationship(back_populates="scenarios")
    parent: Mapped[Optional["Scenario"]] = relationship(
        remote_side="Scenario.id", back_populates="children"
    )
    children: Mapped[List["Scenario"]] = relationship(back_populates="parent")
    layers: Mapped[List["Layer"]] = relationship(
        back_populates="scenario", cascade="all, delete-orphan"
    )
    geometry_files: Mapped[List["GeometryFile"]] = relationship(
        secondary="scenario_geometries", back_populates="scenarios"
    )
    datasets: Mapped[List["Dataset"]] = relationship(
        secondary="scenario_datasets", back_populates="scenarios"
    )
    category_maps: Mapped[List["CategoryMap"]] = relationship(
        secondary="scenario_category_maps", back_populates="scenarios"
    )


class GeometryFile(Base):
    """
    An uploaded geospatial file. Reusable across scenarios and layers.

    content_hash is the SHA-256 hex of the file contents and doubles as the
    storage path: uploads/geometry/{sha256hex}.  Uploading the same bytes
    twice reuses the same file on disk.

    join_key is the default feature property (e.g. GeoJSON property name)
    used to match geometry features to rows in a dataset. Can be overridden
    per LayerDataset.
    """

    __tablename__ = "geometry_files"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128))
    content_hash: Mapped[str] = mapped_column(String(128))  # uploads/geometry/{sha256hex}
    original_filename: Mapped[Optional[str]] = mapped_column(String(256))
    format: Mapped[str] = mapped_column(String(32))   # geojson, shapefile, geoparquet
    join_key: Mapped[Optional[str]] = mapped_column(String(128))
    display_name: Mapped[Optional[str]]
    description: Mapped[Optional[str]]
    extension_name: Mapped[Optional[str]] = mapped_column(String(128))
    extension_ref: Mapped[Optional[str]] = mapped_column(String(256))
    scope: Mapped[str] = mapped_column(String(32), default="scenario")  # "global", "extension", "scenario"

    # Spatial serving (see lib/geometry_spatial.py). When is_spatial, the geometry
    # is backed by a DuckDB spatial table (``spatial_table``) and served per-viewport
    # via /api/geometry/{id}/viewport instead of the whole-GeoJSON /data endpoint.
    is_spatial: Mapped[bool] = mapped_column(default=False)
    spatial_table: Mapped[Optional[str]] = mapped_column(String(128))
    bbox_json: Mapped[Optional[str]]        # [w,s,e,n] EPSG:4326 dataset extent
    feature_count: Mapped[Optional[int]]
    category_col: Mapped[Optional[str]] = mapped_column(String(128))

    scenarios: Mapped[List["Scenario"]] = relationship(
        secondary="scenario_geometries", back_populates="geometry_files"
    )
    layers: Mapped[List["Layer"]] = relationship(back_populates="geometry_file")


class Dataset(Base):
    """
    An uploaded tabular data file. Can be static (no timestamp_col) or a
    timeseries (timestamp_col set). Reusable across scenarios and layers.

    content_hash is the SHA-256 hex of the file contents and doubles as the
    storage path: uploads/dataset/{sha256hex}.  Uploading the same bytes
    twice reuses the same file on disk.

    join_key is the default column used to match dataset rows to geometry
    features. Can be overridden per LayerDataset.
    """

    __tablename__ = "datasets"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128))
    content_hash: Mapped[str] = mapped_column(String(128))  # uploads/dataset/{sha256hex}
    original_filename: Mapped[Optional[str]] = mapped_column(String(256))
    format: Mapped[str] = mapped_column(String(32))       # csv, parquet
    join_key: Mapped[Optional[str]] = mapped_column(String(128))
    timestamp_col: Mapped[Optional[str]] = mapped_column(String(128))  # None = static dataset
    value_min: Mapped[Optional[float]] = mapped_column(Float)  # global min across all numeric columns
    value_max: Mapped[Optional[float]] = mapped_column(Float)  # global max across all numeric columns
    display_name: Mapped[Optional[str]]
    description: Mapped[Optional[str]]
    extension_name: Mapped[Optional[str]] = mapped_column(String(128))
    extension_ref: Mapped[Optional[str]] = mapped_column(String(256))
    scope: Mapped[str] = mapped_column(String(32), default="scenario")  # "global", "extension", "scenario"
    time_meta_json: Mapped[Optional[str]] = mapped_column(Text, default=None)  # cached DatasetTimeInfo as JSON

    scenarios: Mapped[List["Scenario"]] = relationship(
        secondary="scenario_datasets", back_populates="datasets"
    )
    layer_datasets: Mapped[List["LayerDataset"]] = relationship(back_populates="dataset")


# --- Association tables ---


class ScenarioGeometry(Base):
    """Declares which geometry files a scenario has access to."""

    __tablename__ = "scenario_geometries"

    scenario_id: Mapped[int] = mapped_column(ForeignKey("scenarios.id"), primary_key=True)
    geometry_id: Mapped[int] = mapped_column(ForeignKey("geometry_files.id"), primary_key=True)


class ScenarioDataset(Base):
    """Declares which datasets a scenario has access to."""

    __tablename__ = "scenario_datasets"

    scenario_id: Mapped[int] = mapped_column(ForeignKey("scenarios.id"), primary_key=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"), primary_key=True)


# --- Layer models ---


class Layer(Base):
    """
    A visualization layer. Binds a geometry file to a deck.gl layer type within
    a scenario. Datasets are attached via LayerDataset with join configuration.
    Styling is driven by LayerStyleMapping.
    """

    __tablename__ = "layers"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    scenario_id: Mapped[int] = mapped_column(ForeignKey("scenarios.id"))
    geometry_id: Mapped[int] = mapped_column(ForeignKey("geometry_files.id"))
    name: Mapped[str] = mapped_column(String(128))
    deck_layer_type: Mapped[str] = mapped_column(String(64))  # GeoJsonLayer, ScatterplotLayer, ArcLayer, etc.
    display_name: Mapped[Optional[str]]
    description: Mapped[Optional[str]]
    default_style_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    source_type: Mapped[Optional[str]] = mapped_column(String(32))  # "extension" | "user"
    source_extension: Mapped[Optional[str]] = mapped_column(String(128))

    scenario: Mapped["Scenario"] = relationship(back_populates="layers")
    geometry_file: Mapped["GeometryFile"] = relationship(back_populates="layers")
    layer_datasets: Mapped[List["LayerDataset"]] = relationship(
        back_populates="layer", cascade="all, delete-orphan"
    )
    style_mappings: Mapped[List["LayerStyleMapping"]] = relationship(
        back_populates="layer", cascade="all, delete-orphan"
    )


class LayerDataset(Base):
    """
    Binds a dataset to a layer with join key configuration.

    geom_join_key and data_join_key override the defaults set on GeometryFile
    and Dataset respectively. If None, the defaults are used.
    """

    __tablename__ = "layer_datasets"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    layer_id: Mapped[int] = mapped_column(ForeignKey("layers.id"))
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"))
    geom_join_key: Mapped[Optional[str]] = mapped_column(String(128))
    data_join_key: Mapped[Optional[str]] = mapped_column(String(128))
    role: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    layer: Mapped["Layer"] = relationship(back_populates="layer_datasets")
    dataset: Mapped["Dataset"] = relationship(back_populates="layer_datasets")
    style_mappings: Mapped[List["LayerStyleMapping"]] = relationship(
        back_populates="layer_dataset"
    )


class LayerStyleMapping(Base):
    """
    Maps a deck.gl visual property to a column in a dataset.

    For color properties, colormap and scale_type/domain control the mapping.
    domain_min/domain_max default to the column's actual min/max if None.

    Example: map getFillColor -> "load_mw" column with viridis colormap.
    """

    __tablename__ = "layer_style_mappings"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    layer_id: Mapped[int] = mapped_column(ForeignKey("layers.id"))
    layer_dataset_id: Mapped[int] = mapped_column(ForeignKey("layer_datasets.id"))
    visual_property: Mapped[str] = mapped_column(String(64))   # getFillColor, getRadius, getElevation, ...
    column: Mapped[str] = mapped_column(String(128))            # data column driving this property
    colormap: Mapped[Optional[str]] = mapped_column(String(64)) # viridis, plasma, coolwarm, ...
    scale_type: Mapped[Optional[str]] = mapped_column(String(32)) # linear, log, quantile, categorical
    domain_min: Mapped[Optional[float]] = mapped_column(Float)
    domain_max: Mapped[Optional[float]] = mapped_column(Float)
    category_map_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("category_maps.id"), nullable=True
    )
    aggregation_mode: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True
    )  # sum, mean, max — how to aggregate within category
    shared_legend_group: Mapped[Optional[str]] = mapped_column(
        String(128), nullable=True
    )  # opt-in group key; mappings sharing a group render under one legend

    layer: Mapped["Layer"] = relationship(back_populates="style_mappings")
    layer_dataset: Mapped["LayerDataset"] = relationship(back_populates="style_mappings")
    category_map: Mapped[Optional["CategoryMap"]] = relationship()


class CategoryMap(Base):
    """
    An entity→category mapping. Used for grouped aggregation of timeseries
    data (e.g., generators grouped by fuel type for stacked dispatch charts).

    Can be user-uploaded (extension_name=None) or extension-provided.
    Actual mapping data is stored as a Parquet file (same content_hash
    pattern as Dataset/GeometryFile) or in DuckDB via extensions.
    """

    __tablename__ = "category_maps"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128))
    display_name: Mapped[Optional[str]]
    description: Mapped[Optional[str]]
    entity_column: Mapped[str] = mapped_column(String(128))    # column holding entity IDs
    category_column: Mapped[str] = mapped_column(String(128))  # column holding category labels
    content_hash: Mapped[Optional[str]] = mapped_column(String(128))  # uploads/category_map/{sha256hex}
    colors_json: Mapped[Optional[str]] = mapped_column(Text)  # JSON: {"Solar": "#FFD700", ...}
    extension_name: Mapped[Optional[str]] = mapped_column(String(128))
    extension_ref: Mapped[Optional[str]] = mapped_column(String(256))

    scenarios: Mapped[List["Scenario"]] = relationship(
        secondary="scenario_category_maps", back_populates="category_maps"
    )


class ScenarioCategoryMap(Base):
    """Declares which category maps a scenario has access to."""

    __tablename__ = "scenario_category_maps"

    scenario_id: Mapped[int] = mapped_column(ForeignKey("scenarios.id"), primary_key=True)
    category_map_id: Mapped[int] = mapped_column(ForeignKey("category_maps.id"), primary_key=True)


class Painting(Base):
    """
    A named style snapshot for a single layer. The style_json column stores the
    complete local style object as a JSON string, matching the client-side
    genericLayerLocalStyle structure (opacity, radiusScale, mappingOverrides,
    geoMappings, filterEnabled, interaction config, etc.).
    """

    __tablename__ = "paintings"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    layer_id: Mapped[int] = mapped_column(ForeignKey("layers.id"))
    name: Mapped[str] = mapped_column(String(256))
    style_json: Mapped[str] = mapped_column(Text)  # JSON-encoded style object
    sort_order: Mapped[int] = mapped_column(INT, default=0)
    # When true, this painting is auto-applied to the layer on load. At most one
    # per layer (enforced by the set-default endpoint, which clears the others).
    is_default: Mapped[bool] = mapped_column(default=False)

    layer: Mapped["Layer"] = relationship()


class ProjectTag(Base):
    """Queryable tag storage for cross-project discovery."""

    __tablename__ = "project_tags"
    __table_args__ = (UniqueConstraint("project_id", "tag"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    tag: Mapped[str] = mapped_column(String(128))

    project: Mapped["Project"] = relationship()


class ProjectAlias(Base):
    """Maps a project to an equivalent project in another extension."""

    __tablename__ = "project_aliases"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"))
    alias_name: Mapped[str] = mapped_column(String(256))
    target_extension: Mapped[str] = mapped_column(String(128))
    target_project: Mapped[str] = mapped_column(String(128))

    project: Mapped["Project"] = relationship()


class Perspective(Base):
    """
    A multi-layer composition: a collection of paintings, plots, map viewState,
    and clock state that together paint an overarching concept. Can span
    multiple layers, maps, and displays.

    config_json schema:
    {
        paintings: [{painting_id, layer_id, overrides}],
        viewState: {longitude, latitude, zoom, pitch, bearing},
        clockState: {index, animate, frequency, ...},
        plots: [{type, datasetId, ...}],
    }
    """

    __tablename__ = "perspectives"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[Optional[str]] = mapped_column(Text)
    owner: Mapped[str] = mapped_column(String(128), default="admin")
    project_id: Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id"))
    scenario_id: Mapped[Optional[int]] = mapped_column(ForeignKey("scenarios.id"))
    config_json: Mapped[str] = mapped_column(Text)


class Story(Base):
    """A sequential collection of perspectives with transitions."""

    __tablename__ = "stories"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[Optional[str]] = mapped_column(Text)
    # Free-text brief that guides the AI assistant through this story: intended
    # audience, the narrative arc, domain context, and what a good answer looks
    # like. Injected into the assistant's system prompt when the story is the
    # active context (see build_system_prompt), alongside the per-chapter
    # perspective descriptions.
    guiding_prompt: Mapped[Optional[str]] = mapped_column(Text)
    owner: Mapped[str] = mapped_column(String(128), default="admin")
    project_id: Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id"))

    steps: Mapped[List["StoryStep"]] = relationship(
        back_populates="story", cascade="all, delete-orphan"
    )


class StoryStep(Base):
    """A single step in a story, referencing a perspective."""

    __tablename__ = "story_steps"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    story_id: Mapped[int] = mapped_column(ForeignKey("stories.id"))
    perspective_id: Mapped[int] = mapped_column(ForeignKey("perspectives.id"))
    sort_order: Mapped[int] = mapped_column(INT, default=0)
    transition_type: Mapped[Optional[str]] = mapped_column(String(64), default="fade")
    transition_duration_ms: Mapped[Optional[int]] = mapped_column(INT, default=1000)
    narration: Mapped[Optional[str]] = mapped_column(Text)
    auto_advance_ms: Mapped[Optional[int]] = mapped_column(INT)
    # JSON array of strings: tap-to-send chat prompts surfaced for this step
    # in the Atlas assistant. NULL/empty when the step has none.
    suggested_prompts: Mapped[Optional[str]] = mapped_column(Text)

    story: Mapped["Story"] = relationship(back_populates="steps")
    perspective: Mapped["Perspective"] = relationship()


class DataTag(Base):
    """Tag for geometry files and datasets (e.g. 'auxiliary')."""

    __tablename__ = "data_tags"
    __table_args__ = (UniqueConstraint("tag", "target_type", "target_id"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    tag: Mapped[str] = mapped_column(String(128))
    target_type: Mapped[str] = mapped_column(String(32))  # 'geometry' or 'dataset'
    target_id: Mapped[int] = mapped_column(INT)


class JoinHint(Base):
    """Auto-discovered join compatibility between a dataset and geometry.

    Populated by the background profiler when datasets or geometries are
    ingested.  Users can confirm or reject suggestions via the status field.
    """

    __tablename__ = "join_hints"
    __table_args__ = (
        UniqueConstraint("dataset_id", "geometry_id", "dataset_column", "geometry_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    dataset_id: Mapped[int] = mapped_column(ForeignKey("datasets.id"))
    geometry_id: Mapped[int] = mapped_column(ForeignKey("geometry_files.id"))
    dataset_column: Mapped[str] = mapped_column(String(128))
    geometry_key: Mapped[str] = mapped_column(String(128))
    overlap: Mapped[float] = mapped_column(Float)  # 0.0–1.0, fraction of geometry features matched
    sample_size: Mapped[int] = mapped_column(INT)
    status: Mapped[str] = mapped_column(String(32), default="suggested")  # suggested | confirmed | rejected

    dataset: Mapped["Dataset"] = relationship()
    geometry: Mapped["GeometryFile"] = relationship()


# --- User model (stub) ---


class User(Base):
    """Stub user model. Seeded with ADMIN from env vars until auth is added."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(128), unique=True)
    display_name: Mapped[Optional[str]] = mapped_column(String(256))
    avatar_url: Mapped[Optional[str]] = mapped_column(String(512))
    role: Mapped[str] = mapped_column(String(32), default="admin")
    created_at: Mapped[Optional[str]] = mapped_column(String(64))


class UserExtensionPref(Base):
    """Per-user extension preferences: enabled, disabled, or hidden.

    - enabled: extension is active (layers visible, AI can use it)
    - disabled: extension is loaded but inactive (layers hidden, AI ignores it)
    - hidden: extension is completely hidden from the user's UI
    """

    __tablename__ = "user_extension_prefs"
    __table_args__ = (UniqueConstraint("user_id", "extension_name"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    extension_name: Mapped[str] = mapped_column(String(128))
    state: Mapped[str] = mapped_column(String(32), default="enabled")  # enabled | disabled | hidden

    user: Mapped["User"] = relationship()


class UserPreference(Base):
    """Generic per-user key→JSON preference store (style defaults, etc.).

    Example: key="style", value_json={"colormap": "plasma", "opacity": 0.85,
    "point_color": [33,150,243,200]}. Read at layer-creation time so user
    defaults override hardcoded ones; settable via UI or by the AI.
    """

    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("user_id", "key"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    key: Mapped[str] = mapped_column(String(64))
    value_json: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[Optional[str]] = mapped_column(String(64))

    user: Mapped["User"] = relationship()


# --- Data Lineage models ---


class LineageNode(Base):
    """
    A node in the data lineage DAG. Tracks provenance for every data source,
    transformation, result, visualization config, and rendered output.

    node_type: data_source | transform | result | viz_config | output
    transform_kind: sql_manual | sql_ai | input_control | data_control (TRANSFORM nodes only)
    review_status: computed high-water mark from lineage_reviews table
    """

    __tablename__ = "lineage_nodes"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    node_type: Mapped[str] = mapped_column(String(32))
    transform_kind: Mapped[Optional[str]] = mapped_column(String(32))
    content_json: Mapped[str] = mapped_column(Text, default="{}")
    content_hash: Mapped[Optional[str]] = mapped_column(String(64))
    creator_type: Mapped[str] = mapped_column(String(16), default="system")
    creator_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
    ai_model: Mapped[Optional[str]] = mapped_column(String(128))
    ai_conversation_id: Mapped[Optional[str]] = mapped_column(String(128))
    review_status: Mapped[str] = mapped_column(String(32), default="unreviewed")
    version: Mapped[int] = mapped_column(INT, default=1)
    created_at: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[Optional[str]] = mapped_column(String(64))
    project_id: Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id"))
    scenario_id: Mapped[Optional[int]] = mapped_column(ForeignKey("scenarios.id"))
    extension_name: Mapped[Optional[str]] = mapped_column(String(128))
    label: Mapped[Optional[str]] = mapped_column(String(256))

    creator: Mapped[Optional["User"]] = relationship(foreign_keys=[creator_user_id])
    reviews: Mapped[List["LineageReview"]] = relationship(
        back_populates="node", cascade="all, delete-orphan"
    )
    review_requests: Mapped[List["LineageReviewRequest"]] = relationship(
        back_populates="node", cascade="all, delete-orphan"
    )


class LineageEdge(Base):
    """Directed edge in the lineage DAG: parent → child."""

    __tablename__ = "lineage_edges"
    __table_args__ = (
        UniqueConstraint("parent_node_id", "child_node_id", "edge_type"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    parent_node_id: Mapped[int] = mapped_column(ForeignKey("lineage_nodes.id"))
    child_node_id: Mapped[int] = mapped_column(ForeignKey("lineage_nodes.id"))
    edge_type: Mapped[str] = mapped_column(String(32), default="derives_from")
    created_at: Mapped[Optional[str]] = mapped_column(String(64))

    parent_node: Mapped["LineageNode"] = relationship(foreign_keys=[parent_node_id])
    child_node: Mapped["LineageNode"] = relationship(foreign_keys=[child_node_id])


class PerspectiveLineage(Base):
    """Links a perspective to its lineage output node(s)."""

    __tablename__ = "perspective_lineage"

    perspective_id: Mapped[int] = mapped_column(
        ForeignKey("perspectives.id"), primary_key=True
    )
    lineage_node_id: Mapped[int] = mapped_column(
        ForeignKey("lineage_nodes.id"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(32), default="contributor")

    perspective: Mapped["Perspective"] = relationship()
    node: Mapped["LineageNode"] = relationship()


class LineageReview(Base):
    """
    An individual review of a lineage node. Multiple reviewers (AI models and
    humans) can each review a node independently. The node's review_status is
    a computed high-water mark derived from all its reviews.
    """

    __tablename__ = "lineage_reviews"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    lineage_node_id: Mapped[int] = mapped_column(ForeignKey("lineage_nodes.id"))
    reviewer_type: Mapped[str] = mapped_column(String(16))  # "ai" or "human"
    reviewer_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
    ai_model: Mapped[Optional[str]] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32))  # "approved", "flagged", "requested"
    comment: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[str]] = mapped_column(String(64))

    node: Mapped["LineageNode"] = relationship(back_populates="reviews")
    reviewer: Mapped[Optional["User"]] = relationship(foreign_keys=[reviewer_user_id])


# --- AI Metadata Description models ---


class TableDescription(Base):
    """Persistent description of a DuckDB table, discoverable by AI or provided by extensions."""

    __tablename__ = "table_descriptions"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    table_name: Mapped[str] = mapped_column(String(256), unique=True)
    description: Mapped[Optional[str]] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(32), default="extension")  # extension | ai | user
    extension_name: Mapped[Optional[str]] = mapped_column(String(128))
    # AI auto-description confidence: "high" | "medium" | "low" (None for non-AI).
    confidence: Mapped[Optional[str]] = mapped_column(String(16))
    # 1 when the AI couldn't confidently describe the data and wants the user to
    # clarify. Cleared once a user-sourced description is provided.
    needs_review: Mapped[Optional[int]] = mapped_column(INT, default=0)
    # A specific question to put to the user when needs_review is set.
    review_question: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[Optional[str]] = mapped_column(String(64))

    columns: Mapped[List["ColumnDescription"]] = relationship(
        back_populates="table_description", cascade="all, delete-orphan"
    )


class ColumnDescription(Base):
    """Persistent description of a column within a DuckDB table."""

    __tablename__ = "column_descriptions"
    __table_args__ = (UniqueConstraint("table_description_id", "column_name"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    table_description_id: Mapped[int] = mapped_column(ForeignKey("table_descriptions.id"))
    column_name: Mapped[str] = mapped_column(String(256))
    description: Mapped[Optional[str]] = mapped_column(Text)
    data_type: Mapped[Optional[str]] = mapped_column(String(64))
    is_joinable: Mapped[Optional[int]] = mapped_column(INT, default=0)
    join_target_table: Mapped[Optional[str]] = mapped_column(String(256))
    join_target_column: Mapped[Optional[str]] = mapped_column(String(256))
    source: Mapped[str] = mapped_column(String(32), default="extension")  # extension | ai | user
    created_at: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[Optional[str]] = mapped_column(String(64))

    table_description: Mapped["TableDescription"] = relationship(back_populates="columns")


# --- AI Memory model ---


class AIMemory(Base):
    """Reusable knowledge the AI saves for future conversations — charts, queries, insights."""

    __tablename__ = "ai_memories"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    memory_type: Mapped[str] = mapped_column(String(32))  # chart | query | dag | insight | perspective_ref | story_ref
    name: Mapped[str] = mapped_column(String(256))
    description: Mapped[Optional[str]] = mapped_column(Text)
    content_json: Mapped[str] = mapped_column(Text, default="{}")
    tags: Mapped[Optional[str]] = mapped_column(Text)  # comma-separated
    lineage_node_id: Mapped[Optional[int]] = mapped_column(ForeignKey("lineage_nodes.id"))
    project_id: Mapped[Optional[int]] = mapped_column(ForeignKey("projects.id"))
    scenario_id: Mapped[Optional[int]] = mapped_column(ForeignKey("scenarios.id"))
    extension_name: Mapped[Optional[str]] = mapped_column(String(128))
    creator_type: Mapped[str] = mapped_column(String(16), default="ai")  # ai | user
    created_at: Mapped[Optional[str]] = mapped_column(String(64))
    updated_at: Mapped[Optional[str]] = mapped_column(String(64))


class LineageReviewRequest(Base):
    """
    A request for a review of a lineage node. Supports workflows like: user
    requests AI review of SQL, or AI flags a node for human review.
    """

    __tablename__ = "lineage_review_requests"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    lineage_node_id: Mapped[int] = mapped_column(ForeignKey("lineage_nodes.id"))
    requested_by_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
    requested_reviewer_type: Mapped[str] = mapped_column(String(16))  # "ai" or "human"
    requested_reviewer_user_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
    requested_ai_model: Mapped[Optional[str]] = mapped_column(String(128))
    message: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="pending")  # "pending", "completed", "dismissed"
    created_at: Mapped[Optional[str]] = mapped_column(String(64))
    completed_at: Mapped[Optional[str]] = mapped_column(String(64))
    completed_review_id: Mapped[Optional[int]] = mapped_column(ForeignKey("lineage_reviews.id"))

    node: Mapped["LineageNode"] = relationship(back_populates="review_requests")
    requested_by: Mapped[Optional["User"]] = relationship(foreign_keys=[requested_by_user_id])
    requested_reviewer: Mapped[Optional["User"]] = relationship(foreign_keys=[requested_reviewer_user_id])
    completed_review: Mapped[Optional["LineageReview"]] = relationship(foreign_keys=[completed_review_id])
