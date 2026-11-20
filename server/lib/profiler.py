"""Join compatibility profiler.

Discovers which datasets can be joined to which geometries by comparing
column names and value overlap.  Results are stored as JoinHint rows in
the database for the frontend to surface as suggestions.
"""

from __future__ import annotations

import io
import json
import logging
from typing import TYPE_CHECKING

import polars as pl

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from lib.storage.base import StorageHandler

from models.orm import Dataset, GeometryFile, JoinHint

logger = logging.getLogger(__name__)

# Column names commonly used as geographic join keys.
_JOIN_ALIASES: dict[str, set[str]] = {
    "geoid": {"geoid", "geo_id", "fips", "county_fips", "geoid10", "geoid20"},
    "statefp": {"statefp", "state_fips", "st_fips", "state_fp"},
    "gisjoin": {"gisjoin", "gis_join"},
}

# Minimum overlap ratio to record a hint.
_MIN_OVERLAP = 0.10

# Maximum values to sample per column/property.
_MAX_SAMPLE = 2000


def _file_suffix(filename: str | None) -> str:
    if not filename:
        return "csv"
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else "csv"


def _names_compatible(ds_col: str, geo_key: str) -> bool:
    """Check if a dataset column and geometry property are name-compatible."""
    a = ds_col.lower().strip()
    b = geo_key.lower().strip()
    if a == b:
        return True
    # Check alias groups — if both belong to the same group, they match.
    for _canon, aliases in _JOIN_ALIASES.items():
        if a in aliases and b in aliases:
            return True
    return False


def _read_geometry_values(
    geo: GeometryFile, storage: "StorageHandler"
) -> dict[str, set[str]]:
    """Read unique values per property from a geometry file.

    Returns a dict mapping property names to sets of string values (capped
    at _MAX_SAMPLE per property).
    """
    data = storage.read_file_bytes(geo.content_hash)
    geojson = json.loads(data)
    features = geojson.get("features", [])
    if not features:
        return {}

    properties = list(features[0].get("properties", {}).keys())
    result: dict[str, set[str]] = {p: set() for p in properties}
    for f in features:
        props = f.get("properties", {})
        for p in properties:
            v = props.get(p)
            if v is not None and len(result[p]) < _MAX_SAMPLE:
                result[p].add(str(v))
    return result


def _read_dataset_values(
    ds: Dataset, storage: "StorageHandler"
) -> dict[str, set[str]]:
    """Read unique values per column from a dataset file.

    Reads up to _MAX_SAMPLE rows and collects unique string values per
    column.  Only string/integer columns are considered (floats are rarely
    join keys).
    """
    raw = storage.read_file_bytes(ds.content_hash)
    suffix = _file_suffix(ds.original_filename)
    df = (
        pl.read_parquet(io.BytesIO(raw), n_rows=_MAX_SAMPLE)
        if suffix == "parquet"
        else pl.read_csv(io.BytesIO(raw), n_rows=_MAX_SAMPLE)
    )

    result: dict[str, set[str]] = {}
    for col in df.columns:
        dtype = df[col].dtype
        # Only profile string and integer columns — floats are not join keys.
        if dtype in (pl.Utf8, pl.String) or dtype.is_integer():
            vals = df[col].drop_nulls().cast(pl.Utf8).unique().to_list()
            result[col] = set(vals[:_MAX_SAMPLE])
    return result


def profile_dataset_against_geometries(
    dataset_id: int,
    session: "Session",
    storage: "StorageHandler",
) -> int:
    """Profile a dataset against all geometries and create JoinHint rows.

    Returns the number of hints created or updated.
    """
    ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
    if not ds:
        return 0

    try:
        ds_values = _read_dataset_values(ds, storage)
    except Exception:
        logger.warning("Failed to read dataset %s for profiling", ds.name, exc_info=True)
        return 0

    if not ds_values:
        return 0

    geometries = session.query(GeometryFile).all()
    hints_count = 0

    for geo in geometries:
        # Skip geometries without stored data (lazy-loaded extension geo).
        if not geo.content_hash:
            continue
        try:
            geo_values = _read_geometry_values(geo, storage)
        except Exception:
            logger.debug("Skipping geometry %s during profiling", geo.name, exc_info=True)
            continue

        for ds_col, ds_vals in ds_values.items():
            if not ds_vals:
                continue
            for geo_key, geo_vals in geo_values.items():
                if not geo_vals:
                    continue

                # Fast filter: require name compatibility or significant value overlap.
                names_match = _names_compatible(ds_col, geo_key)

                overlap_set = ds_vals & geo_vals
                overlap_ratio = len(overlap_set) / len(geo_vals) if geo_vals else 0.0

                if not names_match and overlap_ratio < _MIN_OVERLAP:
                    continue
                if overlap_ratio < 0.01:
                    continue

                sample_size = len(geo_vals)

                # Upsert: update overlap if hint already exists.
                existing = (
                    session.query(JoinHint)
                    .filter(
                        JoinHint.dataset_id == ds.id,
                        JoinHint.geometry_id == geo.id,
                        JoinHint.dataset_column == ds_col,
                        JoinHint.geometry_key == geo_key,
                    )
                    .first()
                )
                if existing:
                    existing.overlap = overlap_ratio
                    existing.sample_size = sample_size
                else:
                    session.add(
                        JoinHint(
                            dataset_id=ds.id,
                            geometry_id=geo.id,
                            dataset_column=ds_col,
                            geometry_key=geo_key,
                            overlap=overlap_ratio,
                            sample_size=sample_size,
                        )
                    )
                hints_count += 1

    session.commit()
    logger.info(
        "Profiled dataset %s against %d geometries: %d hints",
        ds.name,
        len(geometries),
        hints_count,
    )
    return hints_count


def profile_geometry_against_datasets(
    geometry_id: int,
    session: "Session",
    storage: "StorageHandler",
) -> int:
    """Profile a geometry against all datasets and create JoinHint rows.

    Returns the number of hints created or updated.
    """
    geo = session.query(GeometryFile).filter(GeometryFile.id == geometry_id).first()
    if not geo or not geo.content_hash:
        return 0

    try:
        geo_values = _read_geometry_values(geo, storage)
    except Exception:
        logger.warning("Failed to read geometry %s for profiling", geo.name, exc_info=True)
        return 0

    if not geo_values:
        return 0

    datasets = session.query(Dataset).all()
    hints_count = 0

    for ds in datasets:
        if not ds.content_hash:
            continue
        try:
            ds_values = _read_dataset_values(ds, storage)
        except Exception:
            logger.debug("Skipping dataset %s during profiling", ds.name, exc_info=True)
            continue

        for ds_col, ds_vals in ds_values.items():
            if not ds_vals:
                continue
            for geo_key, geo_vals in geo_values.items():
                if not geo_vals:
                    continue

                names_match = _names_compatible(ds_col, geo_key)
                overlap_set = ds_vals & geo_vals
                overlap_ratio = len(overlap_set) / len(geo_vals) if geo_vals else 0.0

                if not names_match and overlap_ratio < _MIN_OVERLAP:
                    continue
                if overlap_ratio < 0.01:
                    continue

                sample_size = len(geo_vals)

                existing = (
                    session.query(JoinHint)
                    .filter(
                        JoinHint.dataset_id == ds.id,
                        JoinHint.geometry_id == geo.id,
                        JoinHint.dataset_column == ds_col,
                        JoinHint.geometry_key == geo_key,
                    )
                    .first()
                )
                if existing:
                    existing.overlap = overlap_ratio
                    existing.sample_size = sample_size
                else:
                    session.add(
                        JoinHint(
                            dataset_id=ds.id,
                            geometry_id=geo.id,
                            dataset_column=ds_col,
                            geometry_key=geo_key,
                            overlap=overlap_ratio,
                            sample_size=sample_size,
                        )
                    )
                hints_count += 1

    session.commit()
    logger.info(
        "Profiled geometry %s against %d datasets: %d hints",
        geo.name,
        len(datasets),
        hints_count,
    )
    return hints_count
