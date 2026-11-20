"""
DuckDB engine — wraps an in-memory DuckDB connection for analytical queries.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Any

import duckdb

if TYPE_CHECKING:
    from gridsight.extensions import DuckDBTableInfo, GridSightExtensionBase

logger = logging.getLogger(__name__)


class DuckDBEngine:
    """Manages a shared in-memory DuckDB connection.

    A single DuckDB connection cannot run multiple queries concurrently —
    doing so raises "Attempting to execute an unsuccessful or closed
    pending query result". FastAPI runs sync endpoints in a threadpool, so
    racing chart-data requests hit this. Serialize with a lock.
    """

    def __init__(self, lock: threading.RLock | None = None) -> None:
        self.conn = duckdb.connect(":memory:")
        # RLock, shared with extensions via ExtensionContext.duckdb_lock so
        # the engine and every extension use the SAME lock on the SAME
        # connection. Reentrant so an extension method that already holds
        # the lock can call a helper that takes it again.
        #
        # Pass in ``db._STATEMENT_LOCK`` from the server so SQLite and
        # DuckDB serialize on the SAME process-wide lock. That's what
        # prevents the cross-thread deadlock where Thread A holds the
        # SQLite lock and wants the DuckDB lock while Thread B holds
        # them in the opposite order. With one lock there's no order to
        # invert.
        self.lock = lock if lock is not None else threading.RLock()
        self._table_catalog: list[DuckDBTableInfo] = []

    def register_extension(self, name: str, ext: GridSightExtensionBase) -> None:
        """Create a schema for the extension and let it register tables."""
        safe_name = name.replace("-", "_")
        schema = f"ext_{safe_name}"
        self.conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
        try:
            with self.lock:
                tables = ext.register_duckdb_tables(self.conn)
            # Replace this extension's catalog entries instead of appending
            # so refreshes after upload/delete don't accumulate duplicates.
            self._table_catalog = [t for t in self._table_catalog if t.extension_name != name]
            self._table_catalog.extend(tables)
            logger.info(
                "Extension %s registered %d DuckDB table(s)", name, len(tables)
            )
        except Exception:
            logger.exception("Failed to register DuckDB tables for %s", name)

    def refresh_extension(self, name: str, ext: GridSightExtensionBase) -> None:
        """Re-run an extension's table registration after data changes.

        Called after a scenario upload or delete so any new schema is
        exposed (or stale views replaced) without restarting the server.
        Same lock + dedupe behavior as register_extension.
        """
        self.register_extension(name, ext)

    def register_parquet(self, schema: str, table: str, path: str) -> None:
        """Register a Parquet file as a DuckDB view."""
        self.conn.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        self.conn.execute(
            f"CREATE OR REPLACE VIEW {schema}.{table} "
            f"AS SELECT * FROM read_parquet('{path}')"
        )

    @staticmethod
    def _safe_identifier(name: str) -> str:
        """Sanitize an arbitrary dataset name into a SQL-safe table identifier."""
        import re

        ident = re.sub(r"\W+", "_", (name or "").strip().lower()).strip("_")
        if not ident:
            ident = "dataset"
        if ident[0].isdigit():
            ident = f"t_{ident}"
        return ident

    def register_user_dataset(
        self,
        table: str,
        data: bytes,
        fmt: str = "parquet",
        description: str = "",
        schema: str = "user",
    ) -> DuckDBTableInfo:
        """Register an uploaded dataset (parquet/csv bytes) as a queryable table.

        Unlike ``register_parquet`` (path-based, view over a file), this reads
        from in-memory bytes and materializes a real DuckDB table, so it works
        regardless of storage backend (filesystem or S3) and survives the
        source bytes being released. Adds a catalog entry so the table shows up
        in ``describe_data()`` and is queryable like any extension table.

        Returns the DuckDBTableInfo (its ``table_name`` is the fully-qualified
        ``schema.table`` the caller should use in SQL).
        """
        import os
        import tempfile

        from gridsight.extensions import DuckDBTableInfo

        safe_table = self._safe_identifier(table)
        suffix = ".csv" if fmt == "csv" else ".parquet"

        # Write to a temp file and use DuckDB's native readers. DuckDB's CSV
        # sniffer is far more tolerant of messy real-world files (mixed types,
        # quoted commas) than pyarrow's, and this path is identical whether the
        # bytes came from the filesystem or S3.
        tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
        try:
            tmp.write(data)
            tmp.close()
            tmp_path = tmp.name.replace("'", "''")
            if fmt == "csv":
                reader = f"read_csv_auto('{tmp_path}', sample_size=-1, ignore_errors=true)"
            else:
                reader = f"read_parquet('{tmp_path}')"
            with self.lock:
                self.conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
                self.conn.execute(
                    f'CREATE OR REPLACE TABLE "{schema}"."{safe_table}" '
                    f"AS SELECT * FROM {reader}"
                )
                describe = self.conn.execute(
                    f'DESCRIBE "{schema}"."{safe_table}"'
                ).fetchall()
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

        # DESCRIBE rows: (column_name, column_type, null, key, default, extra)
        columns = [
            {"name": row[0], "type": str(row[1]), "description": ""}
            for row in describe
        ]
        info = DuckDBTableInfo(
            table_name=f"{schema}.{safe_table}",
            description=description or f"User-uploaded dataset '{table}'.",
            columns=columns,
            extension_name=schema,
        )
        # Dedupe by fully-qualified table name (re-upload replaces in place).
        self._table_catalog = [
            t for t in self._table_catalog if t.table_name != info.table_name
        ]
        self._table_catalog.append(info)
        logger.info("Registered user dataset %s (%d cols)", info.table_name, len(columns))
        return info

    def unregister_user_dataset(self, table: str, schema: str = "user") -> str:
        """Drop a user-registered dataset table and forget its catalog entry.

        Inverse of ``register_user_dataset``: DROPs the materialized table and
        removes the matching ``_table_catalog`` entry so the table stops
        appearing in ``describe_data()``. ``table`` is the original dataset
        name (the same value passed to ``register_user_dataset``); it is run
        through the same identifier sanitizer to locate the table.

        Returns the fully-qualified ``schema.table`` name that was removed (a
        no-op DROP IF EXISTS is harmless if the table was never registered).
        """
        safe_table = self._safe_identifier(table)
        qualified = f"{schema}.{safe_table}"
        with self.lock:
            self.conn.execute(f'DROP TABLE IF EXISTS "{schema}"."{safe_table}"')
        self._table_catalog = [
            t for t in self._table_catalog if t.table_name != qualified
        ]
        logger.info("Unregistered user dataset %s", qualified)
        return qualified

    def query(self, sql: str, params: list | None = None) -> Any:
        """Execute a read-only SQL query and return an Arrow table."""
        with self.lock:
            rel = self.conn.execute(sql, params or [])
            return rel.fetch_arrow_table()

    def query_json(self, sql: str, params: list | None = None) -> list[dict]:
        """Execute SQL and return results as a list of dicts."""
        with self.lock:
            rel = self.conn.execute(sql, params or [])
            columns = [desc[0] for desc in rel.description]
            return [dict(zip(columns, row)) for row in rel.fetchall()]

    def get_table_catalog(self) -> list[DuckDBTableInfo]:
        return list(self._table_catalog)

    def get_tables_for_extension(self, extension_name: str) -> list[DuckDBTableInfo]:
        """Return table catalog entries registered by a specific extension."""
        return [t for t in self._table_catalog if t.extension_name == extension_name]

    def close(self) -> None:
        self.conn.close()
