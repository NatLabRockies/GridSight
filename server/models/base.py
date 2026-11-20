from typing import List, Optional

from pydantic import BaseModel


class GeometryFileSchema(BaseModel):
    id: int
    name: str
    file_id: str
    format: str
    join_key: Optional[str] = None
    display_name: Optional[str] = None
    description: Optional[str] = None


class DatasetSchema(BaseModel):
    id: int
    name: str
    file_id: str
    format: str
    join_key: Optional[str] = None
    timestamp_col: Optional[str] = None  # None = static dataset
    display_name: Optional[str] = None
    description: Optional[str] = None

    @property
    def is_timeseries(self) -> bool:
        return self.timestamp_col is not None


class LayerStyleMappingSchema(BaseModel):
    id: int
    layer_dataset_id: int
    visual_property: str   # e.g. "getFillColor", "getRadius", "getElevation"
    column: str            # data column driving this property
    colormap: Optional[str] = None
    scale_type: Optional[str] = None   # linear, log, quantile
    domain_min: Optional[float] = None
    domain_max: Optional[float] = None
    shared_legend_group: Optional[str] = None


class LayerDatasetSchema(BaseModel):
    id: int
    dataset: DatasetSchema
    geom_join_key: Optional[str] = None  # overrides GeometryFile.join_key
    data_join_key: Optional[str] = None  # overrides Dataset.join_key
    style_mappings: List[LayerStyleMappingSchema] = []


class LayerSchema(BaseModel):
    """
    A visualization layer composed of a geometry file, one or more datasets,
    and style mappings that drive deck.gl visual properties from data columns.

    Example: county GeoJSON + annual EV adoption CSV joined on "county_id",
    with getFillColor mapped to "ev_adoption_pct" using a viridis colormap.

    Notes: two geometry files can reference the same dataset (e.g. point-to-point
    transmission geometry and actual transmission path geometry both driven by
    the same hourly flow timeseries).
    """

    id: int
    scenario_id: int
    name: str
    deck_layer_type: str    # GeoJsonLayer, ScatterplotLayer, ArcLayer, etc.
    geometry_file: GeometryFileSchema
    layer_datasets: List[LayerDatasetSchema] = []
    style_mappings: List[LayerStyleMappingSchema] = []
    display_name: Optional[str] = None
    description: Optional[str] = None


class ScenarioSchema(BaseModel):
    id: int
    project_id: int
    name: str
    public: int
    layers: List[LayerSchema] = []
    display_name: Optional[str] = None
    description: Optional[str] = None


class ProjectSchema(BaseModel):
    id: int
    name: str
    owner: str
    public: int
    scenarios: List[ScenarioSchema] = []
    display_name: Optional[str] = None
    description: Optional[str] = None
