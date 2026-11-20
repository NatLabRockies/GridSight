# lib/storage/s3.py
# S3 / MinIO implementation of BaseStorageHandler.
#
# Requires the `s3fs` package. Install via:
#   pip install s3fs
#
# Environment variables used when instantiated via the factory:
#   ACCESS_KEY       - S3 access key / MinIO root user
#   SECRET_KEY       - S3 secret key / MinIO root password
#   ENDPOINT_URL     - Custom endpoint (e.g. http://minio:9000). Leave unset
#                      for real AWS S3.
#   BUCKET_NAME      - Top-level bucket that acts as the storage root.
#
# Directory layout inside the bucket (mirrors the filesystem backend):
#
#   {bucket}/
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

import hashlib
import json
import logging
from functools import lru_cache
from typing import List

import pandas as pd
import polars as pl

from .base import BaseStorageHandler

logger = logging.getLogger("meridian.storage")


class S3Handler(BaseStorageHandler):
    """
    Stores and retrieves Meridian data from an S3-compatible object store
    (AWS S3, MinIO, etc.).

    Parameters
    ----------
    key : str
        S3 access key ID.
    secret : str
        S3 secret access key.
    endpoint_url : str | None
        Custom endpoint URL for S3-compatible stores (e.g. MinIO).
        Pass ``None`` or omit for standard AWS S3.
    bucket_name : str
        The bucket that acts as the root of all Meridian data.
    """

    def __init__(
        self,
        key: str,
        secret: str,
        endpoint_url: str | None,
        bucket_name: str,
    ) -> None:
        try:
            import s3fs  # lazy import — only required for this backend
        except ImportError as exc:
            raise ImportError(
                "The 's3fs' package is required for the S3 storage backend. "
                "Install it with:  pip install s3fs"
            ) from exc

        self.bucket_name = bucket_name

        fs_kwargs: dict = {"key": key, "secret": secret}
        storage_option_kwargs: dict = {
            "key": key,
            "secret": secret,
            "client_kwargs": {},
        }

        if endpoint_url:
            fs_kwargs["endpoint_url"] = endpoint_url
            storage_option_kwargs["client_kwargs"]["endpoint_url"] = endpoint_url

        self.s3 = s3fs.S3FileSystem(**fs_kwargs)
        self.storage_options = storage_option_kwargs

        logger.info("[S3Handler] bucket: %s", self.bucket_name)
        logger.info("[S3Handler] endpoint: %s", endpoint_url or "AWS S3 (default)")
        logger.debug("[S3Handler] projects: %s", self.list_projects())

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ts_path(self, project: str, scenario: str, file_name: str) -> str:
        return f"{self.bucket_name}/{project}/{scenario}/timeseries/{file_name}"

    def _geo_path(self, project: str, scenario: str, file_name: str) -> str:
        return f"{self.bucket_name}/{project}/{scenario}/geo/{file_name}"

    def _layer_path(
        self, project: str, scenario: str, layer: str, file_name: str
    ) -> str:
        return f"{self.bucket_name}/{project}/{scenario}/{layer}/{file_name}"

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    def list_projects(self) -> List[str]:
        """Return the names of all top-level 'directories' in the bucket."""
        try:
            entries = self.s3.ls(self.bucket_name)
            return [e.split("/")[-1] for e in entries]
        except Exception as exc:
            logger.warning("[S3Handler] list_projects error: %s", exc)
            return []

    def list_scenarios(self, project: str) -> List[str]:
        """Return the names of all scenario 'directories' within *project*."""
        try:
            entries = self.s3.ls(f"{self.bucket_name}/{project}")
            return [e.split("/")[-1] for e in entries]
        except Exception as exc:
            logger.warning("[S3Handler] list_scenarios error: %s", exc)
            return []

    def get_scenario_config(self, project: str, scenario: str) -> dict:
        """
        Return a dict with a ``layers`` key listing every object path
        found under the scenario prefix.
        """
        try:
            layers = self.s3.find(f"{self.bucket_name}/{project}/{scenario}")
            return {"layers": layers}
        except Exception as exc:
            logger.warning("[S3Handler] get_scenario_config error: %s", exc)
            return {"layers": []}

    # ------------------------------------------------------------------
    # Timeseries helpers
    # ------------------------------------------------------------------

    def get_scenario_timestamps(
        self, project: str, scenario: str, file_name: str
    ) -> list:
        """Read *file_name* from the timeseries layer and return DateTime values."""
        path = self._ts_path(project, scenario, file_name)
        with self.s3.open(path, "rb") as fh:
            df = pd.read_parquet(fh).reset_index()
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
        path = self._ts_path(project, scenario, file_name)
        with self.s3.open(path, "rb") as fh:
            df_pandas = pd.read_parquet(fh).reset_index()
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
        path = self._ts_path(project, scenario, file_name)
        with self.s3.open(path, "rb") as fh:
            return pd.read_pickle(fh, compression="gzip")

    # ------------------------------------------------------------------
    # Geo files
    # ------------------------------------------------------------------

    def get_geofile(self, project: str, scenario: str, file_name: str) -> dict:
        """Parse and return a GeoJSON file from the geo layer."""
        path = self._geo_path(project, scenario, file_name)
        try:
            with self.s3.open(path, "rb") as fh:
                return json.loads(fh.read())
        except Exception as exc:
            logger.warning("[S3Handler] get_geofile error: %s", exc)
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
        ``s3://{bucket}/{project}/{scenario}/{layer}/{file_name}``.
        """
        path = self._layer_path(project, scenario, layer, file_name)
        with self.s3.open(path, "wb") as fh:
            fh.write(data)

    # ------------------------------------------------------------------
    # Generic file uploads (not scenario-scoped)
    # ------------------------------------------------------------------

    def upload_file(self, file_type: str, sha256_hex: str, data: bytes) -> str:
        """
        Persist *data* at ``{bucket}/uploads/{file_type}/{sha256_hex}/raw``.

        The hash prefix (not the raw object key) is used as content_hash so
        that partition objects can live alongside the raw data under the same
        prefix without confusion.

        *sha256_hex* is pre-computed by the caller while streaming the
        upload so no second pass over the data is needed.  If the object
        already exists the upload is skipped (deduplication).
        """
        content_hash = f"uploads/{file_type}/{sha256_hex}"
        path = f"{self.bucket_name}/{content_hash}/raw"
        if not self.s3.exists(path):
            with self.s3.open(path, "wb") as fh:
                fh.write(data)
            logger.debug("[S3Handler] stored %s: %s… (%s bytes)", file_type, sha256_hex[:12], f"{len(data):,}")
        else:
            logger.debug("[S3Handler] dedup hit %s: %s…", file_type, sha256_hex[:12])
        return content_hash

    def read_file_bytes(self, content_hash: str) -> bytes:
        """Read and return raw bytes for a file identified by its content_hash."""
        path = f"{self.bucket_name}/{content_hash}/raw"
        with self.s3.open(path, "rb") as fh:
            return fh.read()

    def get_dataset_columns(self, content_hash: str, original_filename: str = "") -> List[str]:
        """Return column names for a CSV or Parquet dataset stored in S3."""
        import io
        path = f"{self.bucket_name}/{content_hash}"
        with self.s3.open(path, "rb") as fh:
            raw = fh.read()
        suffix = (original_filename or "").rsplit(".", 1)[-1].lower()
        if suffix == "parquet":
            return pl.read_parquet(io.BytesIO(raw), n_rows=0).columns
        return pl.read_csv(io.BytesIO(raw), n_rows=0).columns

    # ------------------------------------------------------------------
    # Date-partitioned timeseries storage
    # ------------------------------------------------------------------

    def write_partition(self, base_dir: str, date_str: str, parquet_bytes: bytes) -> None:
        """Write a date partition to S3."""
        key = f"{self.bucket_name}/{base_dir}/partitions/{date_str}.parquet"
        with self.s3.open(key, "wb") as fh:
            fh.write(parquet_bytes)

    def read_partition(self, base_dir: str, date_str: str) -> bytes:
        """Return raw parquet bytes for a date partition from S3."""
        key = f"{self.bucket_name}/{base_dir}/partitions/{date_str}.parquet"
        with self.s3.open(key, "rb") as fh:
            return fh.read()

    def list_partitions(self, base_dir: str) -> List[str]:
        """Return sorted list of date strings with stored partitions in S3."""
        prefix = f"{self.bucket_name}/{base_dir}/partitions/"
        try:
            entries = self.s3.ls(prefix)
            return sorted(
                e.split("/")[-1].replace(".parquet", "")
                for e in entries
                if e.endswith(".parquet")
            )
        except Exception:
            return []
