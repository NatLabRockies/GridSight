"""
Bridge between extension on-demand data and existing data-serving routes.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .registry import ExtensionRegistry

logger = logging.getLogger(__name__)


class ExtensionStorageAdapter:
    """Fetches data from extensions on-demand for existing API routes."""

    def __init__(self, registry: ExtensionRegistry) -> None:
        self.registry = registry

    def get_geometry_bytes(self, extension_name: str, geometry_ref: str) -> bytes:
        ext = self.registry.get(extension_name)
        if ext is None:
            raise ValueError(f"Unknown extension: {extension_name}")
        # Layer-owned geometries use get_layer_geometry()
        if geometry_ref.startswith("__layer_geo__"):
            layer_name = geometry_ref.removeprefix("__layer_geo__")
            logger.debug("[storage_adapter] get_layer_geometry(%s, %s)", extension_name, layer_name)
            data = ext.get_layer_geometry(layer_name)
            logger.debug("[storage_adapter] returned %d bytes", len(data) if data else 0)
            return data
        return ext.get_geometry_data(geometry_ref)

    def get_dataset_bytes(self, extension_name: str, dataset_ref: str) -> bytes:
        ext = self.registry.get(extension_name)
        if ext is None:
            raise ValueError(f"Unknown extension: {extension_name}")
        return ext.get_dataset_data(dataset_ref)

    def get_dataset_partition_bytes(
        self, extension_name: str, dataset_ref: str, date_str: str
    ) -> bytes:
        ext = self.registry.get(extension_name)
        if ext is None:
            raise ValueError(f"Unknown extension: {extension_name}")
        return ext.get_dataset_partition(dataset_ref, date_str)

    def get_dataset_metadata(self, extension_name: str, dataset_ref: str):
        """Try the fast metadata path. Returns DatasetTimeInfo or None."""
        ext = self.registry.get(extension_name)
        if ext is None:
            return None
        return ext.get_dataset_metadata(dataset_ref)

    def list_dataset_partitions(
        self, extension_name: str, dataset_ref: str
    ) -> list[str]:
        ext = self.registry.get(extension_name)
        if ext is None:
            raise ValueError(f"Unknown extension: {extension_name}")
        return ext.list_dataset_partitions(dataset_ref)

    def get_entity_timeseries(
        self, extension_name: str, dataset_ref: str, entity_id: str,
    ) -> dict | None:
        """Try the extension's fast single-entity path. None = not implemented."""
        ext = self.registry.get(extension_name)
        if ext is None:
            return None
        try:
            return ext.get_entity_timeseries(dataset_ref, entity_id)
        except Exception:
            logger.exception(
                "[storage_adapter] get_entity_timeseries failed for %s/%s/%s",
                extension_name, dataset_ref, entity_id,
            )
            return None

    def get_entity_series(
        self,
        extension_name: str,
        dataset_ref: str,
        entity_id: str,
        from_ts: str | None,
        to_ts: str | None,
        max_points: int | None,
    ) -> bytes | None:
        """Windowed entity series — Arrow IPC bytes, or None to fall back."""
        ext = self.registry.get(extension_name)
        if ext is None:
            return None
        try:
            return ext.get_entity_series(
                dataset_ref, entity_id, from_ts, to_ts, max_points,
            )
        except Exception:
            logger.exception(
                "[storage_adapter] get_entity_series failed for %s/%s/%s",
                extension_name, dataset_ref, entity_id,
            )
            return None
