#!/usr/bin/env python
# encoding: utf-8
import logging
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

# ---------------------------------------------------------------------------
# Logging — configure once at import time so all modules inherit the format.
# Level is driven by the LOG_LEVEL env var (default: INFO — quiet enough for
# everyday dev/prod). Set LOG_LEVEL=DEBUG for verbose tracing.
#
# IMPORTANT: logging must be configured before `import db` because db.py
# calls resolve_path() at module level (to download DB_PATH from S3). Any
# download failure is only visible if the logger is already set up.
# ---------------------------------------------------------------------------

_log_level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, _log_level_name, logging.INFO),
    format="[server] %(levelname)-5s %(name)s — %(message)s",
    force=True,
)

# Silence chatty third-party loggers regardless of root level. python_multipart
# at DEBUG logs per parser-callback (per ~256 KB chunk), which serializes
# stderr writes and TCP-backpressures multi-GB uploads to a crawl. The other
# entries are well-behaved at WARNING and not useful at DEBUG.
for _noisy in ("python_multipart", "multipart", "urllib3", "httpx", "httpcore"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

logger = logging.getLogger("gridsight")
logger.info("Logging initialised at level %s", _log_level_name)

import db  # noqa: E402 — must follow logging.basicConfig so S3 download failures are visible

# Module-level state singletons. These must be initialised before route
# modules import them at decorator-evaluation time.
from lib.state import storage  # noqa: E402,F401 — initializes storage handler (re-exported for backwards compat)
from lib.auth import require_api_key  # noqa: E402,F401 — re-exported for any code that imported it from app
from lib.responses import make_response  # noqa: E402,F401 — re-exported for backwards compat
from lib.extensions.registry import ExtensionRegistry  # noqa: E402
from lib.extensions.duckdb_engine import DuckDBEngine  # noqa: E402
from lib.extensions.storage_adapter import ExtensionStorageAdapter  # noqa: E402
from lib.lineage import LineageManager  # noqa: E402
from lib.internal import sync_extension_data, seed_metadata_descriptions  # noqa: E402

db.init_db()


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    from gridsight.extensions import ExtensionContext, Capability

    # One lock to rule them all — SQLite session + DuckDB engine + every
    # extension's gateway all serialize on db._STATEMENT_LOCK. Two
    # separate locks deadlocked when a background ingest thread held
    # SQLite and wanted DuckDB while a chart request held DuckDB and
    # wanted SQLite.
    duckdb_engine = DuckDBEngine(lock=db._STATEMENT_LOCK)
    registry = ExtensionRegistry()
    lineage_manager = LineageManager(get_session=db.get_session)

    context = ExtensionContext(
        data_dir=os.environ.get("DATA_DIR", "./data"),
        duckdb_conn=duckdb_engine.conn,
        duckdb_lock=duckdb_engine.lock,
        get_db_session=db.get_session,
    )
    registry.discover_and_load(context)

    # Built-in demo extensions get registered here. The graph-view
    # demo is intentionally commented out while the Graph panel is
    # disabled (see panelRegistry.jsx). Re-enable both together.
    # from lib.builtins.demo_graph import DemoGraphExtension
    # registry.register(DemoGraphExtension(), context)

    # Register DuckDB tables for extensions that declare the capability,
    # and create DATA_SOURCE lineage nodes for each registered table.
    for name, ext in registry.items():
        manifest = registry.get_manifest(name)
        if manifest and Capability.DUCKDB_TABLES in manifest.capabilities:
            duckdb_engine.register_extension(name, ext)
            for table_info in duckdb_engine.get_tables_for_extension(name):
                lineage_manager.record_data_source(
                    source_type="extension_table",
                    table_name=table_info.table_name,
                    extension_name=table_info.extension_name,
                    columns=table_info.columns,
                )

    # Re-register user-uploaded datasets (extension_name is NULL) into DuckDB
    # so they remain queryable after a restart. The DuckDB connection is
    # in-memory, but the dataset bytes persist via the storage backend.
    try:
        from models.orm import Dataset  # noqa: E402

        _sess = db.get_session()
        try:
            user_dsets = (
                _sess.query(Dataset).filter(Dataset.extension_name.is_(None)).all()
            )
        finally:
            _sess.close()
        for ds in user_dsets:
            if not ds.content_hash:
                continue
            try:
                raw = storage.read_file_bytes(ds.content_hash)
                duckdb_engine.register_user_dataset(
                    table=ds.name,
                    data=raw,
                    fmt="csv" if ds.format == "csv" else "parquet",
                    description=ds.description or "",
                )
            except Exception:
                logger.warning(
                    "Re-registering user dataset %s failed", ds.name, exc_info=True
                )
    except Exception:
        logger.warning("User-dataset re-registration pass failed", exc_info=True)

    sync_extension_data(registry)
    seed_metadata_descriptions(registry)
    lineage_manager.backfill_existing_perspectives()

    app.state.extension_registry = registry
    app.state.duckdb_engine = duckdb_engine
    app.state.extension_storage = ExtensionStorageAdapter(registry)
    app.state.lineage_manager = lineage_manager

    yield

    registry.shutdown_all()
    duckdb_engine.close()
    db.save_to_disk()
    # Push any S3-backed paths (DB_PATH, GAT_DB_PATH, …) back to the
    # bucket while boto3's threadpool is still alive. Calling this from
    # atexit doesn't work — Python tears down the executor first and
    # uploads fail with "cannot schedule new futures after interpreter
    # shutdown".
    from gridsight.extensions.storage import flush_pending
    flush_pending()


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


app = FastAPI(lifespan=lifespan)

# When running embedded in the Tauri desktop shell, the webview origin differs
# from the sidecar's localhost host, so the browser requires CORS. The flag is
# off by default — production deployments behind the Bun proxy are unaffected.
if os.environ.get("GRIDSIGHT_DESKTOP") == "1":
    from fastapi.middleware.cors import CORSMiddleware
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^(tauri://.*|http://(localhost|127\.0\.0\.1)(:\d+)?|https://tauri\.localhost)$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["*"],
    )


# ---------------------------------------------------------------------------
# Mount routers. Order matters when paths overlap — more-specific
# patterns must mount BEFORE the catch-all /api/{project}/{scenario}
# route in `misc`. Layers also has /api/layers/{layer_id}/paintings and
# /api/layers/{layer_id}/datasets that must be matched before the
# catch-all /api/layers/{project}/{scenario}, so we register them in
# the order the original app.py declared them.
# ---------------------------------------------------------------------------

from routes import (  # noqa: E402
    ai,
    category_maps,
    datasets,
    extensions,
    geometry,
    layers,
    lineage,
    misc,
    perspectives,
    preferences,
    projects,
    sync,
)

# Desktop-only: MCP inject bridge. Excluded from container builds where
# GRIDSIGHT_DESKTOP is unset — the endpoint must never be reachable on a
# network-accessible deployment.
if os.environ.get("GRIDSIGHT_DESKTOP") == "1":
    from routes import internal  # noqa: E402
    app.include_router(internal.router)

# More-specific routers first; catch-all last.
app.include_router(projects.router)
app.include_router(geometry.router)
app.include_router(datasets.router)
app.include_router(layers.router)
app.include_router(category_maps.router)
app.include_router(extensions.router)
app.include_router(perspectives.router)
app.include_router(preferences.router)
app.include_router(ai.router)
app.include_router(sync.router)
app.include_router(lineage.router)
# /health + catch-all /api/{project}/{scenario} must be last — the
# catch-all would otherwise swallow any /api/<resource>/<id> request.
app.include_router(misc.router)
