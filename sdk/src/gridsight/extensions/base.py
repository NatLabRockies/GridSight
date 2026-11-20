"""
Base class and context for GridSight extensions.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .models import (
    CategoryMapDescriptor,
    DatasetDescriptor,
    DatasetTimeInfo,
    DefaultLayerConfig,
    DuckDBTableInfo,
    ExtensionManifest,
    ExtensionProject,
    ExtensionScenario,
    FileUploadSpec,
    GeometryDescriptor,
    GraphTopology,
    GraphTopologyDescriptor,
    LayerDefinition,
    PreviewResult,
    UploadResult,
)

if TYPE_CHECKING:
    from .ai import AISchema
    from .charts import ChartSpec, ShaderSpec
    from .controls import ControlUpdateResult, DataControl


@dataclass
class ExtensionContext:
    """Runtime context passed to extensions during startup."""

    data_dir: str = ""
    config: dict[str, Any] = field(default_factory=dict)
    # Populated by the server at startup:
    duckdb_conn: Any = None  # duckdb.DuckDBPyConnection
    # Shared lock for duckdb_conn. DuckDB connections are not thread-safe;
    # concurrent queries on the same connection raise "closed pending query
    # result". Extensions that touch duckdb_conn MUST acquire this lock for
    # the full duration of their query (execute + fetch). Reentrant so
    # helpers can re-acquire.
    duckdb_lock: Any = None  # threading.RLock
    get_db_session: Any = None  # callable returning SQLAlchemy session


class GridSightExtensionBase(ABC):
    """Abstract base class every GridSight extension must subclass."""

    @abstractmethod
    def get_manifest(self) -> ExtensionManifest:
        """Return the extension's metadata manifest."""
        ...

    # -- Discovery --

    def list_projects(self) -> list[ExtensionProject]:
        return []

    def list_scenarios(self, project: str) -> list[ExtensionScenario]:
        return []

    # -- Geometry provision --

    def list_geometries(
        self, project: str | None = None, scenario: str | None = None
    ) -> list[GeometryDescriptor]:
        return []

    def get_geometry_data(self, geometry_name: str) -> bytes:
        raise NotImplementedError

    # -- Dataset provision --

    def list_datasets(
        self, project: str | None = None, scenario: str | None = None
    ) -> list[DatasetDescriptor]:
        return []

    def get_dataset_data(self, dataset_name: str) -> bytes:
        raise NotImplementedError

    def list_dataset_partitions(self, dataset_name: str) -> list[str]:
        return []

    def get_dataset_partition(self, dataset_name: str, date_str: str) -> bytes:
        raise NotImplementedError

    def get_dataset_metadata(self, dataset_name: str) -> DatasetTimeInfo | None:
        """Return fast time-range metadata for a timeseries dataset.

        Extensions should implement this to avoid the slow partition-probing
        fallback. Return None to use the default behavior (deserialize each
        partition to count rows).
        """
        return None

    def get_entity_timeseries(
        self, dataset_name: str, entity_id: str,
    ) -> dict | None:
        """Return one entity's full timeseries as
        ``{"timestamps": [...], "values": [...]}``.

        Optional fast path for the entity-timeseries endpoint. Default
        returns None so the server falls back to iterating per-partition
        bytes (slow when the underlying store is wide-format and would
        otherwise require unpivoting every day). Extensions backed by a
        wide-format table can implement this with a single column read.
        """
        return None

    def get_entity_series(
        self,
        dataset_name: str,
        entity_id: str,
        from_ts: str | None = None,
        to_ts: str | None = None,
        max_points: int | None = None,
    ) -> bytes | None:
        """Return a windowed slice of one entity's timeseries as Arrow IPC.

        Used by the entity-inspector chart so a click only fetches the
        currently visible window (e.g. 72 h around the animation cursor)
        instead of the entire year. Implementations should project only
        the requested time range from their backing store — for
        wide-format tables that means selecting just the timestamp
        columns in ``[from_ts, to_ts]``.

        Args:
            dataset_name: extension dataset reference (matches what
                ``get_dataset_partition`` uses).
            entity_id: column / row key for the entity.
            from_ts: inclusive lower bound, ISO 8601 (e.g.
                ``"2035-02-14T00:00:00"``). ``None`` = no lower bound.
            to_ts: inclusive upper bound, ISO 8601. ``None`` = no upper
                bound.
            max_points: if set and the projected series would exceed
                this, downsample (LTTB or mean) to at most this many
                points before returning. ``None`` = no downsample.

        Returns Arrow IPC bytes for a table with two columns:
            ``timestamp`` (timestamp[us] or string) and
            ``value`` (float64).

        Return ``None`` to fall back to ``get_entity_timeseries`` + slice
        on the server side. Implement this when your store can do a
        cheap range projection."""
        return None

    # -- Controls --

    def get_data_controls(
        self, project: str, scenario: str, entity_id: str
    ) -> list[DataControl]:
        return []

    def set_control_value(
        self,
        project: str,
        scenario: str,
        entity_id: str,
        control_name: str,
        value: Any,
    ) -> ControlUpdateResult:
        raise NotImplementedError

    # -- Input Controls (project/scenario-level, no entity context) --
    #
    # The default implementations auto-dispatch to methods decorated with
    # @input_control.  Extensions can either use the decorator (recommended)
    # or override these methods directly.

    def get_input_controls(
        self, project: str, scenario: str
    ) -> list[DataControl]:
        from .controls import DataControl, _collect_input_controls

        values = getattr(self, "_input_control_values", {})
        controls: list[DataControl] = []
        for _name, (meta, _fn) in _collect_input_controls(self).items():
            controls.append(
                DataControl(
                    name=meta["name"],
                    display_name=meta["display_name"],
                    type=meta["type"],
                    current_value=values.get(meta["name"], meta["default"]),
                    default_value=meta["default"],
                    min=meta["min"],
                    max=meta["max"],
                    step=meta["step"],
                    unit=meta["unit"],
                    options=meta["options"],
                    group=meta["group"],
                    read_only=meta["read_only"],
                )
            )
        return controls

    def set_input_control_value(
        self,
        project: str,
        scenario: str,
        control_name: str,
        value: Any,
    ) -> ControlUpdateResult:
        from .controls import ControlUpdateResult, _collect_input_controls

        registry = _collect_input_controls(self)
        entry = registry.get(control_name)
        if entry is None:
            raise NotImplementedError(f"Unknown input control: {control_name}")
        meta, handler = entry
        result = handler(value)
        if result is None:
            result = ControlUpdateResult(
                success=True,
                new_value=value,
                invalidated_datasets=list(meta["invalidates"]),
            )
        # Track the live value so get_input_controls returns it next time.
        if not hasattr(self, "_input_control_values"):
            self._input_control_values = {}
        self._input_control_values[control_name] = result.new_value if result.new_value is not None else value
        return result

    # -- Category Maps --

    def list_category_maps(
        self, project: str | None = None, scenario: str | None = None
    ) -> list[CategoryMapDescriptor]:
        """Return category maps this extension provides.

        Category maps define entity→category mappings used for grouped
        aggregation (e.g., generators grouped by fuel type).
        """
        return []

    def get_category_map_data(self, category_map_name: str) -> bytes:
        """Return category map data as Parquet bytes.

        The Parquet file must have at least two columns matching
        the CategoryMapDescriptor's entity_column and category_column.
        """
        raise NotImplementedError

    # -- File Upload --

    def get_upload_specs(self) -> list[FileUploadSpec]:
        """Return upload specifications this extension accepts.

        Each spec describes a set of file groups and form fields
        that the extension can process (e.g., system JSON + simulation HDF5).
        """
        return []

    def handle_upload(
        self,
        spec_name: str,
        file_paths: dict[str, list[str]],
        form_data: dict[str, str],
    ) -> UploadResult:
        """Process uploaded files according to the named upload spec.

        Args:
            spec_name: Which upload spec is being fulfilled.
            file_paths: Mapping from FileGroupSpec.name to local file paths
                        where the server has saved the uploaded files.
            form_data: Key-value pairs from the upload form fields.

        Returns:
            UploadResult indicating success/failure.
        """
        raise NotImplementedError

    def handle_preview(
        self,
        spec_name: str,
        file_paths: dict[str, list[str]],
        form_data: dict[str, str],
    ) -> PreviewResult:
        """Inspect an uploaded file before commit and return preview data.

        Used by upload specs that need a confirmation step — e.g. picking
        which CSV column maps to a bus ID, previewing a join's match rate
        before persisting anything. The shape of `data` is per-spec; the
        UI dialog and the extension agree on the contract.

        Default implementation reports preview not supported. Override for
        any spec where `FileUploadSpec.supports_preview = True`.
        """
        return PreviewResult(success=False, error="Preview not supported by this extension/spec.")

    def handle_query(self, kind: str, params: dict[str, Any]) -> Any:
        """Synchronous read-only data fetch — extension-defined `kind` dispatch.

        Used for diagnostic / inspection UIs (e.g. "list components in this
        Sienna system + return one as a row table"). The frontend calls
        `POST /api/extensions/{ext}/query/{kind}` with a JSON body; the
        server forwards `(kind, body)` here and returns whatever this
        method returns as JSON.

        Implementations should treat unknown `kind` as an error so the
        frontend gets a clear signal rather than a silent empty result.
        """
        raise NotImplementedError(f"Extension does not support query kind: {kind!r}")

    def delete_scenario(self, project: str, scenario: str) -> bool:
        """Delete a scenario's data from the extension's backing store.

        Implementations should remove the scenario's underlying tables,
        files, and registry entries so a subsequent upload of the same
        (project, scenario) starts clean. The server handles ORM-side
        cleanup (Scenario row + cascading layer/dataset/geometry rows)
        after this returns truthy.

        Returns:
            True if the scenario was deleted, False if it didn't exist.
        """
        raise NotImplementedError

    # -- DuckDB --

    def register_duckdb_tables(self, conn: Any) -> list[DuckDBTableInfo]:
        return []

    # -- AI --

    def get_ai_schema(self) -> AISchema | None:
        return None

    # -- Layers (unified API) --

    def list_layers(
        self, project: str | None = None, scenario: str | None = None
    ) -> list[LayerDefinition]:
        """Return layer definitions for a project/scenario.

        Each LayerDefinition bundles the layer config with metadata.
        Geometry is built lazily via get_layer_geometry().
        """
        return []

    def get_layer_geometry(self, layer_name: str) -> bytes:
        """Return GeoJSON bytes for a layer. Called lazily on demand."""
        raise NotImplementedError

    # -- Graph topologies (non-geospatial network views) --

    def list_graph_topologies(
        self, project: str | None = None, scenario: str | None = None
    ) -> list[GraphTopologyDescriptor]:
        """Return graph topologies (nodes + edges + optional strata) the
        extension can serve. Default: none. Extensions declaring the
        ``GRAPH_PROVIDER`` capability override this.
        """
        return []

    def get_graph_topology(
        self, topology_name: str, project: str | None = None, scenario: str | None = None
    ) -> GraphTopology | None:
        """Return a fully-populated GraphTopology.

        If nodes lack (x, y) coordinates, the server fills them in with
        the default stratified layout before the payload reaches the
        client. Return ``None`` if the named topology doesn't exist.
        """
        return None

    # -- Default Layers (legacy) --

    def list_default_layers(self) -> list[DefaultLayerConfig]:
        """Return pre-configured layers to create on first startup."""
        return []

    # -- Charts / Shaders --

    def list_chart_specs(self) -> list[ChartSpec]:
        return []

    def resolve_chart_spec(self, chart_name: str) -> ChartSpec | None:
        """Resolve a single chart spec by name for the data endpoint.

        The chart-data route first looks for ``chart_name`` in
        ``list_chart_specs()``. That list reflects the extension's *current*
        state, so a name whose identity encodes mutable control state (e.g.
        a token baked into the name to force the UI to re-fetch) can fail to
        match if the state has since changed — especially when one extension
        instance is shared across multiple synced clients.

        Override this to resolve such names statelessly: parse the parameters
        back out of ``chart_name`` and return a freshly-built ChartSpec
        regardless of current control state. The default returns None, which
        preserves the original "not found" behaviour for extensions whose
        chart names are stable.
        """
        return None

    def list_shader_specs(self) -> list[ShaderSpec]:
        return []

    def get_shader_source(self, shader_name: str) -> str:
        raise NotImplementedError

    # -- Branding --

    def get_icon_bytes(self) -> bytes | None:
        """Optional binary icon for the extension's drawer entry.

        Default returns None — the UI then falls back to whatever
        `manifest.icon` carries (a Material icon name like 'bolt'), or
        the generic Extension glyph if that's also unset. Override to
        ship a custom asset alongside the package, e.g.::

            from pathlib import Path
            def get_icon_bytes(self) -> bytes | None:
                return (Path(__file__).parent / "static" / "icon.svg").read_bytes()

        The server exposes the bytes at `/api/extensions/{name}/icon`
        and rewrites `manifest.icon` to that URL when this method
        returns non-None, so the frontend renders the asset directly.
        """
        return None

    # -- Lifecycle --

    def on_startup(self, context: ExtensionContext) -> None:
        pass

    def on_shutdown(self) -> None:
        pass
