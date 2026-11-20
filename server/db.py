import atexit
import logging
import os
import sqlite3
import threading
from pathlib import Path

logger = logging.getLogger("meridian.db")

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from meridian.extensions.storage import resolve_path

from models.orm import Base

# DB_PATH may be a local filesystem path *or* an s3://bucket/key URI.
# `resolve_path` downloads the object on first call (if present) and
# registers an atexit hook to upload the local file back to S3 after
# `save_to_disk` has flushed the in-memory DB to it. Local paths pass
# through unchanged.
_DB_PATH_RAW = os.environ.get("DB_PATH", "./meridian.db")
DB_PATH: Path = resolve_path(_DB_PATH_RAW)

_raw_mem_conn: sqlite3.Connection | None = None
engine = None
SessionLocal = None

# Single shared sqlite3.Connection + StaticPool means every SQLAlchemy
# session executes against the same underlying handle. pysqlite isn't
# thread-safe at the statement level: two threads racing on
# ``cursor.execute`` produce ``sqlite3.InterfaceError: bad parameter or
# other API misuse`` (and worse, surface-level corruption). FastAPI
# runs sync endpoints in a threadpool, so this DOES happen in
# production.
#
# Fix: wrap Session so the process-wide RLock is held for the session's
# lifetime — acquired in ``__init__``, released in ``close()``. Coarse
# but correct: every existing call site already follows the
# ``s = db.get_session(); try: ... finally: s.close()`` pattern so no
# caller changes are needed. Throughput is fine for this app's
# single-digit concurrency.
#
# Why not a per-statement lock via SQLAlchemy event listeners? Tried
# it. The session-level lock composes badly with FastAPI's mixed
# sync-handler-async-dep threading model (lock acquired on event-loop
# thread, used from worker thread); BUT per-statement event listeners
# composed even worse with SQLAlchemy's internal state machine in
# tests. Session-lifetime locking + manual session management is the
# pragmatic choice until we either go all-async or migrate to a real
# connection pool.
#
# Also shared with ``DuckDBEngine`` via ``ExtensionContext.duckdb_lock``
# so SQLite + DuckDB serialize on the SAME lock — see the cross-thread
# deadlock fix in commit history.
_STATEMENT_LOCK = threading.RLock()


class _LockedSession(Session):
    """SQLAlchemy Session subclass that holds ``_STATEMENT_LOCK`` for
    its lifetime. The lock is acquired in ``__init__`` and released in
    ``close()``. RLock means nested ``get_session()`` calls from the
    same thread (rare but legal) just bump the recursion count."""

    def __init__(self, *args, **kwargs):
        _STATEMENT_LOCK.acquire()
        try:
            super().__init__(*args, **kwargs)
        except BaseException:
            _STATEMENT_LOCK.release()
            raise
        self._lock_released = False

    def close(self):
        try:
            super().close()
        finally:
            if not self._lock_released:
                self._lock_released = True
                _STATEMENT_LOCK.release()

# Background snapshot thread state. atexit doesn't run on SIGSEGV (which
# the DuckDB segfault triggers), so without periodic snapshots a crash
# loses every dataset/layer registration done since process start. Snap
# every SNAPSHOT_INTERVAL_SEC so worst-case loss is bounded.
SNAPSHOT_INTERVAL_SEC = int(os.environ.get("DB_SNAPSHOT_INTERVAL_SEC", "60"))
_snapshot_thread: threading.Thread | None = None
_snapshot_stop = threading.Event()


def init_db():
    global _raw_mem_conn, engine, SessionLocal

    _raw_mem_conn = sqlite3.connect(":memory:", check_same_thread=False)
    # WAL is a file-level feature; set it on the disk file when saving.
    # NORMAL synchronous gives a good speed/safety trade-off.
    _raw_mem_conn.execute("PRAGMA synchronous=NORMAL")

    db_path = Path(DB_PATH)
    if db_path.exists():
        disk_conn = sqlite3.connect(str(db_path))
        disk_conn.backup(_raw_mem_conn)
        disk_conn.close()
        logger.info("Loaded from %s", db_path)
    else:
        logger.info("No existing database found, starting fresh")

    engine = create_engine(
        "sqlite://",
        creator=lambda: _raw_mem_conn,
        poolclass=StaticPool,
    )

    Base.metadata.create_all(bind=engine)
    _run_migrations(_raw_mem_conn)
    SessionLocal = sessionmaker(
        autocommit=False, autoflush=False, bind=engine, class_=_LockedSession,
    )
    logger.info("In-memory database ready")

    _start_snapshot_thread()
    atexit.register(_stop_snapshot_thread)
    atexit.register(save_to_disk)


def save_to_disk():
    global _raw_mem_conn
    if _raw_mem_conn is None:
        return
    # The backup API reads from _raw_mem_conn, so it must serialize
    # against the SQLAlchemy event-listener lock that protects every
    # other statement on the same handle.
    with _STATEMENT_LOCK:
        db_path = Path(DB_PATH)
        db_path.parent.mkdir(parents=True, exist_ok=True)
        disk_conn = sqlite3.connect(str(db_path))
        try:
            disk_conn.execute("PRAGMA journal_mode=WAL")
            _raw_mem_conn.backup(disk_conn)
        finally:
            disk_conn.close()
    logger.info("Saved to %s", db_path)


def _snapshot_loop() -> None:
    """Background loop: snapshot the in-memory DB to disk on a fixed
    cadence. Runs until ``_snapshot_stop`` is set."""
    while not _snapshot_stop.wait(SNAPSHOT_INTERVAL_SEC):
        try:
            save_to_disk()
        except Exception as e:  # noqa: BLE001
            logger.warning("Periodic snapshot failed: %s", e)


def _start_snapshot_thread() -> None:
    global _snapshot_thread
    if _snapshot_thread is not None:
        return
    if SNAPSHOT_INTERVAL_SEC <= 0:
        logger.info("Periodic DB snapshot disabled (DB_SNAPSHOT_INTERVAL_SEC<=0)")
        return
    _snapshot_thread = threading.Thread(
        target=_snapshot_loop,
        name="db-snapshot",
        daemon=True,
    )
    _snapshot_thread.start()
    logger.info("Periodic DB snapshot every %ds", SNAPSHOT_INTERVAL_SEC)


def _stop_snapshot_thread() -> None:
    _snapshot_stop.set()
    if _snapshot_thread is not None and _snapshot_thread.is_alive():
        _snapshot_thread.join(timeout=5)


# ---------------------------------------------------------------------------
# Schema migrations
#
# Each migration is a (version, description, callable) tuple.  On startup we
# compare the stored schema_version against the list and run any that haven't
# been applied yet — in order, inside a transaction.
#
# To add a new migration:
#   1. Write a function that takes a sqlite3.Connection
#   2. Append a tuple to MIGRATIONS with the next version number
#   3. That's it — it runs automatically on next startup
# ---------------------------------------------------------------------------

def _add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, col_type: str):
    """Helper: idempotent ALTER TABLE ADD COLUMN."""
    cur = conn.execute(f"PRAGMA table_info({table})")
    existing = {row[1] for row in cur.fetchall()}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def _m001_dataset_value_range(conn: sqlite3.Connection):
    """Add value_min/value_max columns to datasets table."""
    _add_column_if_missing(conn, "datasets", "value_min", "REAL")
    _add_column_if_missing(conn, "datasets", "value_max", "REAL")


def _m002_perspectives_table(conn: sqlite3.Connection):
    """Create perspectives table for persisting named style snapshots."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS perspectives ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  layer_id INTEGER NOT NULL REFERENCES layers(id),"
        "  name VARCHAR(256) NOT NULL,"
        "  style_json TEXT NOT NULL,"
        "  sort_order INTEGER NOT NULL DEFAULT 0"
        ")"
    )


def _m003_extension_columns(conn: sqlite3.Connection):
    """Add extension_name/extension_ref columns to projects, geometry_files, datasets."""
    _add_column_if_missing(conn, "projects", "extension_name", "VARCHAR(128)")
    _add_column_if_missing(conn, "geometry_files", "extension_name", "VARCHAR(128)")
    _add_column_if_missing(conn, "geometry_files", "extension_ref", "VARCHAR(256)")
    _add_column_if_missing(conn, "datasets", "extension_name", "VARCHAR(128)")
    _add_column_if_missing(conn, "datasets", "extension_ref", "VARCHAR(256)")


def _m004_cross_project_tables(conn: sqlite3.Connection):
    """Create project_tags, project_aliases, and cross_perspectives tables."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS project_tags ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  project_id INTEGER NOT NULL REFERENCES projects(id),"
        "  tag VARCHAR(128) NOT NULL,"
        "  UNIQUE(project_id, tag)"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS project_aliases ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  project_id INTEGER NOT NULL REFERENCES projects(id),"
        "  alias_name VARCHAR(256) NOT NULL,"
        "  target_extension VARCHAR(128) NOT NULL,"
        "  target_project VARCHAR(128) NOT NULL"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS cross_perspectives ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  name VARCHAR(256) NOT NULL,"
        "  description TEXT,"
        "  owner VARCHAR(128) NOT NULL DEFAULT 'admin',"
        "  config_json TEXT NOT NULL"
        ")"
    )


def _m005_rename_perspectives_to_paintings(conn: sqlite3.Connection):
    """Rename perspectives table to paintings (per-layer style snapshots).

    On a fresh DB, Base.metadata.create_all() pre-creates tables from ORM
    classes.  The ORM 'Painting' class creates a 'paintings' table and the
    ORM 'Perspective' class (multi-layer) creates a 'perspectives' table —
    both with the *new* schemas.  Migration 2 already ran as a no-op.

    Strategy: drop anything create_all left, then recreate the paintings
    table with the correct schema (matching the old perspectives layout).
    """
    conn.execute("DROP TABLE IF EXISTS paintings")
    conn.execute("DROP TABLE IF EXISTS perspectives")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS paintings ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  layer_id INTEGER NOT NULL REFERENCES layers(id),"
        "  name VARCHAR(256) NOT NULL,"
        "  style_json TEXT NOT NULL,"
        "  sort_order INTEGER NOT NULL DEFAULT 0"
        ")"
    )


def _m006_rename_cross_perspectives_to_perspectives(conn: sqlite3.Connection):
    """Rename cross_perspectives to perspectives (multi-layer compositions).

    Same issue as m005: create_all may have pre-created 'perspectives' with
    the new schema.  We drop and recreate with the correct schema, adding
    project_id/scenario_id columns.
    """
    conn.execute("DROP TABLE IF EXISTS perspectives")
    # cross_perspectives may not exist on a fresh DB (create_all doesn't
    # create it since the ORM class was renamed). Create it if missing so
    # we can handle both fresh and migrated DBs uniformly.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS perspectives ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  name VARCHAR(256) NOT NULL,"
        "  description TEXT,"
        "  owner VARCHAR(128) NOT NULL DEFAULT 'admin',"
        "  project_id INTEGER REFERENCES projects(id),"
        "  scenario_id INTEGER REFERENCES scenarios(id),"
        "  config_json TEXT NOT NULL"
        ")"
    )
    # If cross_perspectives exists (migrating from old DB), copy data over
    has_cross = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='cross_perspectives'"
    ).fetchone()
    if has_cross:
        conn.execute(
            "INSERT INTO perspectives (id, name, description, owner, config_json) "
            "SELECT id, name, description, owner, config_json FROM cross_perspectives"
        )
        conn.execute("DROP TABLE cross_perspectives")
    _add_column_if_missing(conn, "perspectives", "project_id",
                           "INTEGER REFERENCES projects(id)")
    _add_column_if_missing(conn, "perspectives", "scenario_id",
                           "INTEGER REFERENCES scenarios(id)")


def _m007_scenario_hierarchy(conn: sqlite3.Connection):
    """Add parent_scenario_id for nested scenario trees."""
    _add_column_if_missing(conn, "scenarios", "parent_scenario_id",
                           "INTEGER REFERENCES scenarios(id)")


def _m008_data_tags(conn: sqlite3.Connection):
    """Create data_tags table for auxiliary data tagging."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS data_tags ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  tag VARCHAR(128) NOT NULL,"
        "  target_type VARCHAR(32) NOT NULL,"
        "  target_id INTEGER NOT NULL,"
        "  UNIQUE(tag, target_type, target_id)"
        ")"
    )


def _m009_stories(conn: sqlite3.Connection):
    """Create stories and story_steps tables."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS stories ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  name VARCHAR(256) NOT NULL,"
        "  description TEXT,"
        "  owner VARCHAR(128) NOT NULL DEFAULT 'admin',"
        "  project_id INTEGER REFERENCES projects(id)"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS story_steps ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  story_id INTEGER NOT NULL REFERENCES stories(id),"
        "  perspective_id INTEGER NOT NULL REFERENCES perspectives(id),"
        "  sort_order INTEGER NOT NULL DEFAULT 0,"
        "  transition_type VARCHAR(64) DEFAULT 'fade',"
        "  transition_duration_ms INTEGER DEFAULT 1000,"
        "  narration TEXT,"
        "  auto_advance_ms INTEGER"
        ")"
    )


def _m010_lineage_and_users(conn: sqlite3.Connection):
    """Create lineage tracking tables and stub user table."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS users ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  username VARCHAR(128) UNIQUE NOT NULL,"
        "  display_name VARCHAR(256),"
        "  avatar_url VARCHAR(512),"
        "  role VARCHAR(32) NOT NULL DEFAULT 'admin',"
        "  created_at DATETIME DEFAULT CURRENT_TIMESTAMP"
        ")"
    )
    admin_name = os.environ.get("MERIDIAN_ADMIN_USER", "admin")
    conn.execute(
        "INSERT OR IGNORE INTO users (username, display_name, role) "
        "VALUES (?, ?, 'admin')",
        (admin_name, admin_name),
    )

    conn.execute(
        "CREATE TABLE IF NOT EXISTS lineage_nodes ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  node_type VARCHAR(32) NOT NULL,"
        "  transform_kind VARCHAR(32),"
        "  content_json TEXT NOT NULL DEFAULT '{}',"
        "  content_hash VARCHAR(64),"
        "  creator_type VARCHAR(16) NOT NULL DEFAULT 'system',"
        "  creator_user_id INTEGER REFERENCES users(id),"
        "  ai_model VARCHAR(128),"
        "  ai_conversation_id VARCHAR(128),"
        "  review_status VARCHAR(32) NOT NULL DEFAULT 'unreviewed',"
        "  version INTEGER NOT NULL DEFAULT 1,"
        "  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,"
        "  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,"
        "  project_id INTEGER REFERENCES projects(id),"
        "  scenario_id INTEGER REFERENCES scenarios(id),"
        "  extension_name VARCHAR(128),"
        "  label VARCHAR(256)"
        ")"
    )

    conn.execute(
        "CREATE TABLE IF NOT EXISTS lineage_edges ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  parent_node_id INTEGER NOT NULL REFERENCES lineage_nodes(id),"
        "  child_node_id INTEGER NOT NULL REFERENCES lineage_nodes(id),"
        "  edge_type VARCHAR(32) NOT NULL DEFAULT 'derives_from',"
        "  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,"
        "  UNIQUE(parent_node_id, child_node_id, edge_type)"
        ")"
    )

    conn.execute(
        "CREATE TABLE IF NOT EXISTS perspective_lineage ("
        "  perspective_id INTEGER NOT NULL REFERENCES perspectives(id),"
        "  lineage_node_id INTEGER NOT NULL REFERENCES lineage_nodes(id),"
        "  role VARCHAR(32) NOT NULL DEFAULT 'contributor',"
        "  PRIMARY KEY(perspective_id, lineage_node_id)"
        ")"
    )

    conn.execute(
        "CREATE TABLE IF NOT EXISTS lineage_reviews ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  lineage_node_id INTEGER NOT NULL REFERENCES lineage_nodes(id),"
        "  reviewer_type VARCHAR(16) NOT NULL,"
        "  reviewer_user_id INTEGER REFERENCES users(id),"
        "  ai_model VARCHAR(128),"
        "  status VARCHAR(32) NOT NULL,"
        "  comment TEXT,"
        "  created_at DATETIME DEFAULT CURRENT_TIMESTAMP"
        ")"
    )

    conn.execute(
        "CREATE TABLE IF NOT EXISTS lineage_review_requests ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  lineage_node_id INTEGER NOT NULL REFERENCES lineage_nodes(id),"
        "  requested_by_user_id INTEGER REFERENCES users(id),"
        "  requested_reviewer_type VARCHAR(16) NOT NULL,"
        "  requested_reviewer_user_id INTEGER REFERENCES users(id),"
        "  requested_ai_model VARCHAR(128),"
        "  message TEXT,"
        "  status VARCHAR(16) NOT NULL DEFAULT 'pending',"
        "  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,"
        "  completed_at DATETIME,"
        "  completed_review_id INTEGER REFERENCES lineage_reviews(id)"
        ")"
    )

    # Indexes for common queries
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ln_type ON lineage_nodes(node_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ln_ext ON lineage_nodes(extension_name)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_le_parent ON lineage_edges(parent_node_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_le_child ON lineage_edges(child_node_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_pl_persp ON perspective_lineage(perspective_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lr_node ON lineage_reviews(lineage_node_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lrr_node ON lineage_review_requests(lineage_node_id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_lrr_status ON lineage_review_requests(status)")


def _m011_category_maps(conn: sqlite3.Connection):
    """Create category_maps and scenario_category_maps tables, extend layer_style_mappings."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS category_maps ("
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  name VARCHAR(128) NOT NULL,"
        "  display_name VARCHAR(256),"
        "  description TEXT,"
        "  entity_column VARCHAR(128) NOT NULL,"
        "  category_column VARCHAR(128) NOT NULL,"
        "  content_hash VARCHAR(128),"
        "  colors_json TEXT,"
        "  extension_name VARCHAR(128),"
        "  extension_ref VARCHAR(256)"
        ")"
    )
    conn.execute(
        "CREATE TABLE IF NOT EXISTS scenario_category_maps ("
        "  scenario_id INTEGER NOT NULL REFERENCES scenarios(id),"
        "  category_map_id INTEGER NOT NULL REFERENCES category_maps(id),"
        "  PRIMARY KEY(scenario_id, category_map_id)"
        ")"
    )
    _add_column_if_missing(conn, "layer_style_mappings", "category_map_id",
                           "INTEGER REFERENCES category_maps(id)")
    _add_column_if_missing(conn, "layer_style_mappings", "aggregation_mode",
                           "VARCHAR(32)")


def _m012_layer_default_style(conn: sqlite3.Connection):
    """Add default_style_json to layers for extension-provided initial styles."""
    _add_column_if_missing(conn, "layers", "default_style_json", "TEXT")


def _m013_dataset_geometry_scope(conn: sqlite3.Connection):
    """Add scope column to datasets and geometry_files for global/extension/scenario visibility."""
    _add_column_if_missing(conn, "datasets", "scope", "VARCHAR(32) DEFAULT 'scenario'")
    _add_column_if_missing(conn, "geometry_files", "scope", "VARCHAR(32) DEFAULT 'scenario'")
    # Backfill: extension-provided records get scope='extension'
    conn.execute("UPDATE datasets SET scope = 'extension' WHERE extension_name IS NOT NULL AND scope = 'scenario'")
    conn.execute("UPDATE geometry_files SET scope = 'extension' WHERE extension_name IS NOT NULL AND scope = 'scenario'")


def _m014_join_hints_and_layer_source(conn: sqlite3.Connection):
    """Create join_hints table for auto-discovered dataset-geometry compatibility.
    Also add source_type/source_extension to layers."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS join_hints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dataset_id INTEGER NOT NULL REFERENCES datasets(id),
            geometry_id INTEGER NOT NULL REFERENCES geometry_files(id),
            dataset_column VARCHAR(128) NOT NULL,
            geometry_key VARCHAR(128) NOT NULL,
            overlap REAL NOT NULL,
            sample_size INTEGER NOT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'suggested',
            UNIQUE(dataset_id, geometry_id, dataset_column, geometry_key)
        )
    """)
    _add_column_if_missing(conn, "layers", "source_type", "VARCHAR(32)")
    _add_column_if_missing(conn, "layers", "source_extension", "VARCHAR(128)")


def _m015_user_extension_prefs(conn: sqlite3.Connection):
    """Create user_extension_prefs table for per-user extension enable/disable/hide."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_extension_prefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            extension_name VARCHAR(128) NOT NULL,
            state VARCHAR(32) NOT NULL DEFAULT 'enabled',
            UNIQUE(user_id, extension_name)
        )
    """)


def _m016_metadata_descriptions(conn: sqlite3.Connection):
    """Create table_descriptions and column_descriptions for AI-discoverable metadata."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS table_descriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name VARCHAR(256) NOT NULL UNIQUE,
            description TEXT,
            source VARCHAR(32) NOT NULL DEFAULT 'extension',
            extension_name VARCHAR(128),
            created_at VARCHAR(64),
            updated_at VARCHAR(64)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS column_descriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_description_id INTEGER NOT NULL REFERENCES table_descriptions(id),
            column_name VARCHAR(256) NOT NULL,
            description TEXT,
            data_type VARCHAR(64),
            is_joinable INTEGER DEFAULT 0,
            join_target_table VARCHAR(256),
            join_target_column VARCHAR(256),
            source VARCHAR(32) NOT NULL DEFAULT 'extension',
            created_at VARCHAR(64),
            updated_at VARCHAR(64),
            UNIQUE(table_description_id, column_name)
        )
    """)


def _m017_ai_memory(conn: sqlite3.Connection):
    """Create ai_memories table for reusable AI knowledge (charts, queries, insights)."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ai_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            memory_type VARCHAR(32) NOT NULL,
            name VARCHAR(256) NOT NULL,
            description TEXT,
            content_json TEXT NOT NULL DEFAULT '{}',
            tags TEXT,
            lineage_node_id INTEGER REFERENCES lineage_nodes(id),
            project_id INTEGER REFERENCES projects(id),
            scenario_id INTEGER REFERENCES scenarios(id),
            extension_name VARCHAR(128),
            creator_type VARCHAR(16) NOT NULL DEFAULT 'ai',
            created_at VARCHAR(64),
            updated_at VARCHAR(64)
        )
    """)


# (version, description, function)
# Version numbers must be sequential starting from 1.
def _m018_dataset_time_metadata(conn):
    """Cache time-range metadata on datasets so the animation timeline loads instantly."""
    for col, col_type in [
        ("time_meta_json", "TEXT"),  # JSON: {dates, row_counts, entity_columns, start, end, total_rows, resolution_seconds}
    ]:
        try:
            conn.execute(f"ALTER TABLE datasets ADD COLUMN {col} {col_type}")
        except Exception:
            pass  # column already exists


def _m019_layer_dataset_role(conn):
    """Add role column to layer_datasets for multi-dataset layers."""
    _add_column_if_missing(conn, "layer_datasets", "role", "VARCHAR(64)")


def _m020_shared_legend_group(conn):
    """Add shared_legend_group to layer_style_mappings — opt-in group key for
    rendering mappings (across layers / extensions) under one unified legend."""
    _add_column_if_missing(
        conn, "layer_style_mappings", "shared_legend_group", "VARCHAR(128)"
    )


def _m021_description_confidence(conn):
    """Add AI-confidence / needs-review fields to table_descriptions so an
    auto-generated description can flag when it's unsure and stash a question
    to ask the user. Cleared once a user-sourced description is provided."""
    _add_column_if_missing(conn, "table_descriptions", "confidence", "VARCHAR(16)")
    _add_column_if_missing(conn, "table_descriptions", "needs_review", "INTEGER DEFAULT 0")
    _add_column_if_missing(conn, "table_descriptions", "review_question", "TEXT")


def _m022_user_preferences(conn):
    """Create user_preferences: generic per-user key→JSON store (style defaults,
    etc.). Mirrors the user_extension_prefs pattern."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS user_preferences (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            key VARCHAR(64) NOT NULL,
            value_json TEXT NOT NULL DEFAULT '{}',
            updated_at VARCHAR(64),
            UNIQUE(user_id, key)
        )
    """)


def _m023_story_step_suggested_prompts(conn):
    """Add suggested_prompts (JSON array of strings) to story_steps so a story
    step can carry tap-to-send chat prompts for the Atlas assistant."""
    _add_column_if_missing(conn, "story_steps", "suggested_prompts", "TEXT")


def _m024_geometry_spatial(conn):
    """Add spatial-serving columns to geometry_files so large line/polygon
    datasets can be ingested into a DuckDB spatial table and served per-viewport
    (bbox + zoom) instead of as one whole-GeoJSON blob. See lib/geometry_spatial.py.
      - is_spatial:    1 when this geometry is backed by a DuckDB spatial table
      - spatial_table: the DuckDB table name (geom_<id>)
      - bbox_json:     [w,s,e,n] full-dataset extent in EPSG:4326
      - feature_count: number of features (for UI + cap warnings)
      - category_col:  default categorical column for zoom gating (e.g. voltage)
    """
    _add_column_if_missing(conn, "geometry_files", "is_spatial", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "geometry_files", "spatial_table", "VARCHAR(128)")
    _add_column_if_missing(conn, "geometry_files", "bbox_json", "TEXT")
    _add_column_if_missing(conn, "geometry_files", "feature_count", "INTEGER")
    _add_column_if_missing(conn, "geometry_files", "category_col", "VARCHAR(128)")


def _m025_painting_is_default(conn):
    """Add is_default to paintings so a layer can auto-load a chosen painting
    on reload (and the user can pick which one when there are several)."""
    _add_column_if_missing(conn, "paintings", "is_default", "INTEGER NOT NULL DEFAULT 0")


def _m026_story_guiding_prompt(conn):
    """Add guiding_prompt to stories — a free-text brief injected into the AI
    assistant's context when the story is active, so the agent picks up the
    story's intent, audience, and narrative before answering."""
    _add_column_if_missing(conn, "stories", "guiding_prompt", "TEXT")


MIGRATIONS = [
    (1, "Add dataset value_min/value_max columns", _m001_dataset_value_range),
    (2, "Create perspectives table", _m002_perspectives_table),
    (3, "Add extension columns to projects, geometries, datasets", _m003_extension_columns),
    (4, "Create cross-project mapping tables", _m004_cross_project_tables),
    (5, "Rename perspectives to paintings", _m005_rename_perspectives_to_paintings),
    (6, "Rename cross_perspectives to perspectives", _m006_rename_cross_perspectives_to_perspectives),
    (7, "Add scenario hierarchy", _m007_scenario_hierarchy),
    (8, "Create data_tags table", _m008_data_tags),
    (9, "Create stories and story_steps tables", _m009_stories),
    (10, "Create lineage tables and user stub", _m010_lineage_and_users),
    (11, "Create category_maps tables and extend style mappings", _m011_category_maps),
    (12, "Add default_style_json to layers", _m012_layer_default_style),
    (13, "Add scope to datasets and geometry_files", _m013_dataset_geometry_scope),
    (14, "Create join_hints table and add layer source columns", _m014_join_hints_and_layer_source),
    (15, "Create user_extension_prefs table", _m015_user_extension_prefs),
    (16, "Create table and column description tables", _m016_metadata_descriptions),
    (17, "Create AI memory table", _m017_ai_memory),
    (18, "Cache time metadata on datasets", _m018_dataset_time_metadata),
    (19, "Add role column to layer_datasets", _m019_layer_dataset_role),
    (20, "Add shared_legend_group to layer_style_mappings", _m020_shared_legend_group),
    (21, "Add confidence/needs_review to table_descriptions", _m021_description_confidence),
    (22, "Create user_preferences table", _m022_user_preferences),
    (23, "Add suggested_prompts to story_steps", _m023_story_step_suggested_prompts),
    (24, "Add spatial-serving columns to geometry_files", _m024_geometry_spatial),
    (25, "Add is_default to paintings", _m025_painting_is_default),
    (26, "Add guiding_prompt to stories", _m026_story_guiding_prompt),
]


def _get_schema_version(conn: sqlite3.Connection) -> int:
    """Return current schema version, creating the tracking table if needed."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _schema_version ("
        "  id INTEGER PRIMARY KEY CHECK (id = 1),"
        "  version INTEGER NOT NULL DEFAULT 0"
        ")"
    )
    row = conn.execute("SELECT version FROM _schema_version WHERE id = 1").fetchone()
    if row is None:
        conn.execute("INSERT INTO _schema_version (id, version) VALUES (1, 0)")
        return 0
    return row[0]


def _set_schema_version(conn: sqlite3.Connection, version: int):
    conn.execute("UPDATE _schema_version SET version = ? WHERE id = 1", (version,))


def _run_migrations(conn: sqlite3.Connection):
    """Run any unapplied migrations in order."""
    current = _get_schema_version(conn)

    pending = [(v, desc, fn) for v, desc, fn in MIGRATIONS if v > current]
    if not pending:
        return

    for version, desc, fn in pending:
        fn(conn)
        _set_schema_version(conn, version)
        logger.info("Migration %d: %s", version, desc)

    conn.commit()
    logger.info("Schema upgraded to version %d", pending[-1][0])


def get_session():
    return SessionLocal()


async def get_db_session():
    """FastAPI dependency: yields a session and closes it on exit.

    Replaces ``s = db.get_session(); try ... finally s.close()`` at
    every endpoint. The dependency must be ``async`` so that for our
    fully-async handler set FastAPI runs both the dep and the handler
    on the event loop thread — the ``_LockedSession`` RLock is then
    re-entrant for any nested acquires (e.g. ``save_to_disk``) inside
    the handler. A sync dep would run in a worker thread and acquire
    the lock there, deadlocking when the handler (on a different
    thread) tries to re-enter.

    All FastAPI handlers are ``async def`` to satisfy this — see the
    history of this file for the failed attempt with mixed handler
    types."""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()
