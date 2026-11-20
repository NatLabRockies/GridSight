"""Geometry file routes (upload, list, schema, preview, update)."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
from typing import Optional

import polars as pl
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import db
from lib import geometry_spatial
from lib.auth import require_api_key
from lib.extensions.storage_adapter import ExtensionStorageAdapter
from lib.profiler import profile_geometry_against_datasets
from lib.responses import make_response
from lib.serializers import serialize_geometry, file_suffix
from lib.state import storage
from models.orm import GeometryFile

logger = logging.getLogger("meridian")
router = APIRouter()


# --- CSV → GeoJSON helpers ---

_LAT_NAMES = {"lat", "latitude", "y", "lat_y", "point_y", "geo_lat", "facility_lat"}
_LON_NAMES = {"lon", "lng", "long", "longitude", "x", "lat_x", "point_x", "geo_lon", "geo_lng", "facility_lon", "facility_lng"}


def _detect_latlon_columns(columns: list[str]) -> tuple[str | None, str | None]:
    lat_col = lon_col = None
    for col in columns:
        normalized = col.lower().strip().replace(" ", "_")
        if normalized in _LAT_NAMES and lat_col is None:
            lat_col = col
        elif normalized in _LON_NAMES and lon_col is None:
            lon_col = col
    return lat_col, lon_col


def _csv_to_geojson(data: bytes, filename: str | None, lat_col: str | None, lon_col: str | None) -> tuple[bytes, str | None]:
    suffix = file_suffix(filename)
    df = (
        pl.read_parquet(io.BytesIO(data))
        if suffix == "parquet"
        else pl.read_csv(io.BytesIO(data))
    )

    if not lat_col or not lon_col:
        detected_lat, detected_lon = _detect_latlon_columns(df.columns)
        lat_col = lat_col or detected_lat
        lon_col = lon_col or detected_lon

    if not lat_col or not lon_col:
        raise ValueError(
            f"Could not detect latitude/longitude columns. "
            f"Available columns: {df.columns}. "
            f"Pass lat_col and lon_col explicitly."
        )

    if lat_col not in df.columns:
        raise ValueError(f"Latitude column '{lat_col}' not found. Available: {df.columns}")
    if lon_col not in df.columns:
        raise ValueError(f"Longitude column '{lon_col}' not found. Available: {df.columns}")

    property_cols = [c for c in df.columns if c not in (lat_col, lon_col)]
    features = []
    for row in df.iter_rows(named=True):
        lat = row[lat_col]
        lon = row[lon_col]
        if lat is None or lon is None:
            continue
        try:
            lat_f, lon_f = float(lat), float(lon)
        except (ValueError, TypeError):
            continue
        props = {c: row[c] for c in property_cols}
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon_f, lat_f]},
            "properties": props,
        })

    geojson = {"type": "FeatureCollection", "features": features}
    geojson_bytes = json.dumps(geojson).encode("utf-8")

    join_key = None
    join_candidates = ["id", "ID", "Id", "GEOID", "geoid", "FIPS", "fips",
                       "GeoId", "geo_id", "name", "NAME", "facility_id"]
    for c in join_candidates:
        if c in property_cols:
            join_key = c
            break

    return geojson_bytes, join_key


async def _stream_and_hash(file: UploadFile, chunk_size: int = 1024 * 1024) -> tuple[str, bytes]:
    hasher = hashlib.sha256()
    chunks = []
    while chunk := await file.read(chunk_size):
        hasher.update(chunk)
        chunks.append(chunk)
    return hasher.hexdigest(), b"".join(chunks)


def _run_geometry_profiler(geometry_id: int):
    session = db.get_session()
    try:
        profile_geometry_against_datasets(geometry_id, session, storage)
        db.save_to_disk()
    except Exception:
        logger.warning("Geometry profiler failed for id=%d", geometry_id, exc_info=True)
    finally:
        session.close()


# --- Routes ---


@router.post("/api/geometry/preview-csv")
async def previewGeometryCsv(
    _=Depends(require_api_key),
    file: UploadFile = File(...),
):
    data = await file.read()
    suffix = file_suffix(file.filename)
    try:
        df = (
            pl.read_parquet(io.BytesIO(data), n_rows=5)
            if suffix == "parquet"
            else pl.read_csv(io.BytesIO(data), n_rows=5)
        )
    except Exception as e:
        return make_response(f"Failed to read file: {e}", status=400)

    columns = df.columns
    lat_col, lon_col = _detect_latlon_columns(columns)

    return make_response({
        "columns": columns,
        "detected_lat_col": lat_col,
        "detected_lon_col": lon_col,
    })


@router.post("/api/geometry")
async def uploadGeometryFile(
    request: Request,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    format: str = Form("geojson"),
    join_key: Optional[str] = Form(None),
    scope: str = Form("scenario"),
    lat_col: Optional[str] = Form(None),
    lon_col: Optional[str] = Form(None),
    display_name: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    category_col: Optional[str] = Form(None),
    source_srs: Optional[str] = Form(None),
):
    sha256_hex, data = await _stream_and_hash(file)
    file_name = name or file.filename

    # A shapefile is a multi-file bundle (.shp/.shx/.dbf/.prj); a lone .shp/.dbf/…
    # can't be read. Fail fast with guidance instead of trying to JSON-parse binary
    # and hanging the client.
    _ext = (file.filename or "").lower().rsplit(".", 1)[-1]
    if _ext in {"shp", "shx", "dbf", "prj", "cpg", "sbn", "sbx"}:
        return make_response(
            "Upload a shapefile as a single .zip containing the .shp/.shx/.dbf/.prj "
            "together (a lone .%s can't be read)." % _ext,
            status=400,
        )

    # Large line/polygon files (zipped shapefile, FlatGeobuf, GeoPackage) are
    # ingested into a DuckDB spatial table and served per-viewport rather than
    # parsed as one whole-GeoJSON blob. See lib/geometry_spatial.py.
    spatial = geometry_spatial.is_spatial_format(format, file.filename)

    if format == "csv":
        try:
            data, detected_join_key = _csv_to_geojson(data, file.filename, lat_col, lon_col)
            if not join_key:
                join_key = detected_join_key
            format = "geojson"
            sha256_hex = hashlib.sha256(data).hexdigest()
        except ValueError as e:
            return make_response(str(e), status=400)
        except Exception as e:
            return make_response(f"CSV conversion failed: {e}", status=500)

    # Spatial files aren't JSON — skip the GeoJSON join-key sniff for them.
    if not join_key and not spatial:
        try:
            geojson = json.loads(data)
            features = geojson.get("features", [])
            if features:
                props = list(features[0].get("properties", {}).keys())
                for candidate in ["id", "ID", "Id", "GEOID", "geoid", "FIPS", "fips",
                                   "GeoId", "geo_id", "name", "NAME"]:
                    if candidate in props:
                        join_key = candidate
                        break
        except Exception:
            pass

    try:
        content_hash = storage.upload_file("geometry", sha256_hex, data)
    except Exception as e:
        return make_response(f"storage error: {e}", status=500)

    try:
        geo = GeometryFile(
            name=file_name,
            content_hash=content_hash,
            original_filename=file.filename,
            format=format,
            join_key=join_key,
            scope=scope if scope in ("global", "extension", "scenario") else "scenario",
            display_name=display_name,
            description=description,
            category_col=category_col,
        )
        session.add(geo)
        session.commit()
        session.refresh(geo)
        geo_id = geo.id
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)

    if spatial:
        # Ingest into DuckDB spatial (reproject → 4326, R-tree). Run INLINE, not
        # in a worker thread: the DuckDB engine shares the global _STATEMENT_LOCK
        # with the SQLAlchemy session, which this (event-loop) thread already
        # holds for the whole request. An RLock re-enters on the same thread, so
        # inline ingest is fine — but a worker thread would block on that lock
        # forever (the handler awaiting it → deadlock). Ingest is ~1s for a
        # national dataset, acceptable to run on the loop.
        engine = request.app.state.duckdb_engine
        try:
            meta = geometry_spatial.ingest(
                engine, geo_id, data, file.filename, source_srs=source_srs,
            )
            geo.is_spatial = True
            geo.spatial_table = meta["table"]
            geo.feature_count = meta["feature_count"]
            geo.bbox_json = json.dumps(meta["bbox"]) if meta.get("bbox") else None
            geo.format = format if format not in ("geojson", "csv") else "spatial"
            session.commit()
            session.refresh(geo)
            db.save_to_disk()
            return make_response(serialize_geometry(geo), status=201)
        except Exception as e:
            logger.error("[geo-upload] spatial ingest failed for %d: %s", geo_id, e, exc_info=True)
            return make_response(f"spatial ingest failed: {e}", status=500)

    db.save_to_disk()
    response = make_response(serialize_geometry(geo), status=201)
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _run_geometry_profiler, geo_id)
    return response


@router.get("/api/geometry")
async def listGeometryFiles(session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    rows = session.query(GeometryFile).all()
    return make_response([serialize_geometry(r) for r in rows])


@router.get("/api/geometry/{geo_id}/data")
async def getGeometryFileData(geo_id: int, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        geo = session.query(GeometryFile).filter(GeometryFile.id == geo_id).first()
        if not geo:
            logger.warning("[geo-data] geometry %d not found", geo_id)
            return make_response("not found", status=404)
        if geo.extension_name and geo.extension_ref:
            logger.debug("[geo-data] fetching extension geometry: ext=%s ref=%s", geo.extension_name, geo.extension_ref)
            adapter: ExtensionStorageAdapter = request.app.state.extension_storage
            data = adapter.get_geometry_bytes(geo.extension_name, geo.extension_ref)
            logger.debug("[geo-data] got %d bytes from extension", len(data) if data else 0)
        else:
            data = storage.read_file_bytes(geo.content_hash)
        return Response(content=data, media_type="application/json")
    except Exception as e:
        logger.error("[geo-data] error fetching geometry %d: %s", geo_id, e, exc_info=True)
        return make_response(str(e), status=500)


@router.get("/api/geometry/{geo_id}/viewport")
async def getGeometryViewport(
    geo_id: int,
    request: Request,
    bbox: str,
    zoom: float,
    filters: Optional[str] = None,
    columns: Optional[str] = None,
    cap: int = 20000,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
):
    """Return a GeoJSON FeatureCollection of features intersecting ``bbox`` at
    ``zoom`` for a spatial geometry — only what's in view, simplified for the
    zoom, with optional per-category zoom gating.

    Query params:
      - bbox:    "w,s,e,n" in EPSG:4326
      - zoom:    current map zoom (float)
      - filters: JSON, e.g. {"category_min_zoom": {"69kV": 8, "500kV": 0}}
      - cap:     max features returned (payload guard)
    """
    try:
        geo = session.query(GeometryFile).filter(GeometryFile.id == geo_id).first()
        if not geo:
            return make_response("not found", status=404)
        if not getattr(geo, "is_spatial", False):
            return make_response("geometry is not spatial (use /data)", status=400)

        try:
            parts = [float(x) for x in bbox.split(",")]
            if len(parts) != 4:
                raise ValueError
        except ValueError:
            return make_response("bbox must be 'w,s,e,n'", status=400)

        category_min_zoom = None
        if filters:
            try:
                category_min_zoom = (json.loads(filters) or {}).get("category_min_zoom")
            except Exception:
                return make_response("filters must be valid JSON", status=400)

        engine = request.app.state.duckdb_engine
        if not geometry_spatial.table_exists(engine, geo_id):
            # In-memory DuckDB lost the table (e.g. a restart raced this request);
            # rebuild it lazily from the stored bytes before serving.
            try:
                raw = storage.read_file_bytes(geo.content_hash)
                geometry_spatial.ingest(engine, geo_id, raw, geo.original_filename or "upload")
            except Exception as e:
                return make_response(f"spatial table unavailable: {e}", status=503)

        available = geometry_spatial.spatial_columns(engine, geo_id)
        # Property pruning is essential at scale: a 34-column shapefile ships
        # ~20MB per viewport if every attribute rides along. Clients request the
        # columns they actually style/join on; default to the category + join
        # keys so payloads stay lean without the client having to ask.
        if columns:
            requested = [c.strip() for c in columns.split(",") if c.strip()]
            select_cols = [c for c in requested if c in available]
        else:
            defaults = [c for c in (geo.category_col, geo.join_key) if c]
            select_cols = [c for c in dict.fromkeys(defaults) if c in available]
        if not select_cols:
            select_cols = available[:6]
        result = geometry_spatial.query_viewport(
            engine, geo_id, parts, zoom, select_cols,
            category_col=geo.category_col,
            category_min_zoom=category_min_zoom,
            cap=cap,
        )
        return Response(content=json.dumps(result), media_type="application/json")
    except Exception as e:
        logger.error("[geo-viewport] error for %d: %s", geo_id, e, exc_info=True)
        return make_response(str(e), status=500)


@router.get("/api/geometry/{geo_id}/schema")
async def getGeometrySchema(geo_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        geo = session.query(GeometryFile).filter(GeometryFile.id == geo_id).first()
        if not geo:
            return make_response("not found", status=404)

        data = storage.read_file_bytes(geo.content_hash)
        geojson = json.loads(data)
        features = geojson.get("features", [])
        properties = list(features[0].get("properties", {}).keys()) if features else []

        join_candidates = ["id", "ID", "Id", "GEOID", "geoid", "FIPS", "fips",
                           "GeoId", "geo_id", "name", "NAME"]
        suggested_join = geo.join_key
        if not suggested_join:
            for c in join_candidates:
                if c in properties:
                    suggested_join = c
                    break

        MAX_UNIQUE = 2000
        unique_values = {}
        for prop in properties:
            vals = set()
            for f in features:
                v = f.get("properties", {}).get(prop)
                if v is not None:
                    vals.add(str(v))
                if len(vals) >= MAX_UNIQUE:
                    break
            unique_values[prop] = sorted(vals)

        return make_response({
            "properties": properties,
            "suggested_join_key": suggested_join,
            "unique_values": unique_values,
        })
    except Exception as e:
        return make_response(str(e), status=500)


@router.get("/api/geometry/{geo_id}/preview")
async def previewGeometry(
    geo_id: int,
    request: Request,
    offset: int = 0,
    limit: int = 20,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
):
    try:
        geo = session.query(GeometryFile).filter(GeometryFile.id == geo_id).first()
        if not geo:
            return make_response("not found", status=404)

        if geo.extension_name and geo.extension_ref:
            adapter: ExtensionStorageAdapter = request.app.state.extension_storage
            raw = adapter.get_geometry_bytes(geo.extension_name, geo.extension_ref)
        else:
            raw = storage.read_file_bytes(geo.content_hash)
        geojson = json.loads(raw)
        features = geojson.get("features", [])
        total = len(features)
        page = features[offset : offset + limit]
        rows = [f.get("properties", {}) for f in page]
        columns = list(rows[0].keys()) if rows else []

        return make_response({
            "columns": columns,
            "rows": rows,
            "total": total,
            "offset": offset,
            "limit": limit,
            "join_key": geo.join_key,
            "name": geo.name,
        })
    except Exception as e:
        return make_response(str(e), status=500)


class UpdateGeometryBody(BaseModel):
    join_key: Optional[str] = None
    name: Optional[str] = None
    display_name: Optional[str] = None
    description: Optional[str] = None


@router.patch("/api/geometry/{geo_id}")
async def updateGeometry(geo_id: int, body: UpdateGeometryBody, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        geo = session.query(GeometryFile).filter(GeometryFile.id == geo_id).first()
        if not geo:
            return make_response("not found", status=404)
        if body.join_key is not None:
            geo.join_key = body.join_key
        if body.name is not None:
            geo.name = body.name
        if body.display_name is not None:
            geo.display_name = body.display_name
        if body.description is not None:
            geo.description = body.description
        session.commit()
        db.save_to_disk()
        return make_response(serialize_geometry(geo))
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)
