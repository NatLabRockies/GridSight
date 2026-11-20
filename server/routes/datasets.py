"""Dataset routes: upload, list, preview, columns, partitions, streaming,
join hints, descriptions, and entity timeseries lookups."""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
from typing import Optional

import polars as pl
import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

import db
from lib.auth import require_api_key
from lib.profiler import profile_dataset_against_geometries
from lib.responses import make_response
from lib.serializers import serialize_dataset, serialize_geometry, file_suffix
from lib.state import storage
from models.orm import (
    ColumnDescription,
    Dataset,
    GeometryFile,
    JoinHint,
    LayerDataset,
    LayerStyleMapping,
    TableDescription,
)

logger = logging.getLogger("gridsight")
router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_geometry_schema(geo, session=None):
    data = storage.read_file_bytes(geo.content_hash)
    geojson = json.loads(data)
    features = geojson.get("features", [])
    properties = list(features[0].get("properties", {}).keys()) if features else []
    join_candidates = ["id", "ID", "GEOID", "geoid", "FIPS", "fips", "GeoId", "geo_id", "name", "NAME"]
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
    return {"properties": properties, "suggested_join_key": suggested_join, "unique_values": unique_values}


def _get_dataset_schema(ds):
    raw = storage.read_file_bytes(ds.content_hash)
    suffix = file_suffix(ds.original_filename)
    df = (pl.read_parquet(io.BytesIO(raw), n_rows=5)
          if suffix == "parquet"
          else pl.read_csv(io.BytesIO(raw), n_rows=5))
    columns = df.columns
    dtypes = {col: str(df[col].dtype) for col in columns}
    return {"columns": columns, "dtypes": dtypes, "suggested_join_key": ds.join_key, "suggested_timestamp_col": ds.timestamp_col}


def _get_partition_meta(ds: Dataset) -> tuple[list[str], dict[str, int], dict[str, int]]:
    dates = storage.list_partitions(ds.content_hash)
    row_counts: dict[str, int] = {}
    date_offsets: dict[str, int] = {}
    offset = 0
    for d in dates:
        pf = pq.ParquetFile(io.BytesIO(storage.read_partition(ds.content_hash, d)))
        row_counts[d] = pf.metadata.num_rows
        date_offsets[d] = offset
        offset += pf.metadata.num_rows
    return dates, row_counts, date_offsets


def _global_index_to_date_row(
    global_idx: int, dates: list[str], date_offsets: dict[str, int], row_counts: dict[str, int]
) -> tuple[str, int]:
    total = sum(row_counts.values())
    clamped = max(0, min(total - 1, global_idx))
    lo, hi = 0, len(dates) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if date_offsets[dates[mid]] <= clamped:
            lo = mid
        else:
            hi = mid - 1
    date = dates[lo]
    return date, clamped - date_offsets[date]


def _compute_dataset_stats(
    raw_data: bytes, original_filename: str, timestamp_col: str | None
) -> tuple[float | None, float | None]:
    try:
        suffix = file_suffix(original_filename)
        df = (
            pl.read_parquet(io.BytesIO(raw_data))
            if suffix == "parquet"
            else pl.read_csv(io.BytesIO(raw_data))
        )
        numeric_cols = [
            c for c in df.columns
            if c != timestamp_col and df[c].dtype.is_numeric()
        ]
        if not numeric_cols:
            return None, None
        global_min = min(df[c].min() for c in numeric_cols)
        global_max = max(df[c].max() for c in numeric_cols)
        return float(global_min), float(global_max)
    except Exception as e:
        logger.warning("[_compute_dataset_stats] failed: %s", e)
        return None, None


def _write_dataset_partitions(
    raw_data: bytes, original_filename: str, timestamp_col: str, content_hash: str
) -> None:
    suffix = file_suffix(original_filename)
    df = (
        pl.read_parquet(io.BytesIO(raw_data))
        if suffix == "parquet"
        else pl.read_csv(io.BytesIO(raw_data))
    )

    try:
        ts_dtype = str(df[timestamp_col].dtype)
        if "Datetime" not in ts_dtype and "Date" not in ts_dtype:
            df = df.with_columns(pl.col(timestamp_col).str.to_datetime(strict=False))
    except Exception as exc:
        logger.warning("[_write_dataset_partitions] could not parse timestamp: %s", exc)
        return

    df = df.with_columns(
        pl.col(timestamp_col).dt.date().cast(pl.Utf8).alias("_partition_date")
    )

    dates = df["_partition_date"].unique().sort().to_list()
    for date_str in dates:
        partition = df.filter(pl.col("_partition_date") == date_str).drop("_partition_date")
        buf = io.BytesIO()
        partition.write_parquet(buf)
        storage.write_partition(content_hash, date_str, buf.getvalue())

    logger.debug("[_write_dataset_partitions] wrote %d partitions for %s…", len(dates), content_hash[:20])


def _run_dataset_profiler(dataset_id: int):
    session = db.get_session()
    try:
        profile_dataset_against_geometries(dataset_id, session, storage)
        db.save_to_disk()
    except Exception:
        logger.warning("Dataset profiler failed for id=%d", dataset_id, exc_info=True)
    finally:
        session.close()


async def _stream_and_hash(file: UploadFile, chunk_size: int = 1024 * 1024) -> tuple[str, bytes]:
    hasher = hashlib.sha256()
    chunks = []
    while chunk := await file.read(chunk_size):
        hasher.update(chunk)
        chunks.append(chunk)
    return hasher.hexdigest(), b"".join(chunks)


def _empty_series_response() -> Response:
    schema = pa.schema([("timestamp", pa.string()), ("value", pa.float64())])
    buf = io.BytesIO()
    w = pa.ipc.new_stream(buf, schema)
    w.close()
    return Response(
        content=buf.getvalue(),
        status_code=200,
        media_type="application/vnd.apache.arrow.stream",
        headers={"Cache-Control": "private, max-age=300"},
    )


# ---------------------------------------------------------------------------
# Pydantic bodies
# ---------------------------------------------------------------------------


class DatasetRowRequest(BaseModel):
    dataset_id: int
    row_id: int


class UpdateDatasetBody(BaseModel):
    name: Optional[str] = None
    display_name: Optional[str] = None
    description: Optional[str] = None
    join_key: Optional[str] = None
    timestamp_col: Optional[str] = None


class GenerateDescriptionBody(BaseModel):
    target_type: str
    target_id: int
    column_name: Optional[str] = None
    source: str = "data"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/api/datasets/{dataset_id}/preview")
async def previewDataset(
    dataset_id: int,
    request: Request,
    offset: int = 0,
    limit: int = 20,
    partition: str | None = None,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
):
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)

        if ds.extension_name and ds.extension_ref:
            adapter = request.app.state.extension_storage
            if partition:
                raw = adapter.get_dataset_partition_bytes(
                    ds.extension_name, ds.extension_ref, partition
                )
            else:
                raw = adapter.get_dataset_bytes(ds.extension_name, ds.extension_ref)
        else:
            if partition:
                raw = storage.read_partition(ds.content_hash, partition)
            else:
                raw = storage.read_file_bytes(ds.content_hash)

        suffix = file_suffix(ds.original_filename) if ds.original_filename else "parquet"
        if ds.extension_name:
            suffix = ds.format or "parquet"
        df = (
            pl.read_parquet(io.BytesIO(raw))
            if suffix == "parquet"
            else pl.read_csv(io.BytesIO(raw))
        )
        total = len(df)
        page = df.slice(offset, limit)
        rows = json.loads(page.write_json())
        columns = df.columns
        dtypes = {c: str(df[c].dtype) for c in columns}

        return make_response({
            "columns": columns,
            "dtypes": dtypes,
            "rows": rows,
            "total": total,
            "offset": offset,
            "limit": limit,
            "join_key": ds.join_key,
            "name": ds.name,
            "timestamp_col": ds.timestamp_col,
        })
    except Exception as e:
        return make_response(str(e), status=500)


@router.post("/api/datasets")
async def uploadDataset(
    request: Request,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    format: str = Form("csv"),
    join_key: Optional[str] = Form(None),
    timestamp_col: Optional[str] = Form(None),
    scope: str = Form("scenario"),
    display_name: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
):
    sha256_hex, data = await _stream_and_hash(file)
    file_name = name or file.filename

    if not timestamp_col:
        try:
            suffix = file_suffix(file.filename)
            df = (pl.read_parquet(io.BytesIO(data), n_rows=5)
                  if suffix == "parquet"
                  else pl.read_csv(io.BytesIO(data), n_rows=5))
            for col in df.columns:
                dtype_str = str(df[col].dtype)
                if "Datetime" in dtype_str or "Date" in dtype_str:
                    timestamp_col = col
                    break
            if not timestamp_col:
                ts_names = {"datetime", "timestamp", "date", "time", "dt"}
                for col in df.columns:
                    if col.lower() in ts_names or any(
                        n in col.lower() for n in ("datetime", "timestamp")
                    ):
                        timestamp_col = col
                        break
        except Exception:
            pass

    try:
        content_hash = storage.upload_file("dataset", sha256_hex, data)
    except Exception as e:
        return make_response(f"storage error: {e}", status=500)

    loop = asyncio.get_running_loop()

    if timestamp_col:
        try:
            await loop.run_in_executor(
                None, _write_dataset_partitions, data, file.filename, timestamp_col, content_hash
            )
        except Exception as e:
            logger.warning("[uploadDataset] partition write failed (non-fatal): %s", e)

    v_min, v_max = await loop.run_in_executor(
        None, _compute_dataset_stats, data, file.filename, timestamp_col
    )

    try:
        ds = Dataset(
            name=file_name,
            content_hash=content_hash,
            original_filename=file.filename,
            format=format,
            join_key=join_key,
            timestamp_col=timestamp_col,
            value_min=v_min,
            value_max=v_max,
            scope=scope if scope in ("global", "extension", "scenario") else "scenario",
            display_name=display_name,
            description=description,
        )
        if timestamp_col:
            try:
                dates = storage.list_partitions(content_hash)
                if dates:
                    row_counts = {}
                    for d in dates:
                        pf = pq.ParquetFile(io.BytesIO(storage.read_partition(content_hash, d)))
                        row_counts[d] = pf.metadata.num_rows
                    first_schema = pq.read_schema(io.BytesIO(storage.read_partition(content_hash, dates[0])))
                    entity_columns = [f for f in first_schema.names if f != timestamp_col]
                    ds.time_meta_json = json.dumps({
                        "dates": dates,
                        "row_counts": row_counts,
                        "entity_columns": entity_columns,
                        "total_rows": sum(row_counts.values()),
                    })
            except Exception as e:
                logger.warning("[uploadDataset] time metadata computation failed (non-fatal): %s", e)

        session.add(ds)
        session.commit()
        session.refresh(ds)
        db.save_to_disk()
        ds_id = ds.id

        # Register the dataset as a queryable DuckDB table under the `user`
        # schema so the agent can immediately explore/chart/join it via
        # describe_data() / query_data() / create_chart(). Non-fatal: an
        # upload that can't be parsed still succeeds as a map-layer dataset.
        duckdb_table = None
        try:
            engine = request.app.state.duckdb_engine
            suffix = file_suffix(file.filename)
            info = engine.register_user_dataset(
                table=file_name,
                data=data,
                fmt="csv" if suffix == "csv" else "parquet",
                description=description or "",
            )
            duckdb_table = info.table_name
        except Exception as e:
            logger.warning("[uploadDataset] DuckDB registration failed (non-fatal): %s", e)

        payload = serialize_dataset(ds)
        payload["duckdb_table"] = duckdb_table
        response = make_response(payload, status=201)
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)

    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, _run_dataset_profiler, ds_id)

    # Auto-describe in the background so the AI gains context on this dataset
    # without the user having to explain it. Flags low-confidence cases for a
    # one-time clarifying question (surfaced in the chat system prompt).
    if duckdb_table:
        from lib.ai.describe import generate_dataset_descriptions

        asyncio.create_task(generate_dataset_descriptions(ds_id, duckdb_table))

    return response


@router.get("/api/datasets")
async def listDatasets(session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    rows = session.query(Dataset).all()
    return make_response([serialize_dataset(r) for r in rows])


@router.get("/api/join-hints")
async def listJoinHints(
    geometry_id: Optional[int] = None,
    dataset_id: Optional[int] = None,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
):
    q = session.query(JoinHint).filter(JoinHint.status != "rejected")
    if geometry_id is not None:
        q = q.filter(JoinHint.geometry_id == geometry_id)
    if dataset_id is not None:
        q = q.filter(JoinHint.dataset_id == dataset_id)
    hints = q.order_by(JoinHint.overlap.desc()).all()
    return make_response([
        {
            "id": h.id,
            "dataset_id": h.dataset_id,
            "geometry_id": h.geometry_id,
            "dataset_column": h.dataset_column,
            "geometry_key": h.geometry_key,
            "overlap": round(h.overlap, 4),
            "sample_size": h.sample_size,
            "status": h.status,
            "dataset": serialize_dataset(
                session.query(Dataset).filter(Dataset.id == h.dataset_id).first()
            ),
            "geometry": serialize_geometry(
                session.query(GeometryFile).filter(GeometryFile.id == h.geometry_id).first()
            ),
        }
        for h in hints
    ])


@router.patch("/api/join-hints/{hint_id}")
async def updateJoinHint(hint_id: int, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        hint = session.query(JoinHint).filter(JoinHint.id == hint_id).first()
        if not hint:
            return make_response("not found", status=404)
        new_status = body.get("status")
        if new_status not in ("suggested", "confirmed", "rejected"):
            return make_response("status must be 'suggested', 'confirmed', or 'rejected'", status=400)
        hint.status = new_status
        session.commit()
        db.save_to_disk()
        return make_response({"id": hint.id, "status": hint.status})
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.get("/api/datasets/{dataset_id}/columns")
async def getDatasetColumns(dataset_id: int, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)

        raw = storage.read_file_bytes(ds.content_hash)
        suffix = file_suffix(ds.original_filename)
        df = (pl.read_parquet(io.BytesIO(raw), n_rows=5)
              if suffix == "parquet"
              else pl.read_csv(io.BytesIO(raw), n_rows=5))

        columns = df.columns
        dtypes = {col: str(df[col].dtype) for col in columns}

        join_candidates = ["id", "ID", "Id", "GEOID", "geoid", "FIPS", "fips",
                           "geo_id", "county_id", "zone_id", "region_id"]
        suggested_join = ds.join_key
        if not suggested_join:
            for c in join_candidates:
                if c in columns:
                    suggested_join = c
                    break

        suggested_ts = ds.timestamp_col
        if not suggested_ts:
            for col in columns:
                if "Datetime" in dtypes[col] or "Date" in dtypes[col]:
                    suggested_ts = col
                    break
        if not suggested_ts:
            ts_names = {"datetime", "timestamp", "date", "time", "dt"}
            for col in columns:
                if col.lower() in ts_names or any(
                    n in col.lower() for n in ("datetime", "timestamp")
                ):
                    suggested_ts = col
                    break

        return make_response({
            "columns": columns,
            "dtypes": dtypes,
            "suggested_join_key": suggested_join,
            "suggested_timestamp_col": suggested_ts,
        })
    except Exception as e:
        return make_response(str(e), status=500)


@router.get("/api/datasets/{dataset_id}/data")
async def getDatasetData(dataset_id: int, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)
        if ds.extension_name and ds.extension_ref:
            adapter = request.app.state.extension_storage
            raw = adapter.get_dataset_bytes(ds.extension_name, ds.extension_ref)
            fmt = ds.format or "parquet"
            df = (pl.read_parquet(io.BytesIO(raw))
                  if fmt == "parquet"
                  else pl.read_csv(io.BytesIO(raw)))
            return make_response(json.loads(df.write_json()))
        raw = storage.read_file_bytes(ds.content_hash)
        suffix = file_suffix(ds.original_filename)
        df = (pl.read_parquet(io.BytesIO(raw))
              if suffix == "parquet"
              else pl.read_csv(io.BytesIO(raw)))
        return make_response(json.loads(df.write_json()))
    except Exception as e:
        return make_response(str(e), status=500)


@router.get("/api/datasets/{dataset_id}/partitions")
async def getDatasetPartitions(dataset_id: int, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)
        if not ds.timestamp_col:
            return make_response("dataset has no timestamp_col (not a timeseries)", status=400)

        empty = {"dates": [], "entity_columns": [], "row_counts": {}, "timestamp_col": ds.timestamp_col}

        if ds.time_meta_json:
            try:
                cached = json.loads(ds.time_meta_json)
                cached["timestamp_col"] = ds.timestamp_col
                return make_response(cached)
            except Exception:
                pass

        if ds.extension_name and hasattr(request.app.state, 'extension_storage'):
            registry = request.app.state.extension_registry
            ext = registry.get(ds.extension_name) if registry else None
            if ext:
                meta = ext.get_dataset_metadata(ds.extension_ref)
                if meta:
                    from dataclasses import asdict
                    result = asdict(meta)
                    result["timestamp_col"] = ds.timestamp_col
                    ds.time_meta_json = json.dumps({
                        "dates": meta.dates,
                        "row_counts": meta.row_counts,
                        "entity_columns": meta.entity_columns,
                        "start": meta.start,
                        "end": meta.end,
                        "total_rows": meta.total_rows,
                        "resolution_seconds": meta.resolution_seconds,
                    })
                    session.commit()
                    return make_response(result)

            adapter = request.app.state.extension_storage
            dates = adapter.list_dataset_partitions(ds.extension_name, ds.extension_ref)
            if dates:
                first_bytes = adapter.get_dataset_partition_bytes(
                    ds.extension_name, ds.extension_ref, dates[0]
                )
                try:
                    first_table = pq.read_table(io.BytesIO(first_bytes))
                except Exception:
                    first_table = pa.ipc.open_file(io.BytesIO(first_bytes)).read_all()
                entity_columns = [f for f in first_table.schema.names if f != ds.timestamp_col]
                row_counts = {}
                for d in dates:
                    p_bytes = adapter.get_dataset_partition_bytes(
                        ds.extension_name, ds.extension_ref, d
                    )
                    try:
                        p_table = pq.read_table(io.BytesIO(p_bytes))
                    except Exception:
                        p_table = pa.ipc.open_file(io.BytesIO(p_bytes)).read_all()
                    row_counts[d] = p_table.num_rows

                result = {"dates": dates, "entity_columns": entity_columns,
                          "row_counts": row_counts, "timestamp_col": ds.timestamp_col}
                ds.time_meta_json = json.dumps({
                    "dates": dates, "row_counts": row_counts,
                    "entity_columns": entity_columns,
                    "total_rows": sum(row_counts.values()),
                })
                session.commit()
                return make_response(result)
            return make_response(empty)

        dates, row_counts, _ = _get_partition_meta(ds)
        if not dates:
            return make_response(empty)

        first_bytes = storage.read_partition(ds.content_hash, dates[0])
        schema = pq.read_schema(io.BytesIO(first_bytes))
        entity_columns = [f for f in schema.names if f != ds.timestamp_col]

        result = {"dates": dates, "entity_columns": entity_columns,
                  "row_counts": row_counts, "timestamp_col": ds.timestamp_col}
        ds.time_meta_json = json.dumps({
            "dates": dates, "row_counts": row_counts,
            "entity_columns": entity_columns,
            "total_rows": sum(row_counts.values()),
        })
        session.commit()
        return make_response(result)
    except Exception as e:
        logging.exception("getDatasetPartitions failed for dataset %d", dataset_id)
        return make_response(str(e), status=500)


@router.get("/api/datasets/{dataset_id}/stream/{date_str}")
async def streamDatasetPartition(dataset_id: int, date_str: str, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)

        if ds.extension_name and hasattr(request.app.state, 'extension_storage'):
            adapter = request.app.state.extension_storage
            try:
                arrow_bytes = adapter.get_dataset_partition_bytes(
                    ds.extension_name, ds.extension_ref, date_str
                )
            except (FileNotFoundError, NotImplementedError):
                return make_response(f"partition {date_str} not found", status=404)
            try:
                table = pq.read_table(io.BytesIO(arrow_bytes))
            except Exception:
                table = pa.ipc.open_file(io.BytesIO(arrow_bytes)).read_all()
            buf = io.BytesIO()
            writer = pa.ipc.new_stream(buf, table.schema)
            writer.write_table(table)
            writer.close()
            return Response(
                content=buf.getvalue(),
                status_code=200,
                media_type="application/vnd.apache.arrow.stream",
            )

        try:
            parquet_bytes = storage.read_partition(ds.content_hash, date_str)
        except FileNotFoundError:
            return make_response(f"partition {date_str} not found", status=404)

        table = pq.read_table(io.BytesIO(parquet_bytes))
        buf = io.BytesIO()
        writer = pa.ipc.new_stream(buf, table.schema)
        writer.write_table(table)
        writer.close()

        return Response(
            content=buf.getvalue(),
            status_code=200,
            media_type="application/vnd.apache.arrow.stream",
        )
    except Exception as e:
        logging.exception("streamDatasetPartition failed for dataset %d date %s", dataset_id, date_str)
        return make_response(str(e), status=500)


@router.patch("/api/datasets/{dataset_id}")
async def updateDataset(dataset_id: int, body: UpdateDatasetBody, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)
        if body.name is not None:
            ds.name = body.name
        if body.display_name is not None:
            ds.display_name = body.display_name
        if body.description is not None:
            ds.description = body.description
        if body.join_key is not None:
            ds.join_key = body.join_key
        if body.timestamp_col is not None:
            ds.timestamp_col = body.timestamp_col
        session.commit()
        db.save_to_disk()
        return make_response(serialize_dataset(ds))
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.delete("/api/datasets/{dataset_id}")
async def deleteDataset(dataset_id: int, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    """Delete an uploaded dataset and cascade-clean everything it spawned:
    LayerDataset bindings (and their style mappings), JoinHint rows, the
    table/column descriptions keyed by the DuckDB-qualified name, the
    registered DuckDB table, and its in-memory catalog entry."""
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)

        # Style mappings hang off layer_datasets; remove them before the
        # bindings so we don't leave orphaned rows (SQLite FKs aren't enforced).
        ld_ids = [
            ld.id for ld in session.query(LayerDataset).filter(
                LayerDataset.dataset_id == dataset_id
            ).all()
        ]
        if ld_ids:
            session.query(LayerStyleMapping).filter(
                LayerStyleMapping.layer_dataset_id.in_(ld_ids)
            ).delete(synchronize_session=False)
            session.query(LayerDataset).filter(
                LayerDataset.dataset_id == dataset_id
            ).delete(synchronize_session=False)

        # JoinHints discovered by the profiler for this dataset.
        session.query(JoinHint).filter(
            JoinHint.dataset_id == dataset_id
        ).delete(synchronize_session=False)

        # Drop the DuckDB table + catalog entry, and learn the qualified name
        # (e.g. "user.my_dataset") that descriptions are keyed by.
        qualified_name = f"user.{ds.name}"
        try:
            engine = request.app.state.duckdb_engine
            qualified_name = engine.unregister_user_dataset(table=ds.name)
        except Exception as e:
            logger.warning("[deleteDataset] DuckDB unregister failed (non-fatal): %s", e)

        # Table/column descriptions keyed by the DuckDB-qualified name.
        td = session.query(TableDescription).filter(
            TableDescription.table_name == qualified_name
        ).first()
        if td:
            session.query(ColumnDescription).filter(
                ColumnDescription.table_description_id == td.id
            ).delete(synchronize_session=False)
            session.delete(td)

        # Finally the Dataset row itself (scenario_datasets association rows are
        # cleared by SQLAlchemy via the many-to-many relationship).
        session.delete(ds)
        session.commit()
        db.save_to_disk()
        return make_response({"ok": True})
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.get("/api/datasets/{dataset_id}/entity/{entity_id}/timeseries")
async def getEntityTimeseries(dataset_id: int, entity_id: str, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)
        if not ds.timestamp_col:
            return make_response("not a timeseries dataset", status=400)

        is_extension = bool(ds.extension_name) and hasattr(request.app.state, 'extension_storage')
        if is_extension:
            adapter = request.app.state.extension_storage
            fast = adapter.get_entity_timeseries(
                ds.extension_name, ds.extension_ref, entity_id,
            )
            if fast is not None:
                return make_response(fast, cache_seconds=300)
            try:
                dates = adapter.list_dataset_partitions(ds.extension_name, ds.extension_ref)
            except Exception:
                dates = []
        else:
            dates = storage.list_partitions(ds.content_hash)

        if not dates:
            return make_response({"timestamps": [], "values": []})

        def read_table_for_date(date_str: str):
            if is_extension:
                raw = adapter.get_dataset_partition_bytes(
                    ds.extension_name, ds.extension_ref, date_str
                )
                try:
                    return pq.read_table(io.BytesIO(raw))
                except Exception:
                    return pa.ipc.open_file(io.BytesIO(raw)).read_all()
            parquet_bytes = storage.read_partition(ds.content_hash, date_str)
            return pq.read_table(io.BytesIO(parquet_bytes))

        timestamps = []
        values = []
        for date_str in dates:
            try:
                table = read_table_for_date(date_str)
            except FileNotFoundError:
                continue
            except Exception:
                logging.exception("[entity_timeseries] failed to read partition %s", date_str)
                continue

            ts_col = table.column(ds.timestamp_col)
            if entity_id not in table.column_names:
                continue
            val_col = table.column(entity_id)

            for i in range(table.num_rows):
                timestamps.append(str(ts_col[i].as_py()))
                v = val_col[i].as_py()
                values.append(float(v) if v is not None else None)

        return make_response({"timestamps": timestamps, "values": values}, cache_seconds=300)
    except Exception as e:
        logging.exception("GET /api/datasets/.../entity/.../timeseries failed")
        return make_response(str(e), status=500)


@router.get("/api/datasets/{dataset_id}/entity/{entity_id}/series")
async def getEntitySeriesWindow(
    dataset_id: int,
    entity_id: str,
    request: Request,
    from_ts: str | None = None,
    to_ts: str | None = None,
    max_points: int | None = None,
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
):
    try:
        ds = session.query(Dataset).filter(Dataset.id == dataset_id).first()
        if not ds:
            return make_response("not found", status=404)
        if not ds.timestamp_col:
            return make_response("not a timeseries dataset", status=400)

        is_extension = bool(ds.extension_name) and hasattr(request.app.state, 'extension_storage')
        if is_extension:
            adapter = request.app.state.extension_storage
            ipc = adapter.get_entity_series(
                ds.extension_name, ds.extension_ref, entity_id,
                from_ts, to_ts, max_points,
            )
            if ipc is not None:
                return Response(
                    content=ipc,
                    status_code=200,
                    media_type="application/vnd.apache.arrow.stream",
                    headers={"Cache-Control": "private, max-age=300"},
                )

        try:
            if is_extension:
                dates = request.app.state.extension_storage.list_dataset_partitions(
                    ds.extension_name, ds.extension_ref,
                )
            else:
                dates = storage.list_partitions(ds.content_hash)
        except Exception:
            dates = []
        if not dates:
            return _empty_series_response()

        lo = (from_ts or "")[:10]
        hi = (to_ts or "")[:10]
        windowed_dates = [
            d for d in dates
            if (not lo or d >= lo) and (not hi or d <= hi)
        ]
        if not windowed_dates:
            return _empty_series_response()

        ts_chunks: list = []
        val_chunks: list = []
        for date_str in windowed_dates:
            try:
                if is_extension:
                    raw = request.app.state.extension_storage.get_dataset_partition_bytes(
                        ds.extension_name, ds.extension_ref, date_str,
                    )
                    try:
                        table = pq.read_table(io.BytesIO(raw))
                    except Exception:
                        table = pa.ipc.open_file(io.BytesIO(raw)).read_all()
                else:
                    table = pq.read_table(
                        io.BytesIO(storage.read_partition(ds.content_hash, date_str)),
                        columns=[ds.timestamp_col, entity_id],
                    )
            except (FileNotFoundError, Exception):
                continue
            if entity_id not in table.column_names:
                continue
            ts_chunks.append(table.column(ds.timestamp_col))
            val_chunks.append(table.column(entity_id))

        if not ts_chunks:
            return _empty_series_response()

        ts_arr = pa.concat_arrays([c.combine_chunks() for c in ts_chunks])
        val_arr = pa.concat_arrays([c.combine_chunks() for c in val_chunks])
        if from_ts or to_ts:
            ts_strs = [str(t) for t in ts_arr.to_pylist()]
            keep = [
                i for i, t in enumerate(ts_strs)
                if (not from_ts or t >= from_ts) and (not to_ts or t <= to_ts)
            ]
            if keep:
                idx = pa.array(keep, type=pa.int64())
                ts_arr = ts_arr.take(idx)
                val_arr = val_arr.take(idx)
            else:
                return _empty_series_response()

        if max_points and len(ts_arr) > max_points:
            stride = max(1, len(ts_arr) // max_points)
            idx = pa.array(list(range(0, len(ts_arr), stride)), type=pa.int64())
            ts_arr = ts_arr.take(idx)
            val_arr = val_arr.take(idx)

        out = pa.table({"timestamp": ts_arr, "value": val_arr.cast(pa.float64())})
        buf = io.BytesIO()
        w = pa.ipc.new_stream(buf, out.schema)
        w.write_table(out)
        w.close()
        return Response(
            content=buf.getvalue(),
            status_code=200,
            media_type="application/vnd.apache.arrow.stream",
            headers={"Cache-Control": "private, max-age=300"},
        )
    except Exception as e:
        logging.exception("GET /api/datasets/.../entity/.../series failed")
        return make_response(str(e), status=500)


@router.post("/api/datasets/rows")
async def getDatasetRows(requests: list[DatasetRowRequest], request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    try:
        result: dict[str, dict] = {}
        meta_cache: dict[int, tuple[list[str], dict[str, int], dict[str, int], Dataset]] = {}

        for req in requests:
            ds_id = req.dataset_id
            if ds_id not in meta_cache:
                ds = session.query(Dataset).filter(Dataset.id == ds_id).first()
                if not ds:
                    result[str(ds_id)] = {"error": "not found"}
                    continue
                if not ds.timestamp_col:
                    result[str(ds_id)] = {"error": "not a timeseries dataset"}
                    continue

                if ds.extension_name and hasattr(request.app.state, 'extension_storage'):
                    adapter = request.app.state.extension_storage
                    dates = adapter.list_dataset_partitions(ds.extension_name, ds.extension_ref)
                    row_counts_ext: dict[str, int] = {}
                    date_offsets_ext: dict[str, int] = {}
                    offset = 0
                    for d in dates:
                        import pyarrow.ipc as ipc
                        p_bytes = adapter.get_dataset_partition_bytes(
                            ds.extension_name, ds.extension_ref, d
                        )
                        p_reader = ipc.open_file(io.BytesIO(p_bytes))
                        rc = p_reader.read_all().num_rows
                        row_counts_ext[d] = rc
                        date_offsets_ext[d] = offset
                        offset += rc
                    meta_cache[ds_id] = (dates, row_counts_ext, date_offsets_ext, ds)
                else:
                    dates, row_counts, date_offsets = _get_partition_meta(ds)
                    meta_cache[ds_id] = (dates, row_counts, date_offsets, ds)

            if str(ds_id) in result and "error" in result[str(ds_id)]:
                continue

            dates, row_counts, date_offsets, ds = meta_cache[ds_id]
            if not dates:
                result[str(ds_id)] = {"error": "no partitions"}
                continue

            date_str, local_row = _global_index_to_date_row(
                req.row_id, dates, date_offsets, row_counts
            )

            if ds.extension_name and hasattr(request.app.state, 'extension_storage'):
                import pyarrow.ipc as ipc
                adapter = request.app.state.extension_storage
                arrow_bytes = adapter.get_dataset_partition_bytes(
                    ds.extension_name, ds.extension_ref, date_str
                )
                reader = ipc.open_file(io.BytesIO(arrow_bytes))
                table = reader.read_all()
            else:
                parquet_bytes = storage.read_partition(ds.content_hash, date_str)
                table = pq.read_table(io.BytesIO(parquet_bytes))

            row_slice = table.slice(local_row, 1).to_pydict()
            ts_col = ds.timestamp_col
            result[str(ds_id)] = {
                k: float(v[0]) if isinstance(v[0], (int, float)) else str(v[0])
                for k, v in row_slice.items()
                if k != ts_col
            }

        return make_response(result)
    except Exception as e:
        logging.exception("POST /api/datasets/rows failed")
        return make_response(str(e), status=500)


# ---------------------------------------------------------------------------
# Descriptions (CSV/PDF upload + AI generation)
# ---------------------------------------------------------------------------


@router.post("/api/descriptions/generate")
async def generateDescriptions(body: GenerateDescriptionBody, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    from lib.ai.chat import get_llm_config
    from lib.ai.openai_client import llm_chat

    llm_config = get_llm_config()
    if not llm_config:
        return make_response({"error": "No LLM configured"}, status=503)

    try:
        if body.target_type == "geometry":
            target = session.query(GeometryFile).filter(GeometryFile.id == body.target_id).first()
            if not target:
                return make_response({"error": "Geometry not found"}, status=404)
            schema = _get_geometry_schema(target, session)
            sample_info = f"Geometry file '{target.name}' with properties: {', '.join(schema.get('properties', []))}"
            if schema.get('unique_values'):
                for prop, vals in list(schema['unique_values'].items())[:5]:
                    sample_info += f"\n  {prop}: sample values = {vals[:5]}"
        elif body.target_type == "dataset":
            target = session.query(Dataset).filter(Dataset.id == body.target_id).first()
            if not target:
                return make_response({"error": "Dataset not found"}, status=404)
            ds_schema = _get_dataset_schema(target)
            columns_info = [f"  {col} ({ds_schema.get('dtypes', {}).get(col, '?')})" for col in ds_schema.get('columns', [])]
            sample_info = f"Dataset '{target.name}' ({target.format}) with columns:\n" + "\n".join(columns_info)
        else:
            return make_response({"error": "target_type must be 'geometry' or 'dataset'"}, status=400)

        if body.target_type == "geometry":
            target_columns = schema.get("properties", [])
        else:
            target_columns = ds_schema.get("columns", [])

        columns_list = "\n".join(f"  - {col}" for col in target_columns)

        if body.source == "web":
            source_context = (
                f"Based on the column names, try to identify what public dataset this might be from "
                f"(Census, EIA, EPA, NREL, etc.) and generate descriptions based on your knowledge."
            )
        else:
            source_context = f"Generate descriptions based on the data schema and sample values.\n\n{sample_info}"

        prompt = (
            f"{source_context}\n\n"
            f"Target columns:\n{columns_list}\n\n"
            f"Respond with ONLY a JSON object (no markdown, no explanation) in this exact format:\n"
            f'{{"table_description": "one-sentence description of the whole dataset",'
            f' "columns": {{"column_name": "description", "column_name2": "description2", ...}}}}\n\n'
            f"Include ALL {len(target_columns)} columns. If you cannot determine a description, "
            f"write your best guess based on the column name."
        )

        messages = [
            {"role": "system", "content": "You are a data documentation assistant. Respond with ONLY valid JSON, no markdown fences, no explanation text."},
            {"role": "user", "content": prompt},
        ]

        try:
            result = await llm_chat(
                llm_config["provider"], llm_config["model"], messages, tools=[], timeout=120,
            )
            content = (result.get("content") or "").strip()
            if content.startswith("```"):
                content = "\n".join(content.split("\n")[1:])
            if content.endswith("```"):
                content = "\n".join(content.split("\n")[:-1])
            content = content.strip()
            parsed = json.loads(content)
        except json.JSONDecodeError as e:
            return make_response({"error": f"AI returned invalid JSON: {e}"}, status=502)
        except Exception as e:
            return make_response({"error": f"LLM call failed: {e}"}, status=504)

        from models.orm import TableDescription, ColumnDescription

        session2 = db.get_session()
        descriptions_written = 0
        try:
            td = session2.query(TableDescription).filter(
                TableDescription.table_name == target.name,
            ).first()
            if not td:
                td = TableDescription(table_name=target.name, source="ai")
                session2.add(td)
                session2.flush()

            table_desc = parsed.get("table_description")
            if table_desc:
                td.description = table_desc
                td.source = "ai"

            col_descs = parsed.get("columns", {})
            for col_name, col_desc in col_descs.items():
                if not col_name or not col_desc:
                    continue
                matched_col = None
                for tc in target_columns:
                    if tc.lower() == col_name.lower():
                        matched_col = tc
                        break
                if not matched_col:
                    continue

                cd = session2.query(ColumnDescription).filter(
                    ColumnDescription.table_description_id == td.id,
                    ColumnDescription.column_name == matched_col,
                ).first()
                if not cd:
                    cd = ColumnDescription(table_description_id=td.id, column_name=matched_col, source="ai")
                    session2.add(cd)
                cd.description = str(col_desc).strip()
                cd.source = "ai"
                descriptions_written += 1

            if table_desc:
                if body.target_type == "geometry":
                    geo = session2.query(GeometryFile).filter(GeometryFile.id == body.target_id).first()
                    if geo:
                        geo.description = table_desc
                elif body.target_type == "dataset":
                    ds = session2.query(Dataset).filter(Dataset.id == body.target_id).first()
                    if ds:
                        ds.description = table_desc

            session2.commit()
            db.save_to_disk()
        except Exception as e:
            session2.rollback()
            return make_response({"error": f"Failed to save descriptions: {e}"}, status=500)
        finally:
            session2.close()

        return make_response({"ok": True, "descriptions_written": descriptions_written})
    except Exception as e:
        logger.exception("Description generation failed")
        return make_response({"error": str(e)}, status=500)


@router.post("/api/descriptions/upload")
async def uploadDescriptionFile(
    session: Session = Depends(db.get_db_session),
    _=Depends(require_api_key),
    file: UploadFile = File(...),
    target_type: str = Form("dataset"),
    target_id: int = Form(...),
):
    data = await file.read()
    ext = (file.filename or "").rsplit(".", 1)[-1].lower()

    sha = hashlib.sha256(data).hexdigest()
    try:
        storage.upload_file("description", sha, data)
    except Exception:
        pass

    if target_type == "geometry":
        target = session.query(GeometryFile).filter(GeometryFile.id == target_id).first()
    else:
        target = session.query(Dataset).filter(Dataset.id == target_id).first()
    if not target:
        return make_response({"error": f"{target_type} {target_id} not found"}, status=404)

    target_name = target.name

    if target_type == "geometry":
        schema = _get_geometry_schema(target, session)
        target_columns = schema.get("properties", [])
    else:
        schema = _get_dataset_schema(target)
        target_columns = schema.get("columns", [])

    if ext == "csv":
        return await _process_csv_descriptions(data, target_name, target_columns, target_id, target_type)
    elif ext == "pdf":
        return await _process_pdf_descriptions(data, target_name, target_columns, target_id, target_type)
    else:
        return make_response({"error": f"Unsupported file type: {ext}. Use CSV or PDF."}, status=400)


async def _process_csv_descriptions(data: bytes, target_name: str, target_columns: list, target_id: int, target_type: str):
    try:
        df = pl.read_csv(io.BytesIO(data))
    except Exception as e:
        return make_response({"error": f"Could not read CSV: {e}"}, status=400)

    col_map = {c.lower(): c for c in df.columns}
    name_col = None
    desc_col = None

    for candidate in ["column_name", "field_name", "field", "name", "column", "variable"]:
        if candidate in col_map:
            name_col = col_map[candidate]
            break
    for candidate in ["description", "desc", "definition", "label", "meaning"]:
        if candidate in col_map:
            desc_col = col_map[candidate]
            break

    if name_col and desc_col:
        from models.orm import TableDescription, ColumnDescription

        session = db.get_session()
        try:
            td = session.query(TableDescription).filter(TableDescription.table_name == target_name).first()
            if not td:
                td = TableDescription(table_name=target_name, source="user")
                session.add(td)
                session.flush()

            target_cols_lower = {c.lower(): c for c in target_columns}
            matched = 0
            for row in df.iter_rows(named=True):
                csv_col_name = str(row.get(name_col, "")).strip()
                csv_desc = str(row.get(desc_col, "")).strip()
                if not csv_col_name or not csv_desc:
                    continue

                actual_col = target_cols_lower.get(csv_col_name.lower())
                if not actual_col:
                    continue

                cd = session.query(ColumnDescription).filter(
                    ColumnDescription.table_description_id == td.id,
                    ColumnDescription.column_name == actual_col,
                ).first()
                if not cd:
                    cd = ColumnDescription(table_description_id=td.id, column_name=actual_col, source="user")
                    session.add(cd)
                cd.description = csv_desc
                cd.source = "user"
                matched += 1

            session.commit()
            db.save_to_disk()
            total = len(df)

            if matched > 0 and matched >= total * 0.3:
                return make_response({"ok": True, "method": "direct_match", "matched": matched, "total": total})
        except Exception:
            session.rollback()
        finally:
            session.close()

    return await _ai_describe_from_text(
        f"CSV contents:\n{df.head(50).to_pandas().to_string()}\n\nTarget columns: {target_columns}",
        target_name, target_columns,
    )


async def _process_pdf_descriptions(data: bytes, target_name: str, target_columns: list, target_id: int, target_type: str):
    try:
        import pdfplumber
        text_parts = []
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages[:20]:
                text_parts.append(page.extract_text() or "")
        text = "\n".join(text_parts)
    except ImportError:
        return make_response({"error": "PDF processing requires pdfplumber. Install it with: pip install pdfplumber"}, status=500)
    except Exception as e:
        return make_response({"error": f"Could not read PDF: {e}"}, status=400)

    if not text.strip():
        return make_response({"error": "Could not extract text from PDF"}, status=400)

    return await _ai_describe_from_text(
        f"PDF document text:\n{text[:8000]}\n\nTarget columns: {target_columns}",
        target_name, target_columns,
    )


async def _ai_describe_from_text(context: str, target_name: str, target_columns: list):
    from lib.ai.chat import get_llm_config
    from lib.ai.openai_client import llm_chat

    llm_config = get_llm_config()
    if not llm_config:
        return make_response({"error": "No LLM configured"}, status=503)

    columns_list = "\n".join(f"  - {col}" for col in target_columns)
    prompt = (
        f"Generate a description for each column in the target dataset.\n\n"
        f"Source document / data:\n{context}\n\n"
        f"Target columns:\n{columns_list}\n\n"
        f"Respond with ONLY a JSON object (no markdown, no explanation) in this exact format:\n"
        f'{{"table_description": "one-sentence description of the whole dataset",'
        f' "columns": {{"column_name": "description", "column_name2": "description2", ...}}}}\n\n'
        f"Include ALL {len(target_columns)} columns. If you cannot determine a description "
        f"from the source, write your best guess based on the column name."
    )

    messages = [
        {"role": "system", "content": "You are a data documentation assistant. Respond with ONLY valid JSON, no markdown fences, no explanation text."},
        {"role": "user", "content": prompt},
    ]

    try:
        result = await llm_chat(
            llm_config["provider"], llm_config["model"], messages, tools=[], timeout=120,
        )
        content = (result.get("content") or "").strip()
        if content.startswith("```"):
            content = "\n".join(content.split("\n")[1:])
        if content.endswith("```"):
            content = "\n".join(content.split("\n")[:-1])
        content = content.strip()

        parsed = json.loads(content)
    except json.JSONDecodeError as e:
        logger.warning("AI returned invalid JSON for descriptions: %s", e)
        return make_response({"error": f"AI returned invalid JSON: {e}. Content started with: {content[:200]}"}, status=502)
    except Exception as e:
        logger.warning("AI description generation failed: %s", e)
        return make_response({"error": f"LLM call failed: {e}"}, status=504)

    from models.orm import TableDescription, ColumnDescription

    session = db.get_session()
    descriptions_written = 0
    try:
        td = session.query(TableDescription).filter(
            TableDescription.table_name == target_name,
        ).first()
        if not td:
            td = TableDescription(table_name=target_name, source="ai")
            session.add(td)
            session.flush()

        table_desc = parsed.get("table_description")
        if table_desc:
            td.description = table_desc
            td.source = "ai"

        col_descs = parsed.get("columns", {})
        for col_name, col_desc in col_descs.items():
            if not col_name or not col_desc:
                continue
            matched_col = None
            for tc in target_columns:
                if tc.lower() == col_name.lower():
                    matched_col = tc
                    break
            if not matched_col:
                continue

            cd = session.query(ColumnDescription).filter(
                ColumnDescription.table_description_id == td.id,
                ColumnDescription.column_name == matched_col,
            ).first()
            if not cd:
                cd = ColumnDescription(
                    table_description_id=td.id,
                    column_name=matched_col,
                    source="ai",
                )
                session.add(cd)
            cd.description = str(col_desc).strip()
            cd.source = "ai"
            descriptions_written += 1

        session.commit()
        db.save_to_disk()
    except Exception as e:
        session.rollback()
        logger.warning("Failed to write AI descriptions to DB: %s", e)
        return make_response({"error": f"Failed to save descriptions: {e}"}, status=500)
    finally:
        session.close()

    return make_response({"ok": True, "method": "ai", "descriptions_written": descriptions_written})


@router.get("/api/descriptions/{table_name}")
async def getDescriptions(table_name: str, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    from models.orm import TableDescription, ColumnDescription

    td = session.query(TableDescription).filter(
        TableDescription.table_name == table_name,
    ).first()
    if not td:
        return make_response({"table_name": table_name, "description": None, "columns": {}})
    col_descs = session.query(ColumnDescription).filter(
        ColumnDescription.table_description_id == td.id,
    ).all()
    columns = {}
    for cd in col_descs:
        columns[cd.column_name] = {
            "description": cd.description,
            "data_type": cd.data_type,
            "is_joinable": bool(cd.is_joinable),
            "join_target_table": cd.join_target_table,
            "join_target_column": cd.join_target_column,
            "source": cd.source,
        }
    return make_response({
        "table_name": table_name,
        "description": td.description,
        "source": td.source,
        "columns": columns,
    })
