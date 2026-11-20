"""Concurrency tests for the in-memory SQLite + StaticPool setup.

The shared connection pattern in db.py forces every SQLAlchemy session
onto a single sqlite3.Connection. pysqlite serializes statements per
connection, but only when the caller cooperates — without the
event-listener lock added in db.py, two threadpool workers running the
same query simultaneously produce ``sqlite3.InterfaceError: bad
parameter or other API misuse``. These tests are the regression bar.
"""
from __future__ import annotations

import os
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import pytest

import db as _db_module
from models.orm import Project


# ── Statement-level concurrency ────────────────────────────────────────


def _spam_query(barrier: threading.Barrier, errors: list, results: list) -> None:
    barrier.wait()  # All workers fire as close to simultaneously as possible.
    s = _db_module.get_session()
    try:
        for _ in range(20):
            row = s.execute(
                __import__("sqlalchemy").text("SELECT COUNT(*) FROM projects")
            ).first()
            results.append(row[0])
    except Exception as e:  # noqa: BLE001
        errors.append(e)
    finally:
        s.close()


def test_concurrent_reads_no_interface_error():
    """16 threadpool workers hammering SELECT in lockstep. Pre-fix this
    raised ``sqlite3.InterfaceError: bad parameter or other API misuse``
    within a few hundred iterations."""
    n_threads = 16
    barrier = threading.Barrier(n_threads)
    errors: list[Exception] = []
    results: list[int] = []

    with ThreadPoolExecutor(max_workers=n_threads) as ex:
        futures = [
            ex.submit(_spam_query, barrier, errors, results)
            for _ in range(n_threads)
        ]
        for f in as_completed(futures):
            f.result()

    assert errors == [], f"Concurrent reads raised: {errors[:3]}"
    assert len(results) == n_threads * 20


def test_concurrent_mixed_read_write():
    """Writers insert Project rows while readers count them. The lock
    must serialize cursor execution so neither side sees a half-bound
    statement, and final row count must equal total inserts."""
    n_writers = 4
    n_readers = 8
    inserts_per_writer = 25
    reads_per_reader = 30

    errors: list[Exception] = []

    def writer(idx: int) -> None:
        s = _db_module.get_session()
        try:
            for i in range(inserts_per_writer):
                s.add(Project(name=f"proj-{idx}-{i}", owner="t", public=1))
                s.commit()
        except Exception as e:  # noqa: BLE001
            errors.append(e)
        finally:
            s.close()

    def reader() -> None:
        s = _db_module.get_session()
        try:
            for _ in range(reads_per_reader):
                s.query(Project).count()
        except Exception as e:  # noqa: BLE001
            errors.append(e)
        finally:
            s.close()

    with ThreadPoolExecutor(max_workers=n_writers + n_readers) as ex:
        futures = [ex.submit(writer, i) for i in range(n_writers)]
        futures += [ex.submit(reader) for _ in range(n_readers)]
        for f in as_completed(futures):
            f.result()

    assert errors == [], f"Mixed reads/writes raised: {errors[:3]}"

    # Confirm all writes landed.
    s = _db_module.get_session()
    try:
        n = s.query(Project).filter(Project.name.like("proj-%")).count()
        assert n == n_writers * inserts_per_writer
    finally:
        s.close()


def test_lock_released_after_statement_error():
    """A failing statement inside a session must still release the lock
    when the session is closed — otherwise the very next request
    deadlocks. ``_LockedSession.close`` releases unconditionally."""
    s = _db_module.get_session()
    try:
        with pytest.raises(Exception):  # noqa: PT011
            s.execute(__import__("sqlalchemy").text("SELECT * FROM no_such_table"))
    finally:
        s.close()
    # If the lock leaked, this would block forever. Timeout surfaces the
    # failure as a clean assertion rather than a hung suite.
    acquired = _db_module._STATEMENT_LOCK.acquire(timeout=2.0)
    assert acquired, "lock leaked after a failed statement"
    _db_module._STATEMENT_LOCK.release()


def test_session_close_releases_lock_idempotently():
    """Defensive: a double-close must not over-release the RLock."""
    s = _db_module.get_session()
    s.close()
    s.close()  # idempotent — no RuntimeError from extra release
    # Lock should be available.
    assert _db_module._STATEMENT_LOCK.acquire(timeout=1.0)
    _db_module._STATEMENT_LOCK.release()


# ── Periodic snapshot ──────────────────────────────────────────────────


def test_save_to_disk_runs_under_lock(tmp_path):
    """``save_to_disk`` reads the in-memory connection — it must hold
    the same lock that protects every other statement, otherwise the
    backup races against an active query."""
    import sqlite3

    target = tmp_path / "snap.db"
    original = _db_module.DB_PATH
    _db_module.DB_PATH = target
    try:
        _db_module.save_to_disk()
        assert target.exists()
        # Verify the snapshot is a readable sqlite database.
        c = sqlite3.connect(str(target))
        try:
            tables = c.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        finally:
            c.close()
        assert any("projects" in t[0] for t in tables)
    finally:
        _db_module.DB_PATH = original


def test_snapshot_thread_started():
    """init_db should have started the periodic snapshot daemon."""
    assert _db_module._snapshot_thread is not None
    assert _db_module._snapshot_thread.is_alive()
    assert _db_module._snapshot_thread.daemon is True


# ── Lock unification (deadlock prevention) ────────────────────────────


def test_duckdb_engine_shares_db_statement_lock(client):
    """The DuckDB engine MUST share ``db._STATEMENT_LOCK`` so SQLite
    and DuckDB can never deadlock against each other.

    Pre-fix, two separate RLocks meant a background ingest thread that
    held the SQLite lock and wanted DuckDB would deadlock against an
    API request thread that held DuckDB and wanted SQLite. Symptom:
    uploads sat at 100% indefinitely without entering ingest. Single
    shared RLock = one acquisition order = no deadlock possible.

    The ``client`` fixture ensures lifespan ran and ``app.state`` is
    populated."""
    import app

    engine = app.app.state.duckdb_engine
    assert engine.lock is _db_module._STATEMENT_LOCK, (
        "DuckDBEngine must share db._STATEMENT_LOCK — separate locks "
        "create a cross-thread deadlock between SQLite session work "
        "and DuckDB queries."
    )
