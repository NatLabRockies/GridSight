"""Spatial geometry ingest + viewport serving via DuckDB spatial.

This is the single **seam** for all spatial geometry access. Large line/polygon
datasets (e.g. a CONUS transmission-line shapefile) are ingested into a DuckDB
spatial table (reprojected to EPSG:4326, R-tree indexed) and served back one
viewport at a time — only the features intersecting the current map bounds, at a
zoom-appropriate simplification, with optional per-category zoom gating.

Why a seam: today everything runs on the shared, in-memory ``DuckDBEngine``
(one connection behind the global lock). If spatial queries ever contend with
analytical/chart queries — the multi-display wall makes that plausible — the
escalation is a *dedicated* DuckDB instance for geometry. That swap happens
here, behind ``ingest()`` / ``query_viewport()``, without touching callers.

The engine passed in only needs ``.conn`` (a duckdb connection) and ``.lock``
(a re-entrant lock), matching ``lib.extensions.duckdb_engine.DuckDBEngine``.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
import threading
import zipfile
from collections import OrderedDict
from pathlib import Path
from typing import Any

logger = logging.getLogger("meridian")

# Extensions ST_Read (GDAL) can open directly. Shapefiles arrive zipped because
# they are multi-file (.shp/.shx/.dbf/.prj); we unzip and read the inner .shp.
_SINGLE_FILE_EXTS = {".fgb", ".gpkg", ".geojson", ".json"}
_ZIP_EXTS = {".zip"}

# Simplify tolerance (degrees) is halved each zoom level: ~0.06° at z3 (CONUS)
# down to sub-metre by z14, above which we send full detail. Keeps low-zoom
# payloads small without visible loss.
_MAX_SIMPLIFY_ZOOM = 14
# Snap viewport bounds to this grid (degrees) and pad, so small pans reuse a
# cached superset instead of re-querying every frame.
_CACHE_GRID_DEG = 0.25
_CACHE_MAX_ENTRIES = 128


def table_name(geo_id: int) -> str:
    return f"geom_{int(geo_id)}"


def tol_for_zoom(zoom: float) -> float:
    if zoom >= _MAX_SIMPLIFY_ZOOM:
        return 0.0
    return 0.5 / (2.0 ** max(0.0, float(zoom)))


# ── ingest ──────────────────────────────────────────────────────────────────

def is_spatial_format(fmt: str | None, filename: str | None) -> bool:
    """Whether an upload should go through spatial ingest rather than being
    served as a whole GeoJSON blob."""
    if (fmt or "").lower() in {"shapefile", "flatgeobuf", "fgb", "geopackage", "gpkg"}:
        return True
    ext = Path(filename or "").suffix.lower()
    return ext in (_ZIP_EXTS | {".fgb", ".gpkg"})


def _ensure_spatial(engine) -> None:
    with engine.lock:
        engine.conn.execute("INSTALL spatial; LOAD spatial;")


def _materialize_read_target(raw: bytes, filename: str, tmpdir: str) -> str:
    """Write the uploaded bytes into ``tmpdir`` and return a path ST_Read can
    open. Zipped shapefiles are extracted and the inner ``.shp`` is returned."""
    ext = Path(filename or "").suffix.lower()
    if ext in _ZIP_EXTS:
        zpath = os.path.join(tmpdir, "upload.zip")
        Path(zpath).write_bytes(raw)
        with zipfile.ZipFile(zpath) as zf:
            zf.extractall(tmpdir)
        shp = next((str(p) for p in Path(tmpdir).rglob("*.shp")), None)
        if not shp:
            raise ValueError("zip contains no .shp file")
        return shp
    # Single-file formats (.fgb/.gpkg/.geojson): write verbatim.
    out = os.path.join(tmpdir, f"upload{ext or '.geojson'}")
    Path(out).write_bytes(raw)
    return out


def _detect_crs(engine, read_target: str) -> str | None:
    """Return 'AUTH:CODE' (e.g. 'EPSG:4269') from the file's CRS metadata, or
    None if unavailable (treated as already-4326)."""
    try:
        with engine.lock:
            row = engine.conn.execute(
                "SELECT layers[1].geometry_fields[1].crs.auth_name || ':' || "
                "layers[1].geometry_fields[1].crs.auth_code FROM ST_Read_Meta(?)",
                [read_target],
            ).fetchone()
        return row[0] if row and row[0] and "None" not in row[0] else None
    except Exception:
        logger.warning("ST_Read_Meta CRS detection failed for %s", read_target, exc_info=True)
        return None


def ingest(engine, geo_id: int, raw: bytes, filename: str,
           *, source_srs: str | None = None) -> dict[str, Any]:
    """Load a spatial file into ``geom_<id>`` (reprojected to 4326, R-tree
    indexed) and return metadata for the GeometryFile row.

    Returns: {table, feature_count, bbox:[w,s,e,n], columns:[...], geom_type}.
    """
    _ensure_spatial(engine)
    table = table_name(geo_id)
    with tempfile.TemporaryDirectory() as tmpdir:
        read_target = _materialize_read_target(raw, filename, tmpdir)
        crs = source_srs or _detect_crs(engine, read_target)
        with engine.lock:
            con = engine.conn
            con.execute(f'DROP TABLE IF EXISTS "{table}"')
            # ST_Transform is skipped when the source is already 4326 (or unknown)
            # to avoid a needless PROJ round-trip / identity errors.
            if crs and crs.upper() not in ("EPSG:4326", "OGC:CRS84"):
                geom_expr = "ST_Transform(geom, ?, 'EPSG:4326', always_xy := true)::GEOMETRY"
                params = [crs, read_target]
            else:
                geom_expr = "geom::GEOMETRY"
                params = [read_target]
            con.execute(
                f'CREATE TABLE "{table}" AS '
                f'SELECT * EXCLUDE (geom), {geom_expr} AS geom FROM ST_Read(?)',
                params,
            )
            try:
                con.execute(f'CREATE INDEX "idx_{table}" ON "{table}" USING RTREE (geom)')
            except Exception:
                # Non-fatal: bbox queries still work via a vectorized scan, just
                # without the index. Log so large datasets can be investigated.
                logger.warning("RTREE index creation failed for %s", table, exc_info=True)
            cols = [r[0] for r in con.execute(f'DESCRIBE "{table}"').fetchall() if r[0] != "geom"]
            count = con.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            # Per-geom min/max avoids a full ST_Union_Agg over every feature.
            bbox = con.execute(
                f'SELECT min(ST_XMin(geom)), min(ST_YMin(geom)), '
                f'max(ST_XMax(geom)), max(ST_YMax(geom)) FROM "{table}"'
            ).fetchone()
            geom_type = con.execute(
                f'SELECT ST_GeometryType(geom) FROM "{table}" LIMIT 1'
            ).fetchone()
    return {
        "table": table,
        "feature_count": int(count),
        "bbox": [float(b) for b in bbox] if bbox and bbox[0] is not None else None,
        "columns": cols,
        "geom_type": geom_type[0] if geom_type else None,
    }


def drop(engine, geo_id: int) -> None:
    table = table_name(geo_id)
    try:
        with engine.lock:
            engine.conn.execute(f'DROP TABLE IF EXISTS "{table}"')
    except Exception:
        logger.warning("Failed dropping spatial table %s", table, exc_info=True)


def spatial_columns(engine, geo_id: int) -> list[str]:
    """Non-geom column names of the ingested table (for building feature props)."""
    try:
        with engine.lock:
            rows = engine.conn.execute(f'DESCRIBE "{table_name(geo_id)}"').fetchall()
        return [r[0] for r in rows if r[0] != "geom"]
    except Exception:
        return []


def table_exists(engine, geo_id: int) -> bool:
    try:
        with engine.lock:
            row = engine.conn.execute(
                "SELECT 1 FROM information_schema.tables WHERE table_name = ?",
                [table_name(geo_id)],
            ).fetchone()
        return row is not None
    except Exception:
        return False


# ── viewport query (+ cache) ─────────────────────────────────────────────────

class _ViewportCache:
    """Tiny LRU keyed on (geo_id, snapped bbox, int zoom, filter hash). Holds
    assembled FeatureCollection JSON. Not about concurrency scaling — it kills
    redundant refetches during pan jitter and de-dupes the wall's N displays
    looking at the same view."""

    def __init__(self, maxsize: int = _CACHE_MAX_ENTRIES) -> None:
        self._d: OrderedDict[tuple, dict] = OrderedDict()
        self._lock = threading.Lock()
        self.maxsize = maxsize

    def get(self, key):
        with self._lock:
            if key in self._d:
                self._d.move_to_end(key)
                return self._d[key]
        return None

    def put(self, key, value):
        with self._lock:
            self._d[key] = value
            self._d.move_to_end(key)
            while len(self._d) > self.maxsize:
                self._d.popitem(last=False)

    def invalidate_geo(self, geo_id: int):
        with self._lock:
            for k in [k for k in self._d if k[0] == geo_id]:
                del self._d[k]


_cache = _ViewportCache()


def _snap_bbox(bbox, grid: float = _CACHE_GRID_DEG):
    """Expand bounds outward to grid boundaries so nearby pans hit the same
    cache entry and get a superset that still covers the viewport."""
    import math
    w, s, e, n = bbox
    return (
        math.floor(w / grid) * grid,
        math.floor(s / grid) * grid,
        math.ceil(e / grid) * grid,
        math.ceil(n / grid) * grid,
    )


def query_viewport(engine, geo_id: int, bbox, zoom: float, columns: list[str],
                   *, category_col: str | None = None,
                   category_min_zoom: dict[str, float] | None = None,
                   cap: int = 20000) -> dict[str, Any]:
    """Return a GeoJSON FeatureCollection of features intersecting ``bbox`` at
    the given ``zoom``, simplified for that zoom, with per-category zoom gating.

    Result: {"type":"FeatureCollection","features":[...],
             "truncated":bool,"count":int,"cap":int}.
    """
    zoom_bucket = round(float(zoom))
    snapped = _snap_bbox(bbox)
    hidden = sorted(
        cat for cat, mz in (category_min_zoom or {}).items() if zoom < mz
    ) if (category_col and category_min_zoom) else []
    filt_hash = hashlib.sha1(
        json.dumps([category_col, hidden], sort_keys=True).encode()
    ).hexdigest()[:12]
    key = (geo_id, snapped, zoom_bucket, filt_hash)
    cached = _cache.get(key)
    if cached is not None:
        return cached

    table = table_name(geo_id)
    tol = tol_for_zoom(zoom)
    w, s, e, n = snapped

    where = ["ST_Intersects(geom, ST_MakeEnvelope(?,?,?,?))"]
    params: list[Any] = [w, s, e, n]
    if hidden:
        placeholders = ",".join(["?"] * len(hidden))
        where.append(f'"{category_col}" NOT IN ({placeholders})')
        params.extend(hidden)
    where_sql = " AND ".join(where)

    # Assemble the FeatureCollection server-side. Properties come from every
    # non-geom column; identifiers are quoted so odd shapefile field names work.
    prop_pairs = ", ".join(f"'{c}', \"{c}\"" for c in columns) if columns else ""
    geom_sql = "geom" if tol <= 0 else "ST_Simplify(geom, ?)"

    with engine.lock:
        con = engine.conn
        count = con.execute(
            f'SELECT count(*) FROM "{table}" WHERE {where_sql}', params
        ).fetchone()[0]
        select_params = ([tol] if tol > 0 else []) + params + [cap]
        arr = con.execute(
            f"SELECT coalesce(json_group_array(json_object("
            f"  'type','Feature',"
            f"  'properties', json_object({prop_pairs}),"
            f"  'geometry', ST_AsGeoJSON({geom_sql})::JSON)), '[]')"
            f'FROM (SELECT * FROM "{table}" WHERE {where_sql} LIMIT ?)',
            select_params,
        ).fetchone()[0]

    features = json.loads(arr)
    result = {
        "type": "FeatureCollection",
        "features": features,
        "count": int(count),
        "truncated": int(count) > cap,
        "cap": cap,
    }
    _cache.put(key, result)
    return result


def invalidate_cache(geo_id: int) -> None:
    _cache.invalidate_geo(geo_id)
