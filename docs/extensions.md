# GridSight Extension Developer Guide

## Overview

Extensions are pip-installable Python packages that add data, interactive controls, charts, shaders, and AI context to GridSight. Each extension is a Python class that subclasses `GridSightExtensionBase` from the SDK and declares its capabilities via a manifest. The server discovers installed extensions at startup using Python entry points and integrates them into the platform automatically.

Extensions can:

- **Provide data** — projects, scenarios, geometries (GeoJSON/GeoParquet/Shapefile), and datasets (Parquet/CSV) with optional time partitions for animation
- **Expose interactive controls** — per-entity sliders/dropdowns/toggles and project-level input controls that can trigger re-simulation
- **Register DuckDB tables** — make data queryable via SQL by users and the AI chat assistant
- **Provide AI context** — table schemas, column descriptions, example queries, and prompts that are injected into the LLM system prompt
- **Define charts** — SQL-template-driven Plotly/Chart.js charts rendered inline
- **Supply custom shaders** — GLSL vertex/fragment shaders and deck.gl layer extensions

### How Discovery Works

```
pyproject.toml entry_points: "gridsight.extensions"
        |
        v
Server startup: importlib.metadata.entry_points(group="gridsight.extensions")
        |
        v
For each entry point:
  1. Instantiate the class
  2. Call get_manifest() → read capabilities
  3. Call on_startup(context) → pass DuckDB conn, DB session, data_dir
  4. If DUCKDB_TABLES: call register_duckdb_tables(conn)
  5. Sync projects/scenarios/geometries/datasets into ORM
  6. Create default layers from list_default_layers()
```

### Minimal Example

```python
from gridsight.extensions import (
    GridSightExtensionBase,
    ExtensionManifest,
    ExtensionProject,
    ExtensionScenario,
    Capability,
)

class MyExtension(GridSightExtensionBase):
    def get_manifest(self):
        return ExtensionManifest(
            name="my-ext",
            display_name="My Extension",
            version="0.1.0",
            capabilities=[Capability.DATA_PROVIDER],
        )

    def list_projects(self):
        return [ExtensionProject(name="demo", display_name="Demo Project")]

    def list_scenarios(self, project):
        if project == "demo":
            return [ExtensionScenario(name="base", display_name="Base", project_name="demo")]
        return []
```

```toml
# pyproject.toml
[project]
name = "my-extension"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["gridsight-sdk"]

[project.entry-points."gridsight.extensions"]
my_ext = "my_package.extension:MyExtension"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/my_package"]
```

Install with `uv pip install -e .` and restart the server. The full
install paths — for dev, for production containers, and for adopting a
third-party extension — are covered in the next section.

---

## Installing Extensions

There are two install paths depending on whether you're running the
local dev server (`./dev.sh`) or building a container image to deploy.
Both rely on the same Python entry-points mechanism: as long as a
package exposing a `gridsight.extensions` entry point is importable in
the server's Python environment, it shows up.

### Local development (editable install from a sibling repo)

When iterating on an extension's source alongside the platform, use an
editable install. The dev tree's `server/pyproject.toml` already wires
GAT and DemandTldr in this way under `[tool.uv.sources]`:

```toml
[project]
dependencies = [
    "gridsight-sdk",
    "gridsight-gat",
    "gridsight-demand-tldr",
    # ...core deps...
]

[tool.uv.sources]
gridsight-sdk         = { path = "../sdk",                       editable = true }
gridsight-gat         = { path = "../../GAT/gridsight-ext",       editable = true }
gridsight-demand-tldr = { path = "../../DemandTldr/gridsight-ext", editable = true }
```

Running `cd server && uv sync` resolves these against the host's
filesystem and installs each one editable, so source edits take effect
on next reload.

To add a **new** extension you're developing locally:

1. Clone or scaffold the extension package alongside the gridsight repo
   (e.g. `~/code/MyExt/gridsight-ext/`).
2. Append it to `server/pyproject.toml`:
   ```toml
   [project]
   dependencies = [..., "my-ext"]

   [tool.uv.sources]
   my-ext = { path = "../../MyExt/gridsight-ext", editable = true }
   ```
3. `cd server && uv sync`
4. Restart the server (`./dev.sh` will re-run discovery).

To use a **third-party** extension that's already published:

```bash
cd server && uv add some-published-extension
```

(`uv add` updates `pyproject.toml` and the lockfile in one step.)

### Container builds (pinned remote installs)

The container image **does not** read `pyproject.toml`'s
`[tool.uv.sources]` — those host-relative paths don't exist inside the
image. Instead, the Dockerfile installs from
**`server/requirements.docker.txt`**, where each extension is listed as
a PyPI name or a `git+https://…` URL pointing at a tag or commit:

```
# core deps...
gridsight-sdk          @ git+https://github.com/NatLabRockies/GridSight.git@v1.2.3#subdirectory=sdk
gridsight-gat          @ git+https://github.com/NatLabRockies/GridAnalysisToolkit.git@nlr-gat-v0.1.3#subdirectory=gridsight-ext
nlr-gat[sienna,server] @ git+https://github.com/NatLabRockies/GridAnalysisToolkit.git@nlr-gat-v0.1.3
gridsight-demand-tldr  @ git+https://github.com/YOUR_ORG/DemandTldr.git@v0.1.0#subdirectory=gridsight-ext
```

Anything pip understands works: `name>=ver`, `git+https://…@<ref>`,
`#subdirectory=path/to/pkg`, direct wheel URLs.

To add an extension to a deployment:

1. Push the extension to a git remote reachable from the build host
   (or to a private PyPI / wheel registry).
2. Append a line to `server/requirements.docker.txt` pinned to a tag
   or commit.
3. `IMAGE_TAG=v1.2.4 ./scripts/docker-build.sh`
4. Push the images to your registry.

Removing an extension is the inverse: delete the line, rebuild, push.

### Verifying the install

Once the server restarts, the extension's manifest appears at
`/api/extensions`:

```bash
curl -H "X-MyApp-ApiKey: $API_KEY" http://localhost:5001/api/extensions \
  | jq '.[] | {name, display_name, state}'
```

Inside the UI, the extension is shown in the sidebar drawer (with
whichever icon and display name its `ExtensionManifest` declares) and
in the Settings panel's per-extension toggle. If it doesn't appear:

- Check the server's startup log for `Loaded extension '<name>'` lines.
- Confirm the package is importable: `uv run python -c "import my_pkg; print(my_pkg.__file__)"` from `server/`.
- Confirm the entry point: `uv run python -c "from importlib.metadata import entry_points; print(list(entry_points(group='gridsight.extensions')))"`.

### Extension-specific environment variables

Most extensions need at least one runtime env var (DB URL, API key,
data directory). They're plain Python packages — they can read any env
var they like via `os.environ`. The convention is to document expected
vars in the extension's own README and surface them via `.env` for
container deployments. Compose forwards `.env` into the server
container via `env_file:` so adding an extension's secrets is a
config-only change.

---

## Capabilities

Each `Capability` enum value enables a set of extension methods. Only declare capabilities you implement.

| Capability | Value | What it enables | Required methods |
|-----------|-------|-----------------|------------------|
| `DATA_PROVIDER` | `"data_provider"` | Projects, scenarios, geometries, datasets | `list_projects`, `list_scenarios`, `list_geometries`, `get_geometry_data`, `list_datasets`, `get_dataset_data` |
| `DATA_CONTROLS` | `"data_controls"` | Per-entity interactive controls | `get_data_controls`, `set_control_value` |
| `INPUT_CONTROLS` | `"input_controls"` | Project/scenario-level controls (no entity context) | Methods decorated with `@input_control` |
| `CHART_TYPES` | `"chart_types"` | SQL-template-driven charts | `list_chart_specs` |
| `LAYER_EXTENSIONS` | `"layer_extensions"` | Custom GLSL shaders / deck.gl extensions | `list_shader_specs`, `get_shader_source` |
| `AI_QUERYABLE` | `"ai_queryable"` | Schema context for AI chat | `get_ai_schema` |
| `DUCKDB_TABLES` | `"duckdb_tables"` | Register tables in analytical engine | `register_duckdb_tables` |

Import: `from gridsight.extensions import Capability`


## Data Models

All models are Python dataclasses. Import from `gridsight.extensions` (top-level) or `gridsight.extensions.models`.

### `ExtensionManifest`

Returned by `get_manifest()`. Every extension must provide this.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Unique machine name (e.g. `"my-ext"`). Used in API routes and DuckDB schema names. |
| `display_name` | `str` | yes | Human-readable name shown in the UI. |
| `version` | `str` | yes | Semver string (e.g. `"0.1.0"`). |
| `description` | `str` | no | Brief description of the extension. Default: `""`. |
| `capabilities` | `list[Capability]` | no | List of capabilities this extension provides. Default: `[]`. |
| `icon` | `str \| None` | no | Material Icon name (e.g. `"bolt"`) or URL. Default: `None`. |
| `min_gridsight_version` | `str \| None` | no | Minimum server version required. Default: `None`. |

### `ExtensionProject`

Returned by `list_projects()`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Machine name, unique within this extension. |
| `display_name` | `str` | yes | Human-readable name. |
| `description` | `str` | no | Default: `""`. |
| `tags` | `list[str]` | no | Tags for cross-project search (e.g. `["energy", "nj"]`). Default: `[]`. |

### `ExtensionScenario`

Returned by `list_scenarios(project)`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Machine name, unique within the project. |
| `display_name` | `str` | yes | Human-readable name. |
| `project_name` | `str` | yes | Must match the parent `ExtensionProject.name`. |
| `description` | `str` | no | Default: `""`. |
| `tags` | `list[str]` | no | Default: `[]`. |
| `parent_scenario_name` | `str \| None` | no | References another scenario's `name` for hierarchical sub-scenarios. Default: `None`. |

### `GeometryDescriptor`

Returned by `list_geometries()`. Describes a geometry the extension can serve on demand.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Unique within extension. Referenced by `DefaultLayerConfig.geometry_ref`. |
| `display_name` | `str` | yes | Human-readable name. |
| `format` | `str` | yes | One of: `"geojson"`, `"geoparquet"`, `"shapefile"`. |
| `join_key` | `str \| None` | no | Default feature property used to join with datasets. Default: `None`. |
| `description` | `str` | no | Default: `""`. |

### `DatasetDescriptor`

Returned by `list_datasets()`. Describes a dataset the extension can serve on demand.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Unique within extension. Referenced by `DefaultLayerConfig.dataset_ref` and `@input_control(invalidates=[...])`. |
| `display_name` | `str` | yes | Human-readable name. |
| `format` | `str` | yes | One of: `"parquet"`, `"csv"`. |
| `join_key` | `str \| None` | no | Default column used to join with geometry features. Default: `None`. |
| `timestamp_col` | `str \| None` | no | Column name for time partitions. `None` = static dataset (no animation). |
| `columns` | `list[str]` | no | Column names in the dataset. Default: `[]`. |
| `description` | `str` | no | Default: `""`. |

### `DefaultLayerConfig`

Returned by `list_default_layers()`. Auto-created as layers in every scenario.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Unique within extension. |
| `display_name` | `str` | yes | Human-readable name. |
| `deck_layer_type` | `str` | yes | deck.gl layer class name: `"GeoJsonLayer"`, `"ScatterplotLayer"`, `"ArcLayer"`, etc. |
| `geometry_ref` | `str` | yes | References a `GeometryDescriptor.name` from this extension. |
| `dataset_ref` | `str \| None` | no | References a `DatasetDescriptor.name`. Default: `None`. |
| `geom_join_key` | `str \| None` | no | Geometry property to join on. Default: `None` (uses geometry's `join_key`). |
| `data_join_key` | `str \| None` | no | Dataset column to join on. Default: `None` (uses dataset's `join_key`). |
| `style_mappings` | `list[dict]` | no | Visual property mappings. Default: `[]`. Each dict: `{"visual_property": str, "column": str, "colormap"?: str, "scale_type"?: str, "domain_min"?: float, "domain_max"?: float}`. |

**Style mapping fields:**

| Key | Type | Description |
|-----|------|-------------|
| `visual_property` | `str` | deck.gl accessor: `"getFillColor"`, `"getRadius"`, `"getLineWidth"`, etc. |
| `column` | `str` | Dataset column driving this property. |
| `colormap` | `str` | Color scale: `"viridis"`, `"plasma"`, `"inferno"`, `"magma"`, `"cividis"`, etc. |
| `scale_type` | `str` | `"linear"`, `"log"`, `"quantile"`. |
| `domain_min` | `float` | Minimum value for scale. |
| `domain_max` | `float` | Maximum value for scale. |

### `DuckDBTableInfo`

Returned by `register_duckdb_tables()`. Metadata about tables the extension created.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `table_name` | `str` | yes | Fully qualified name (e.g. `"ext_myext.my_table"`). The server creates the schema `ext_{name}` automatically. |
| `description` | `str` | yes | Human-readable description. |
| `columns` | `list[dict]` | no | Column metadata. Default: `[]`. Each dict: `{"name": str, "type": str, "description": str}`. |
| `extension_name` | `str` | no | Set to the extension's manifest `name`. Default: `""`. |


## Extension Base Class

All methods below are on `GridSightExtensionBase`. Only `get_manifest()` is abstract; all others have default implementations that return empty lists or raise `NotImplementedError`.

Import: `from gridsight.extensions import GridSightExtensionBase, ExtensionContext`

### Lifecycle

```python
def on_startup(self, context: ExtensionContext) -> None:
```
Called once at server startup after `get_manifest()`. Use this to store the context and initialize resources. The `context` provides `duckdb_conn`, `get_db_session`, `data_dir`, and `config`. Default: no-op.

```python
def on_shutdown(self) -> None:
```
Called when the server shuts down. Clean up resources. Default: no-op.

### Discovery

```python
def list_projects(self) -> list[ExtensionProject]:
```
Return all projects this extension provides. Called at startup during data sync. Default: `[]`.

```python
def list_scenarios(self, project: str) -> list[ExtensionScenario]:
```
Return scenarios for the given project name. Called at startup for each project. Default: `[]`.

### Geometry

```python
def list_geometries(self, project: str | None = None, scenario: str | None = None) -> list[GeometryDescriptor]:
```
Return geometry descriptors. Called at startup. `project` and `scenario` may be `None` for extension-wide geometries. Default: `[]`.

```python
def get_geometry_data(self, geometry_name: str) -> bytes:
```
Return raw geometry bytes (GeoJSON, GeoParquet, or Shapefile). Called on demand when the frontend or API requests geometry. Default: raises `NotImplementedError`.

### Datasets

```python
def list_datasets(self, project: str | None = None, scenario: str | None = None) -> list[DatasetDescriptor]:
```
Return dataset descriptors. Called at startup. Default: `[]`.

```python
def get_dataset_data(self, dataset_name: str) -> bytes:
```
Return the full dataset as bytes (Parquet or CSV). Called on demand. Default: raises `NotImplementedError`.

```python
def list_dataset_partitions(self, dataset_name: str) -> list[str]:
```
Return a list of date strings for time-partitioned datasets (e.g. `["2025-01-01", "2026-01-01"]`). Each partition is fetched individually for animation. Default: `[]`.

```python
def get_dataset_partition(self, dataset_name: str, date_str: str) -> bytes:
```
Return one partition's bytes. Called for each animation frame. Default: raises `NotImplementedError`.

### Entity Controls

For per-entity interactive controls (requires `Capability.DATA_CONTROLS`).

```python
def get_data_controls(self, project: str, scenario: str, entity_id: str) -> list[DataControl]:
```
Return controls available for a specific entity (identified by its join key value). Called when a user clicks an entity on the map. Default: `[]`.

```python
def set_control_value(self, project: str, scenario: str, entity_id: str, control_name: str, value: Any) -> ControlUpdateResult:
```
Handle a control value change for a specific entity. Default: raises `NotImplementedError`.

### Input Controls

For project/scenario-level controls with no entity context (requires `Capability.INPUT_CONTROLS`). Use the `@input_control` decorator (recommended) or override these methods directly.

```python
def get_input_controls(self, project: str, scenario: str) -> list[DataControl]:
```
Return project-level controls. The default implementation auto-discovers methods decorated with `@input_control` and builds `DataControl` instances from their metadata. Override only if you need custom logic.

```python
def set_input_control_value(self, project: str, scenario: str, control_name: str, value: Any) -> ControlUpdateResult:
```
Handle a project-level control change. The default implementation dispatches to the matching `@input_control`-decorated method. If the handler returns `None`, a default `ControlUpdateResult` is built using the decorator's `invalidates` list.

### DuckDB

```python
def register_duckdb_tables(self, conn: Any) -> list[DuckDBTableInfo]:
```
Register tables/views in the shared DuckDB connection. The server creates a schema `ext_{name}` before calling this. `conn` is a `duckdb.DuckDBPyConnection`. Return metadata about what you registered. Default: `[]`.

**Common pattern:** Register a DataFrame, then create a view in the extension schema:

```python
def register_duckdb_tables(self, conn):
    conn.register("_ext_myext_data", self._dataframe)
    conn.execute("CREATE OR REPLACE VIEW ext_myext.my_table AS SELECT * FROM _ext_myext_data")
    return [DuckDBTableInfo(table_name="ext_myext.my_table", description="...", columns=[...], extension_name="my-ext")]
```

### AI

```python
def get_ai_schema(self) -> AISchema | None:
```
Return schema context for the AI chat system. This is injected into the LLM system prompt so users can query your data with natural language. Default: `None`.

### Default Layers

```python
def list_default_layers(self) -> list[DefaultLayerConfig]:
```
Return pre-configured layers to create automatically in every scenario. Users can edit or delete these via the UI. Default: `[]`.

### Charts

```python
def list_chart_specs(self) -> list[ChartSpec]:
```
Return chart definitions. Charts use SQL templates with `{entity_id}`, `{project}`, `{scenario}` placeholders. Default: `[]`.

### Shaders

```python
def list_shader_specs(self) -> list[ShaderSpec]:
```
Return shader definitions. Default: `[]`.

```python
def get_shader_source(self, shader_name: str) -> str:
```
Return GLSL source code for the named shader. Default: raises `NotImplementedError`.


## Controls System

Import: `from gridsight.extensions.controls import ControlType, DataControl, ControlUpdateResult, input_control`

### `ControlType` Enum

| Value | Widget |
|-------|--------|
| `SLIDER` | Numeric slider with min/max/step |
| `DROPDOWN` | Dropdown with labeled options |
| `TEXT` | Free-text input |
| `NUMBER` | Numeric input |
| `TOGGLE` | Boolean toggle switch |

### `DataControl`

Describes a single control widget.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Machine name. |
| `display_name` | `str` | yes | Label shown in UI. |
| `type` | `ControlType` | yes | Widget type. |
| `current_value` | `Any` | yes | Current value. |
| `default_value` | `Any` | no | Default value for reset. |
| `min` | `float \| None` | no | Minimum (slider/number). |
| `max` | `float \| None` | no | Maximum (slider/number). |
| `step` | `float \| None` | no | Step size (slider/number). |
| `unit` | `str \| None` | no | Display unit (e.g. `"%"`, `"MW"`). |
| `options` | `list[dict] \| None` | no | Dropdown options: `[{"label": str, "value": Any}, ...]`. |
| `group` | `str \| None` | no | Group heading in UI. |
| `read_only` | `bool` | no | If `True`, shown but not editable. Default: `False`. |

### `@input_control` Decorator

Tags a method as a project-level input control handler. The framework auto-discovers decorated methods and exposes them via the API.

```python
@input_control(
    name="growth_factor",           # machine name (required)
    display_name="Growth Factor",   # UI label (required)
    type=ControlType.SLIDER,        # widget type (required)
    default=25,                     # initial value
    min=0,                          # minimum
    max=100,                        # maximum
    step=5,                         # step size
    unit="%",                       # display unit
    group="Parameters",             # UI group heading
    invalidates=["my-dataset"],     # dataset names to refresh on change
    read_only=False,                # if True, display-only
    options=None,                   # for DROPDOWN: [{"label": ..., "value": ...}]
)
def handle_growth_factor(self, value: float):
    # Process the new value. Optionally return ControlUpdateResult.
    # If you return None, a default success result is built using invalidates.
    self._factor = value
    self._regenerate_data()
    self._refresh_duckdb()
```

### `ControlUpdateResult`

Returned by control handlers.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `success` | `bool` | yes | Whether the update succeeded. |
| `new_value` | `Any` | no | The accepted value (may differ from input). |
| `message` | `str \| None` | no | Status message for the UI. |
| `invalidated_datasets` | `list[str]` | no | Dataset names the frontend should re-fetch. Default: `[]`. |
| `tiered_response` | `TieredResponse \| None` | no | Optional visualization guidance. Default: `None`. |

### Tiered Response System

Extensions can optionally guide how the UI visualizes the result of a control change.

**`ResponseTier` Enum:**

| Value | Meaning |
|-------|---------|
| `DATA_REF` (1) | Just a table/column reference — UI/AI decides visualization. |
| `DATA_WITH_HINTS` (2) | Table/column + `VizHint` guidance. |
| `FULL_VIZ_CONFIG` (3) | Complete chart/map configuration — UI renders as-is. |

**`TieredResponse`:**

| Field | Type | Tier | Description |
|-------|------|------|-------------|
| `tier` | `ResponseTier` | all | Which tier. |
| `table` | `str \| None` | 1+ | DuckDB table name. |
| `column` | `str \| None` | 1+ | Primary column of interest. |
| `columns` | `list[str] \| None` | 1+ | Multiple columns of interest. |
| `hint` | `VizHint \| None` | 2 | Visualization guidance. |
| `chart_type` | `str \| None` | 3 | `"plotly"`, `"chartjs"`, `"vega"`, `"deck"`. |
| `config` | `dict \| None` | 3 | Complete chart/layer config. |

**`VizHint`:**

| Field | Type | Description |
|-------|------|-------------|
| `hint_type` | `str` | `"timeseries"`, `"categorical"`, `"geospatial"`, `"scalar"`. |
| `animate` | `bool` | Whether to animate. Default: `False`. |
| `suggested_chart` | `str \| None` | `"line"`, `"bar"`, `"choropleth"`, `"scatter"`. |
| `color_scheme` | `str \| None` | Colormap name (e.g. `"viridis"`). |
| `compare_with` | `str \| None` | Column name for side-by-side comparison. |

Import: `from gridsight.extensions.controls import ResponseTier, TieredResponse, VizHint`


## Charts and Shaders

Import: `from gridsight.extensions.charts import ChartSpec, ShaderSpec`

### `ChartSpec`

SQL-template-driven chart definition.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Machine name (e.g. `"dispatch_stack"`). |
| `display_name` | `str` | yes | UI label. |
| `chart_type` | `str` | yes | `"bar"`, `"line"`, `"scatter"`, `"plotly"`. |
| `sql_template` | `str` | yes | SQL with placeholders: `{entity_id}`, `{project}`, `{scenario}`. Server executes this and returns results to the frontend. |
| `chart_options` | `dict` | no | Plotly layout or Chart.js options. Default: `{}`. |
| `width` | `int` | no | Chart width in pixels. Default: `300`. |
| `height` | `int` | no | Chart height in pixels. Default: `200`. |
| `datasets` | `list[str]` | no | Dataset names this chart depends on. Default: `[]`. |
| `format` | `str` | no | Rendering format: `"plotly"`, `"vega-lite"`, or `"chartgpu"`. Default: `"plotly"`. |

**SQL template example:**

```python
ChartSpec(
    name="demand-trend",
    display_name="Demand Over Time",
    chart_type="line",
    sql_template="SELECT year, peak_demand_mw FROM ext_myext.projections WHERE GEOID = '{entity_id}' ORDER BY year",
    format="plotly",
)
```

### `ShaderSpec`

Custom GLSL or deck.gl layer extension.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `str` | yes | Machine name. |
| `display_name` | `str` | yes | UI label. |
| `shader_type` | `str` | yes | `"vertex"`, `"fragment"`, or `"deck_extension"`. |
| `js_module` | `str \| None` | no | JavaScript module path (for deck extensions). |
| `js_export` | `str \| None` | no | Named export from the JS module. |


## AI Integration

Import: `from gridsight.extensions.ai import AISchema, AITableSchema, AIControlSchema`

The AI chat system builds its system prompt from all extensions with `Capability.AI_QUERYABLE`. The prompt includes table schemas, column descriptions, example queries, and example prompts. The AI has tools to execute DuckDB queries, create charts, update controls, and inspect data lineage.

### `AISchema`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `description` | `str` | yes | What this extension does. Injected into the LLM system prompt. Be specific about data coverage, geographic scope, and time range. |
| `tables` | `list[AITableSchema]` | no | Table descriptions. Default: `[]`. |
| `controls` | `list[AIControlSchema]` | no | Control descriptions. Default: `[]`. |
| `example_prompts` | `list[str]` | no | Natural language questions users might ask. Shown as suggestions. Default: `[]`. |

### `AITableSchema`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `table_name` | `str` | yes | Fully qualified DuckDB table name (e.g. `"ext_myext.projections"`). |
| `description` | `str` | yes | What data this table contains. Include row count estimates, geographic coverage, and time range. |
| `columns` | `list[dict]` | no | Column metadata: `[{"name": str, "type": str, "description": str}, ...]`. Default: `[]`. |
| `example_queries` | `list[str]` | no | Valid SQL queries demonstrating useful patterns. Default: `[]`. |

### `AIControlSchema`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `control_name` | `str` | yes | Matches the control's `name` field. |
| `description` | `str` | yes | What this control does. |
| `value_type` | `str` | yes | `"float"`, `"int"`, `"string"`, `"bool"`. |
| `value_range` | `str \| None` | no | Human-readable range (e.g. `"0.0 - 1.0"`). |


## ExtensionContext

Passed to `on_startup()`. Store it for later use.

```python
from gridsight.extensions import ExtensionContext
```

| Field | Type | Description |
|-------|------|-------------|
| `data_dir` | `str` | Path to the platform's data directory. |
| `config` | `dict[str, Any]` | Extension-specific configuration (if provided by the server). |
| `duckdb_conn` | `duckdb.DuckDBPyConnection` | Shared in-memory DuckDB connection. Available after startup. |
| `get_db_session` | `callable` | Returns a SQLAlchemy session for the platform's metadata database. |


## Packaging and Registration

### Directory Structure

```
my-extension/
├── pyproject.toml
└── src/
    └── my_package/
        ├── __init__.py          # exports MyExtension
        ├── extension.py         # MyExtension class
        └── data/                # optional: bundled data files
            ├── geometries.geojson
            └── dataset.parquet
```

### `pyproject.toml`

```toml
[project]
name = "my-extension"
version = "0.1.0"
description = "My extension for GridSight"
requires-python = ">=3.12"
dependencies = [
    "gridsight-sdk",
]

[project.entry-points."gridsight.extensions"]
my_ext = "my_package.extension:MyExtension"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/my_package"]
```

### `__init__.py`

```python
from .extension import MyExtension

__all__ = ["MyExtension"]
```

### Development Install

See **[Installing Extensions](#installing-extensions)** at the top of
this guide for the dev-tree (editable) and container (pinned remote)
install paths.


## Complete Walkthrough

This walkthrough builds an extension step by step.

### Step 1: Scaffold

Create the directory structure above. Set up `pyproject.toml` and `__init__.py`.

### Step 2: Manifest and Startup

```python
from gridsight.extensions import (
    GridSightExtensionBase, ExtensionManifest, ExtensionContext, Capability,
)

class MyExtension(GridSightExtensionBase):
    def __init__(self):
        self._context = None

    def get_manifest(self):
        return ExtensionManifest(
            name="my-ext",
            display_name="My Extension",
            version="0.1.0",
            description="County-level data visualization.",
            capabilities=[
                Capability.DATA_PROVIDER,
                Capability.DUCKDB_TABLES,
                Capability.AI_QUERYABLE,
                Capability.INPUT_CONTROLS,
            ],
            icon="bolt",
        )

    def on_startup(self, context: ExtensionContext):
        self._context = context
```

### Step 3: Projects and Scenarios

```python
from gridsight.extensions import ExtensionProject, ExtensionScenario

    def list_projects(self):
        return [ExtensionProject(
            name="forecast", display_name="Forecast", tags=["energy"],
        )]

    def list_scenarios(self, project):
        if project == "forecast":
            return [ExtensionScenario(
                name="base", display_name="Base Case", project_name="forecast",
            )]
        return []
```

### Step 4: Geometry

Serve a GeoJSON file bundled with your package.

```python
from pathlib import Path
from gridsight.extensions import GeometryDescriptor

DATA_DIR = Path(__file__).parent / "data"

    def list_geometries(self, project=None, scenario=None):
        return [GeometryDescriptor(
            name="counties", display_name="Counties",
            format="geojson", join_key="GEOID",
        )]

    def get_geometry_data(self, geometry_name):
        if geometry_name == "counties":
            return (DATA_DIR / "counties.geojson").read_bytes()
        raise NotImplementedError(f"Unknown geometry: {geometry_name}")
```

### Step 5: Datasets

Serve a Parquet dataset. For animated data, implement `list_dataset_partitions` and `get_dataset_partition`.

```python
import io
from gridsight.extensions import DatasetDescriptor

    def list_datasets(self, project=None, scenario=None):
        return [DatasetDescriptor(
            name="demand", display_name="Demand Data",
            format="parquet", join_key="GEOID",
            timestamp_col=None,  # static; set to column name for animation
            columns=["GEOID", "peak_demand_mw", "annual_energy_gwh"],
        )]

    def get_dataset_data(self, dataset_name):
        if dataset_name == "demand":
            buf = io.BytesIO()
            self._dataframe.to_parquet(buf, index=False)
            return buf.getvalue()
        raise NotImplementedError(f"Unknown dataset: {dataset_name}")
```

### Step 6: Default Layer

Configure a choropleth that renders automatically.

```python
from gridsight.extensions import DefaultLayerConfig

    def list_default_layers(self):
        return [DefaultLayerConfig(
            name="demand-choropleth",
            display_name="Demand Choropleth",
            deck_layer_type="GeoJsonLayer",
            geometry_ref="counties",
            dataset_ref="demand",
            style_mappings=[{
                "visual_property": "getFillColor",
                "column": "peak_demand_mw",
                "colormap": "viridis",
                "scale_type": "linear",
                "domain_min": 100,
                "domain_max": 5000,
            }],
        )]
```

### Step 7: DuckDB Table

Register your data so users and AI can query it with SQL.

```python
from gridsight.extensions import DuckDBTableInfo

    def register_duckdb_tables(self, conn):
        conn.register("_ext_myext_data", self._dataframe)
        conn.execute(
            "CREATE OR REPLACE VIEW ext_myext.demand "
            "AS SELECT * FROM _ext_myext_data"
        )
        return [DuckDBTableInfo(
            table_name="ext_myext.demand",
            description="County-level demand projections.",
            columns=[
                {"name": "GEOID", "type": "VARCHAR", "description": "County FIPS code"},
                {"name": "peak_demand_mw", "type": "DOUBLE", "description": "Peak demand in MW"},
                {"name": "annual_energy_gwh", "type": "DOUBLE", "description": "Annual energy in GWh"},
            ],
            extension_name="my-ext",
        )]
```

### Step 8: Input Control

Add a slider that re-generates data when changed.

```python
from gridsight.extensions.controls import ControlType, ControlUpdateResult, input_control

    @input_control(
        name="growth_factor",
        display_name="Growth Factor",
        type=ControlType.SLIDER,
        default=25, min=0, max=100, step=5, unit="%",
        group="Parameters",
        invalidates=["demand"],
    )
    def handle_growth_factor(self, value):
        self._growth = float(value)
        self._regenerate_data()
        self._refresh_duckdb()
        return ControlUpdateResult(
            success=True,
            new_value=float(value),
            invalidated_datasets=["demand"],
        )
```

### Step 9: AI Schema

Tell the AI about your data so users can query it with natural language.

```python
from gridsight.extensions.ai import AISchema, AITableSchema

    def get_ai_schema(self):
        return AISchema(
            description="County-level energy demand projections with growth factor control.",
            tables=[AITableSchema(
                table_name="ext_myext.demand",
                description="Demand data for all counties, one row per county per year.",
                columns=[
                    {"name": "GEOID", "type": "VARCHAR", "description": "County FIPS code"},
                    {"name": "peak_demand_mw", "type": "DOUBLE", "description": "Peak demand in MW"},
                    {"name": "annual_energy_gwh", "type": "DOUBLE", "description": "Annual energy in GWh"},
                ],
                example_queries=[
                    "SELECT * FROM ext_myext.demand ORDER BY peak_demand_mw DESC LIMIT 10",
                ],
            )],
            example_prompts=[
                "Which counties have the highest peak demand?",
                "Show total energy consumption trends.",
            ],
        )
```

### Step 10: Install and Test

```bash
cd my-extension
uv pip install -e .
cd ../  # back to platform root
./dev.sh
```

Open the browser. Your extension's project should appear in the project selector, with a choropleth layer auto-created in the base scenario.


## Reference Examples

- **DemandTldr extension:** A real-world extension that bridges the demand100 energy forecasting CLI tool into the platform, serving US county geometries and forecast data with time partitions for animation.
- **GAT extension:** A power-system simulation extension that exposes Grid Analysis Toolkit results (generators, lines, buses, dispatch dispatch timeseries) as a GridSight project.
