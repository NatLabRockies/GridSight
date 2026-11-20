"""Shared ORM-row serializers used by multiple route modules."""
from __future__ import annotations

import json

from models.orm import Dataset, GeometryFile


def serialize_geometry(geo: GeometryFile) -> dict:
    bbox = None
    if getattr(geo, "bbox_json", None):
        try:
            bbox = json.loads(geo.bbox_json)
        except Exception:
            bbox = None
    return {
        "id": geo.id,
        "name": geo.name,
        "file_id": geo.content_hash,
        "original_filename": geo.original_filename,
        "format": geo.format,
        "join_key": geo.join_key,
        "display_name": geo.display_name,
        "description": geo.description,
        "scope": getattr(geo, "scope", "scenario"),
        "extension_name": geo.extension_name,
        # Spatial serving: when is_spatial, clients fetch /viewport (bbox+zoom)
        # instead of the whole-GeoJSON /data endpoint.
        "is_spatial": bool(getattr(geo, "is_spatial", False)),
        "bbox": bbox,
        "feature_count": getattr(geo, "feature_count", None),
        "category_col": getattr(geo, "category_col", None),
    }


def serialize_dataset(ds: Dataset | None) -> dict | None:
    if not ds:
        return None
    return {
        "id": ds.id,
        "name": ds.name,
        "extension_ref": getattr(ds, "extension_ref", None),
        "extension_name": getattr(ds, "extension_name", None),
        "file_id": ds.content_hash,
        "original_filename": ds.original_filename,
        "format": ds.format,
        "join_key": ds.join_key,
        "timestamp_col": ds.timestamp_col,
        "value_min": getattr(ds, "value_min", None),
        "value_max": getattr(ds, "value_max", None),
        "display_name": getattr(ds, "display_name", None),
        "description": getattr(ds, "description", None),
        "scope": getattr(ds, "scope", "scenario"),
    }


def file_suffix(original_filename: str | None) -> str:
    if original_filename:
        return original_filename.rsplit(".", 1)[-1].lower()
    return "csv"
