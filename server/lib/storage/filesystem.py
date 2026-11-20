# lib/storage/filesystem.py
# Local filesystem implementation of BaseStorageHandler.
#
# Directory layout on disk:
#
#   {data_dir}/
#     {project}/
#       {scenario}/
#         timeseries/
#           generators.parquet
#           flow.parquet
#           ...
#         geo/
#           network.geojson
#           ...
#         {any_other_layer}/
#           ...
#
# The DATA_DIR environment variable (default: "./data") controls the root.

import hashlib
import json
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import List

import pandas as pd
import polars as pl

from .base import BaseStorageHandler

logger = logging.getLogger("meridian.storage")


class FileSystemHandler(BaseStorageHandler):
    """
    Stores and retrieves Meridian data from the local filesystem.

    Parameters
    ----------
    data_dir : str | Path
        Root directory where all project/scenario data lives.
        Defaults to the ``DATA_DIR`` environment variable, falling back
        to ``./data`` relative to the current working directory.
    """

    def __init__(self, data_dir: str | None = None) -> None:
        if data_dir is None:
            data_dir = os.environ.get("DATA_DIR", "./data")
        self.root = Path(data_dir)
        self.root.mkdir(parents=True, exist_ok=True)
        logger.info("[FileSystemHandler] data root: %s", self.root.resolve())
        logger.debug("[FileSystemHandler] projects: %s", self.list_projects())

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _scenario_path(self, project: str, scenario: str) -> Path:
        return self.root / project / scenario

    def _timeseries_path(self, project: str, scenario: str, file_name: str) -> Path:
        return self._scenario_path(project, scenario) / "timeseries" / file_name

    def _geo_path(self, project: str, scenario: str, file_name: str) -> Path:
        return self._scenario_path(project, scenario) / "geo" / file_name

    def _layer_path(
        self, project: str, scenario: str, layer: str, file_name: str
    ) -> Path:
        return self._scenario_path(project, scenario) / layer / file_name

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    def list_projects(self) -> List[str]:
        """Return the names of all top-level project directories."""
        if not self.root.exists():
            return []
        return sorted(p.name for p in self.root.iterdir() if p.is_dir())

    def list_scenarios(self, project: str) -> List[str]:
        """Return the names of all scenario directories within *project*."""
        project_path = self.root / project
        if not project_path.exists():
            return []
        return sorted(s.name for s in project_path.iterdir() if s.is_dir())

    def get_scenario_config(self, project: str, scenario: str) -> dict:
        """
        Return a dict with a ``layers`` key listing every file path
        found under the scenario directory (recursive).
        """
        base = self._scenario_path(project, scenario)
        if not base.exists():
            return {"layers": []}
        layers = [str(p) for p in base.rglob("*") if p.is_file()]
        return {"layers": sorted(layers)}

    # ------------------------------------------------------------------
    # Timeseries helpers
    # ------------------------------------------------------------------

    def get_scenario_timestamps(
        self, project: str, scenario: str, file_name: str
    ) -> list:
        """Read *file_name* from the timeseries layer and return DateTime values."""
        path = self._timeseries_path(project, scenario, file_name)
        df = pd.read_parquet(path).reset_index()
        return df["DateTime"].tolist()

    @lru_cache(maxsize=10)
    def get_dataframe(
        self, project: str, scenario: str, file_name: str
    ) -> pl.DataFrame:
        """
        Read *file_name* from the timeseries layer and return a Polars DataFrame.
        DateTime column is cast to Utf8 for JSON serialisation compatibility.
        Results are LRU-cached (up to 10 entries).
        """
        path = self._timeseries_path(project, scenario, file_name)
        df_pandas = pd.read_parquet(path).reset_index()
        df_polars = pl.from_pandas(df_pandas)
        if "DateTime" in df_polars.columns:
            df_polars = df_polars.with_columns([pl.col("DateTime").cast(pl.Utf8)])
        return df_polars

    @lru_cache(maxsize=10)
    def get_pickle(self, project: str, scenario: str, file_name: str) -> pd.DataFrame:
        """
        Read a gzip-compressed pickle from the timeseries layer.
        Results are LRU-cached (up to 10 entries).
        """
        path = self._timeseries_path(project, scenario, file_name)
        return pd.read_pickle(path, compression="gzip")

    # ------------------------------------------------------------------
    # Geo files
    # ------------------------------------------------------------------

    def get_geofile(self, project: str, scenario: str, file_name: str) -> dict:
        """Parse and return a GeoJSON file from the geo layer."""
        path = self._geo_path(project, scenario, file_name)
        try:
            with path.open("rb") as fh:
                return json.loads(fh.read())
        except Exception as exc:
            logger.warning("[FileSystemHandler] get_geofile error: %s", exc)
            return {}

    # ------------------------------------------------------------------
    # Uploads
    # ------------------------------------------------------------------

    def post_file(
        self,
        project: str,
        scenario: str,
        layer: str,
        file_name: str,
        data: bytes,
    ) -> None:
        """
        Write *data* bytes to
        ``{data_dir}/{project}/{scenario}/{layer}/{file_name}``,
        creating any missing parent directories automatically.
        """
        dest = self._layer_path(project, scenario, layer, file_name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as fh:
            fh.write(data)

    # ------------------------------------------------------------------
    # Generic file uploads (not scenario-scoped)
    # ------------------------------------------------------------------

    def upload_file(self, file_type: str, sha256_hex: str, data: bytes) -> str:
        """
        Persist *data* at ``{data_dir}/uploads/{file_type}/{sha256_hex}/raw``.

        The hash directory (not the raw file itself) is used as content_hash so
        that partition files can live alongside the raw data under the same
        directory without a path conflict.

        *sha256_hex* is pre-computed by the caller while streaming the
        upload so no second pass over the data is needed.  If the file
        already exists the write is skipped (deduplication).
        """
        content_hash = str(Path("uploads") / file_type / sha256_hex)
        dest = self.root / content_hash / "raw"
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            with dest.open("wb") as fh:
                fh.write(data)
            logger.debug("[FileSystemHandler] stored %s: %s… (%s bytes)", file_type, sha256_hex[:12], f"{len(data):,}")
        else:
            logger.debug("[FileSystemHandler] dedup hit %s: %s…", file_type, sha256_hex[:12])
        return content_hash

    def read_file_bytes(self, content_hash: str) -> bytes:
        """Read and return raw bytes for a file identified by its content_hash."""
        path = self.root / content_hash / "raw"
        with path.open("rb") as fh:
            return fh.read()

    def get_dataset_columns(self, file_id: str) -> List[str]:
        """Return column names for a CSV or Parquet dataset."""
        path = self.root / file_id
        suffix = path.suffix.lower()
        if suffix == ".parquet":
            return pl.read_parquet(path, n_rows=0).columns
        if suffix in (".csv", ".tsv"):
            return pl.read_csv(path, n_rows=0).columns
        return []

    # ------------------------------------------------------------------
    # Date-partitioned timeseries storage
    # ------------------------------------------------------------------

    def write_partition(self, base_dir: str, date_str: str, parquet_bytes: bytes) -> None:
        """Write a parquet file to {data_dir}/{base_dir}/partitions/{date_str}.parquet."""
        dest = self.root / base_dir / "partitions" / f"{date_str}.parquet"
        dest.parent.mkdir(parents=True, exist_ok=True)
        with dest.open("wb") as fh:
            fh.write(parquet_bytes)

    def read_partition(self, base_dir: str, date_str: str) -> bytes:
        """Return raw parquet bytes for a date partition."""
        path = self.root / base_dir / "partitions" / f"{date_str}.parquet"
        with path.open("rb") as fh:
            return fh.read()

    def list_partitions(self, base_dir: str) -> List[str]:
        """Return sorted list of date strings with stored partitions."""
        parts_dir = self.root / base_dir / "partitions"
        if not parts_dir.exists():
            return []
        return sorted(p.stem for p in parts_dir.glob("*.parquet"))
