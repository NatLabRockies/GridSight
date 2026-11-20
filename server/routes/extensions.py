"""Extension routes: list, preferences, data passthrough, uploads, query,
category maps, input/data controls, charts, shaders, icons, scenarios."""
from __future__ import annotations

import io
import logging
import os
import shutil
import tempfile
import threading as _threading
import time as _time
import uuid as _uuid
from dataclasses import asdict
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

import db
from lib.auth import require_api_key
from lib.extensions.duckdb_engine import DuckDBEngine
from lib.extensions.registry import ExtensionRegistry
from lib.extensions.storage_adapter import ExtensionStorageAdapter
from lib.internal import sync_extension_data
from lib.lineage import LineageManager
from lib.responses import make_response
from lib.streaming_multipart import stream_multipart_to_dir
from models.orm import (
    CategoryMap, Dataset, GeometryFile, Layer, LayerDataset, LayerStyleMapping,
    Project, Scenario, User, UserExtensionPref,
)

logger = logging.getLogger("meridian")
router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_or_create_default_user(session) -> int:
    user = session.query(User).filter(User.username == "admin").first()
    if not user:
        try:
            user = User(username="admin", display_name="Admin", role="admin")
            session.add(user)
            session.flush()
        except Exception:
            session.rollback()
            user = session.query(User).filter(User.username == "admin").first()
    return user.id


def _resolve_icon(registry: ExtensionRegistry, m) -> str | None:
    if m.icon:
        return m.icon
    ext = registry.get(m.name)
    if ext is None:
        return None
    try:
        if ext.get_icon_bytes() is not None:
            base = os.environ.get("MERIDIAN_API_BASE", "")
            return f"{base}/api/extensions/{m.name}/icon"
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# Upload-job tracking
# ---------------------------------------------------------------------------

_upload_jobs: dict[str, dict] = {}
_upload_jobs_lock = _threading.Lock()
_UPLOAD_JOB_TTL_SEC = 60 * 60


def _purge_old_upload_jobs():
    cutoff = _time.time() - _UPLOAD_JOB_TTL_SEC
    with _upload_jobs_lock:
        stale = [
            jid for jid, j in _upload_jobs.items()
            if j.get("finished_at") and j["finished_at"] < cutoff
        ]
        for jid in stale:
            _upload_jobs.pop(jid, None)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/api/extensions")
async def listExtensions(request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    manifests = registry.list_manifests()

    user_id = _get_or_create_default_user(session)
    prefs = {
        p.extension_name: p.state
        for p in session.query(UserExtensionPref).filter(
            UserExtensionPref.user_id == user_id
        ).all()
    }

    result = []
    for m in manifests:
        ext = registry.get(m.name)
        projects = [p.name for p in ext.list_projects()] if ext else []
        state = prefs.get(m.name, "enabled")
        if state == "hidden":
            continue
        result.append({
            "name": m.name,
            "display_name": m.display_name,
            "version": m.version,
            "description": m.description,
            "capabilities": [c.value for c in m.capabilities],
            "icon": _resolve_icon(registry, m),
            "projects": projects,
            "state": state,
        })
    return make_response(result)


@router.get("/api/extensions/preferences")
async def getExtensionPreferences(request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    user_id = _get_or_create_default_user(session)
    prefs = {
        p.extension_name: p.state
        for p in session.query(UserExtensionPref).filter(
            UserExtensionPref.user_id == user_id
        ).all()
    }
    result = []
    for m in registry.list_manifests():
        result.append({
            "name": m.name,
            "display_name": m.display_name,
            "icon": _resolve_icon(registry, m),
            "state": prefs.get(m.name, "enabled"),
        })
    return make_response(result)


@router.patch("/api/extensions/{ext_name}/preference")
async def setExtensionPreference(ext_name: str, body: dict, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    new_state = body.get("state")
    if new_state not in ("enabled", "disabled", "hidden"):
        return make_response("state must be 'enabled', 'disabled', or 'hidden'", status=400)
    try:
        user_id = _get_or_create_default_user(session)
        pref = session.query(UserExtensionPref).filter(
            UserExtensionPref.user_id == user_id,
            UserExtensionPref.extension_name == ext_name,
        ).first()
        if pref:
            pref.state = new_state
        else:
            session.add(UserExtensionPref(
                user_id=user_id, extension_name=ext_name, state=new_state,
            ))
        session.commit()
        db.save_to_disk()
        return make_response({"extension_name": ext_name, "state": new_state})
    except Exception as e:
        session.rollback()
        return make_response(str(e), status=500)


@router.get("/api/extensions/{ext_name}/geometry/{ref}/data")
async def getExtensionGeometryData(ext_name: str, ref: str, request: Request, _=Depends(require_api_key)):
    try:
        adapter: ExtensionStorageAdapter = request.app.state.extension_storage
        data = adapter.get_geometry_bytes(ext_name, ref)
        return Response(content=data, media_type="application/geo+json")
    except ValueError as e:
        raise HTTPException(404, str(e))
    except NotImplementedError:
        raise HTTPException(501, "Extension does not provide this geometry")


@router.get("/api/extensions/{ext_name}/dataset/{ref}/data")
async def getExtensionDatasetData(ext_name: str, ref: str, request: Request, _=Depends(require_api_key)):
    try:
        adapter: ExtensionStorageAdapter = request.app.state.extension_storage
        data = adapter.get_dataset_bytes(ext_name, ref)
        return Response(content=data, media_type="application/octet-stream")
    except ValueError as e:
        raise HTTPException(404, str(e))
    except NotImplementedError:
        raise HTTPException(501, "Extension does not provide this dataset")


@router.get("/api/extensions/{ext_name}/dataset/{ref}/partitions")
async def getExtensionDatasetPartitions(ext_name: str, ref: str, request: Request, _=Depends(require_api_key)):
    try:
        adapter: ExtensionStorageAdapter = request.app.state.extension_storage
        dates = adapter.list_dataset_partitions(ext_name, ref)
        return make_response({"dates": dates})
    except ValueError as e:
        raise HTTPException(404, str(e))


@router.get("/api/extensions/{ext_name}/dataset/{ref}/stream/{date_str}")
async def streamExtensionPartition(ext_name: str, ref: str, date_str: str, request: Request, _=Depends(require_api_key)):
    try:
        adapter: ExtensionStorageAdapter = request.app.state.extension_storage
        parquet_bytes = adapter.get_dataset_partition_bytes(ext_name, ref, date_str)

        table = pq.read_table(io.BytesIO(parquet_bytes))
        buf = io.BytesIO()
        writer = pa.ipc.new_stream(buf, table.schema)
        writer.write_table(table)
        writer.close()
        return Response(content=buf.getvalue(), media_type="application/vnd.apache.arrow.stream")
    except ValueError as e:
        raise HTTPException(404, str(e))
    except NotImplementedError:
        raise HTTPException(501, "Extension does not provide this partition")


@router.get("/api/extensions/{ext_name}/graph-topologies")
async def listExtensionGraphTopologies(
    ext_name: str,
    request: Request,
    project: str | None = None,
    scenario: str | None = None,
    _=Depends(require_api_key),
):
    """List graph topologies an extension can serve for a project/scenario.

    Returns descriptors only — the actual nodes/edges payload comes from
    the ``/data`` endpoint below so the catalog stays cheap.
    """
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    try:
        topos = ext.list_graph_topologies(project=project, scenario=scenario)
    except NotImplementedError:
        return make_response({"topologies": []})
    return make_response({"topologies": [asdict(t) for t in (topos or [])]})


@router.get("/api/extensions/{ext_name}/graph-topology/{topology_name}/data")
async def getExtensionGraphTopologyData(
    ext_name: str,
    topology_name: str,
    request: Request,
    project: str | None = None,
    scenario: str | None = None,
    _=Depends(require_api_key),
):
    """Return a fully-laid-out graph topology as JSON.

    If the extension supplies precomputed positions, those flow through
    unchanged. Otherwise the default stratified layout fills in (x, y).
    """
    from lib.graph_layout import apply_default_layout

    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    try:
        topo = ext.get_graph_topology(topology_name, project=project, scenario=scenario)
    except NotImplementedError:
        raise HTTPException(501, "Extension does not provide graph topologies")
    if topo is None:
        raise HTTPException(404, f"Topology {topology_name} not found")

    apply_default_layout(topo)

    return make_response({
        "nodes": [asdict(n) for n in topo.nodes],
        "edges": [asdict(e) for e in topo.edges],
        "strata": [asdict(s) for s in topo.strata],
        "bounds": topo.bounds,
    })


@router.get("/api/extensions/{ext_name}/category-maps/{project}/{scenario}")
async def getExtensionCategoryMaps(ext_name: str, project: str, scenario: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    maps = ext.list_category_maps(project, scenario)
    return make_response([asdict(m) for m in maps])


@router.get("/api/extensions/{ext_name}/category-maps/{ref}/data")
async def getExtensionCategoryMapData(ext_name: str, ref: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    try:
        data = ext.get_category_map_data(ref)
        return Response(content=data, media_type="application/octet-stream")
    except NotImplementedError:
        raise HTTPException(501, "Extension does not provide this category map data")


@router.get("/api/extensions/{ext_name}/input-controls/{project}/{scenario}")
async def getInputControls(ext_name: str, project: str, scenario: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    controls = ext.get_input_controls(project, scenario)
    return make_response([asdict(c) for c in controls])


@router.post("/api/extensions/{ext_name}/input-controls/{project}/{scenario}")
async def setInputControl(ext_name: str, project: str, scenario: str, body: dict, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    result = ext.set_input_control_value(project, scenario, body["control_name"], body["value"])

    try:
        from lib.lineage.manager import TransformKind, CreatorType
        from routes.ai import record_tiered_response_lineage
        lm: LineageManager = request.app.state.lineage_manager
        transform_node = lm.record_transform(
            kind=TransformKind.INPUT_CONTROL,
            content={
                "control_name": body["control_name"],
                "new_value": body["value"],
                "extension_name": ext_name,
                "project": project,
                "scenario": scenario,
                "invalidated_datasets": result.invalidated_datasets if result else [],
            },
            creator_type=CreatorType.USER,
            creator_user_id=lm.get_default_user_id(),
            extension_name=ext_name,
            label=f"Input control: {body['control_name']} = {body['value']}",
        )

        if result and result.tiered_response:
            record_tiered_response_lineage(lm, result.tiered_response, transform_node.id)
    except Exception:
        logger.warning("Failed to record input control lineage", exc_info=True)

    return make_response(asdict(result))


@router.get("/api/extensions/{ext_name}/upload-specs")
async def getExtensionUploadSpecs(ext_name: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    from meridian.extensions import Capability
    manifest = registry.get_manifest(ext_name)
    if not manifest or Capability.FILE_UPLOAD not in manifest.capabilities:
        return make_response([])
    specs = ext.get_upload_specs()
    return make_response([asdict(s) for s in specs])


@router.post("/api/extensions/{ext_name}/upload/{spec_name}")
async def handleExtensionUpload(ext_name: str, spec_name: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")

    temp_dir = Path(tempfile.mkdtemp(prefix="meridian_ext_upload_"))

    try:
        upload = await stream_multipart_to_dir(request, temp_dir)
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error("Extension upload (intake) failed for %s/%s: %s", ext_name, spec_name, e)
        raise HTTPException(500, f"Upload intake failed: {e}")
    file_paths = upload.file_paths
    form_data = upload.form_data

    _purge_old_upload_jobs()
    job_id = _uuid.uuid4().hex
    with _upload_jobs_lock:
        _upload_jobs[job_id] = {
            "job_id": job_id,
            "ext_name": ext_name,
            "spec_name": spec_name,
            "status": "pending",
            "result": None,
            "error": None,
            "started_at": _time.time(),
            "finished_at": None,
        }

    app_state = request.app.state

    def _run():
        with _upload_jobs_lock:
            _upload_jobs[job_id]["status"] = "running"
        try:
            result = ext.handle_upload(spec_name, file_paths, form_data)
            if result.success:
                sync_extension_data(registry)
                try:
                    engine: DuckDBEngine = app_state.duckdb_engine
                    engine.refresh_extension(ext_name, ext)
                except Exception as e:
                    logger.warning("Refresh DuckDB views failed for %s: %s", ext_name, e)
            with _upload_jobs_lock:
                j = _upload_jobs[job_id]
                j["status"] = "success" if result.success else "error"
                j["result"] = asdict(result)
                if not result.success:
                    j["error"] = result.error or "Upload failed"
                j["finished_at"] = _time.time()
        except Exception as e:
            logger.error("Extension upload job %s failed for %s/%s: %s",
                         job_id, ext_name, spec_name, e)
            with _upload_jobs_lock:
                j = _upload_jobs[job_id]
                j["status"] = "error"
                j["error"] = str(e)
                j["finished_at"] = _time.time()
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)

    _threading.Thread(target=_run, name=f"upload-{job_id}", daemon=True).start()
    return make_response({"job_id": job_id, "status": "pending"})


@router.post("/api/extensions/{ext_name}/upload-local/{spec_name}")
async def handleExtensionUploadLocal(ext_name: str, spec_name: str, request: Request, _=Depends(require_api_key)):
    """Desktop short-circuit: same contract as ``/upload/{spec_name}`` but
    accepts file PATHS instead of multipart bytes.

    When the React app runs inside Tauri the user's files are already on
    a disk the sidecar can read; pushing them through a multipart POST
    just to land in a ``tempfile.mkdtemp()`` is wasted I/O. This endpoint
    skips the intake entirely — the extension is handed the user's
    absolute paths directly. Same background-job semantics as the
    multipart endpoint so the client polls ``/upload-jobs/{job_id}`` the
    same way.

    Body shape (JSON):
        {
            "file_paths": { "<group_name>": ["/abs/path1", "/abs/path2"], ... },
            "form_data":  { "<field>": "<value>", ... }
        }

    Paths must be absolute and readable. Symlinks are followed.
    """
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")

    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(400, f"Body must be JSON: {e}")
    file_paths_raw = body.get("file_paths") or {}
    form_data = body.get("form_data") or {}
    if not isinstance(file_paths_raw, dict):
        raise HTTPException(400, "file_paths must be a {group: [paths]} object")
    if not isinstance(form_data, dict):
        raise HTTPException(400, "form_data must be an object")

    # Normalise + validate. Reject relative paths and missing files
    # upfront so the extension code can trust what it receives.
    file_paths: dict[str, list[str]] = {}
    for group, paths in file_paths_raw.items():
        if not isinstance(paths, list):
            raise HTTPException(400, f"file_paths[{group}] must be a list")
        resolved = []
        for p in paths:
            if not isinstance(p, str):
                raise HTTPException(400, f"file_paths[{group}] contains non-string entry")
            path = Path(p)
            if not path.is_absolute():
                raise HTTPException(400, f"file path must be absolute: {p}")
            if not path.exists():
                raise HTTPException(400, f"file not found: {p}")
            resolved.append(str(path))
        file_paths[group] = resolved

    _purge_old_upload_jobs()
    job_id = _uuid.uuid4().hex
    with _upload_jobs_lock:
        _upload_jobs[job_id] = {
            "job_id": job_id,
            "ext_name": ext_name,
            "spec_name": spec_name,
            "status": "pending",
            "result": None,
            "error": None,
            "started_at": _time.time(),
            "finished_at": None,
        }

    app_state = request.app.state

    def _run():
        with _upload_jobs_lock:
            _upload_jobs[job_id]["status"] = "running"
        try:
            result = ext.handle_upload(spec_name, file_paths, form_data)
            if result.success:
                sync_extension_data(registry)
                try:
                    engine: DuckDBEngine = app_state.duckdb_engine
                    engine.refresh_extension(ext_name, ext)
                except Exception as e:
                    logger.warning("Refresh DuckDB views failed for %s: %s", ext_name, e)
            with _upload_jobs_lock:
                j = _upload_jobs[job_id]
                j["status"] = "success" if result.success else "error"
                j["result"] = asdict(result)
                if not result.success:
                    j["error"] = result.error or "Upload failed"
                j["finished_at"] = _time.time()
        except Exception as e:
            logger.error("Extension upload-local job %s failed for %s/%s: %s",
                         job_id, ext_name, spec_name, e)
            with _upload_jobs_lock:
                j = _upload_jobs[job_id]
                j["status"] = "error"
                j["error"] = str(e)
                j["finished_at"] = _time.time()
        # No temp_dir to clean — files belong to the user.

    _threading.Thread(target=_run, name=f"upload-local-{job_id}", daemon=True).start()
    return make_response({"job_id": job_id, "status": "pending"})


@router.post("/api/extensions/{ext_name}/preview-local/{spec_name}")
async def handleExtensionPreviewLocal(ext_name: str, spec_name: str, request: Request, _=Depends(require_api_key)):
    """Desktop short-circuit for ``/preview/{spec_name}``. Same JSON
    body shape as ``/upload-local/{spec_name}``; calls ``handle_preview``
    synchronously and returns the result."""
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")

    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(400, f"Body must be JSON: {e}")
    file_paths_raw = body.get("file_paths") or {}
    form_data = body.get("form_data") or {}
    if not isinstance(file_paths_raw, dict) or not isinstance(form_data, dict):
        raise HTTPException(400, "file_paths and form_data must be objects")

    file_paths: dict[str, list[str]] = {}
    for group, paths in file_paths_raw.items():
        if not isinstance(paths, list):
            raise HTTPException(400, f"file_paths[{group}] must be a list")
        resolved = []
        for p in paths:
            if not isinstance(p, str):
                raise HTTPException(400, f"file_paths[{group}] contains non-string entry")
            path = Path(p)
            if not path.is_absolute() or not path.exists():
                raise HTTPException(400, f"file path invalid: {p}")
            resolved.append(str(path))
        file_paths[group] = resolved

    try:
        result = ext.handle_preview(spec_name, file_paths, form_data)
        return make_response(asdict(result))
    except NotImplementedError:
        raise HTTPException(404, f"Preview not supported for {ext_name}/{spec_name}")
    except Exception as e:
        logger.error("Extension preview-local for %s/%s raised: %s", ext_name, spec_name, e)
        raise HTTPException(500, f"Preview failed: {e}")


@router.post("/api/extensions/{ext_name}/preview/{spec_name}")
async def handleExtensionPreview(ext_name: str, spec_name: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")

    temp_dir = Path(tempfile.mkdtemp(prefix="meridian_ext_preview_"))
    try:
        upload = await stream_multipart_to_dir(request, temp_dir)
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error("Extension preview (intake) failed for %s/%s: %s", ext_name, spec_name, e)
        raise HTTPException(500, f"Preview intake failed: {e}")
    file_paths = upload.file_paths
    form_data = upload.form_data

    try:
        result = ext.handle_preview(spec_name, file_paths, form_data)
        return make_response(asdict(result))
    except NotImplementedError:
        raise HTTPException(404, f"Preview not supported for {ext_name}/{spec_name}")
    except Exception as e:
        logger.error("Extension preview job for %s/%s raised: %s", ext_name, spec_name, e)
        raise HTTPException(500, f"Preview failed: {e}")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@router.post("/api/extensions/{ext_name}/query/{kind}")
async def handleExtensionQuery(ext_name: str, kind: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(400, "Query body must be a JSON object")
    try:
        result = ext.handle_query(kind, body)
        return make_response(result)
    except NotImplementedError as e:
        raise HTTPException(404, str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Extension query %s/%s failed: %s", ext_name, kind, e)
        raise HTTPException(500, f"Query failed: {e}")


@router.get("/api/extensions/upload-jobs/{job_id}")
async def getExtensionUploadJob(job_id: str, _=Depends(require_api_key)):
    with _upload_jobs_lock:
        job = _upload_jobs.get(job_id)
        if not job:
            raise HTTPException(404, f"Unknown upload job {job_id}")
        return make_response(dict(job))


@router.delete("/api/extensions/{ext_name}/scenarios/{project}/{scenario}")
async def deleteExtensionScenario(ext_name: str, project: str, scenario: str, request: Request, session: Session = Depends(db.get_db_session), _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")

    try:
        deleted = ext.delete_scenario(project, scenario)
    except NotImplementedError:
        raise HTTPException(400, f"Extension {ext_name} does not support scenario deletion")
    except Exception as e:
        logger.error("Extension delete_scenario failed for %s/%s/%s: %s",
                     ext_name, project, scenario, e)
        raise HTTPException(500, f"Delete failed: {e}")

    proj = (
        session.query(Project)
        .filter(Project.name == project, Project.extension_name == ext_name)
        .first()
    )
    if proj:
        scen = (
            session.query(Scenario)
            .filter(Scenario.project_id == proj.id, Scenario.name == scenario)
            .first()
        )
        if scen:
            session.delete(scen)
            session.flush()

        remaining = (
            session.query(Scenario)
            .filter(Scenario.project_id == proj.id)
            .count()
        )
        if remaining == 0:
            session.delete(proj)
            session.flush()

    for geo in (
        session.query(GeometryFile)
        .filter(GeometryFile.extension_name == ext_name)
        .all()
    ):
        if not session.query(Layer).filter(Layer.geometry_id == geo.id).first():
            session.delete(geo)
    for ds in (
        session.query(Dataset)
        .filter(Dataset.extension_name == ext_name)
        .all()
    ):
        if not session.query(LayerDataset).filter(LayerDataset.dataset_id == ds.id).first():
            session.delete(ds)
    for cm in (
        session.query(CategoryMap)
        .filter(CategoryMap.extension_name == ext_name)
        .all()
    ):
        still_used = (
            session.query(LayerStyleMapping)
            .filter(LayerStyleMapping.category_map_id == cm.id)
            .first()
        )
        if not still_used:
            session.delete(cm)
    session.commit()

    try:
        engine: DuckDBEngine = request.app.state.duckdb_engine
        engine.refresh_extension(ext_name, ext)
    except Exception as e:
        logger.warning("Refresh DuckDB views failed for %s: %s", ext_name, e)

    return make_response({"deleted": bool(deleted), "project": project, "scenario": scenario})


@router.get("/api/extensions/{ext_name}/controls/{project}/{scenario}/{entity_id}")
async def getExtensionControls(ext_name: str, project: str, scenario: str, entity_id: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    controls = ext.get_data_controls(project, scenario, entity_id)
    return make_response([asdict(c) for c in controls])


@router.post("/api/extensions/{ext_name}/controls/{project}/{scenario}/{entity_id}")
async def setExtensionControl(ext_name: str, project: str, scenario: str, entity_id: str, body: dict, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    result = ext.set_control_value(project, scenario, entity_id, body["control_name"], body["value"])

    try:
        from lib.lineage.manager import TransformKind, CreatorType
        lm: LineageManager = request.app.state.lineage_manager
        lm.record_transform(
            kind=TransformKind.DATA_CONTROL,
            content={
                "control_name": body["control_name"],
                "new_value": body["value"],
                "entity_id": entity_id,
                "extension_name": ext_name,
                "project": project,
                "scenario": scenario,
                "invalidated_datasets": result.invalidated_datasets if result else [],
            },
            creator_type=CreatorType.USER,
            creator_user_id=lm.get_default_user_id(),
            extension_name=ext_name,
            label=f"Data control: {body['control_name']} = {body['value']}",
        )
    except Exception:
        logger.warning("Failed to record data control lineage", exc_info=True)

    return make_response(asdict(result))


@router.get("/api/extensions/{ext_name}/charts")
async def getExtensionCharts(ext_name: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    specs = ext.list_chart_specs()
    return make_response([asdict(s) for s in specs])


@router.get("/api/extensions/{ext_name}/charts/{chart_name}/data")
async def getExtensionChartData(
    ext_name: str, chart_name: str,
    request: Request,
    entity_id: str = "", project: str = "", scenario: str = "",
    _=Depends(require_api_key),
):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    specs = ext.list_chart_specs()
    spec = next((s for s in specs if s.name == chart_name), None)
    if not spec:
        # The live list reflects current control state; a name whose identity
        # encodes (now-changed) state won't match — common when one extension
        # instance is shared by multiple synced clients. Give the extension a
        # chance to resolve the name statelessly before giving up.
        try:
            spec = ext.resolve_chart_spec(chart_name)
        except Exception as e:
            logger.warning("resolve_chart_spec failed for %s/%s: %s", ext_name, chart_name, e)
            spec = None
    if not spec:
        raise HTTPException(404, f"Chart {chart_name} not found in extension {ext_name}")

    sql = spec.sql_template
    replacements = {
        "{entity_id}": entity_id,
        "{project}": project,
        "{scenario}": scenario,
    }
    for placeholder, value in replacements.items():
        safe_value = value.replace("'", "").replace('"', "").replace(";", "")
        sql = sql.replace(placeholder, safe_value)

    engine: DuckDBEngine = request.app.state.duckdb_engine
    try:
        rows = engine.query_json(sql)
        return make_response(rows, cache_seconds=300)
    except Exception as e:
        return make_response({"error": str(e)}, status=400)


@router.get("/api/extensions/{ext_name}/shaders")
async def getExtensionShaders(ext_name: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    specs = ext.list_shader_specs()
    return make_response([asdict(s) for s in specs])


@router.get("/api/extensions/{ext_name}/shaders/{shader_name}")
async def getExtensionShaderSource(ext_name: str, shader_name: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    try:
        source = ext.get_shader_source(shader_name)
        return Response(content=source, media_type="text/plain")
    except NotImplementedError:
        raise HTTPException(501, "Extension does not provide this shader")


@router.get("/api/extensions/{ext_name}/icon")
async def getExtensionIcon(ext_name: str, request: Request, _=Depends(require_api_key)):
    registry: ExtensionRegistry = request.app.state.extension_registry
    ext = registry.get(ext_name)
    if not ext:
        raise HTTPException(404, f"Extension {ext_name} not found")
    data = ext.get_icon_bytes()
    if data is None:
        raise HTTPException(404, "No icon asset")
    return Response(content=data, media_type="image/svg+xml")
