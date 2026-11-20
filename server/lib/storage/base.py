# lib/storage/base.py
# Abstract base class defining the storage interface for GridSight.
# All storage backends must implement every method defined here.

from abc import ABC, abstractmethod
from functools import lru_cache
from typing import List


class BaseStorageHandler(ABC):
    """
    Abstract interface for GridSight data storage.

    Concrete implementations must provide project/scenario discovery,
    file retrieval (parquet, pickle, geojson), and file upload.

    Directory conventions (mirrored in every backend):
        {root}/{project}/{scenario}/timeseries/{file_name}
        {root}/{project}/{scenario}/geo/{file_name}
        {root}/{project}/{scenario}/{layer}/{file_name}   ← generic upload
    """

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    @abstractmethod
    def list_projects(self) -> List[str]:
        """Return a list of project names available in the storage root."""
        ...

    @abstractmethod
    def list_scenarios(self, project: str) -> List[str]:
        """Return a list of scenario names for *project*."""
        ...

    @abstractmethod
    def get_scenario_config(self, project: str, scenario: str) -> dict:
        """
        Return a configuration dict describing the contents of a scenario.

        At minimum the dict should contain::

            {
                "layers": [<path>, ...]   # all files under the scenario
            }
        """
        ...

    # ------------------------------------------------------------------
    # Timeseries helpers
    # ------------------------------------------------------------------

    @abstractmethod
    def get_scenario_timestamps(
        self, project: str, scenario: str, file_name: str
    ) -> list:
        """
        Read a parquet file from ``timeseries/`` and return the
        ``DateTime`` column as a plain Python list.
        """
        ...

    @abstractmethod
    def get_dataframe(self, project: str, scenario: str, file_name: str):
        """
        Read a parquet file from ``timeseries/`` and return a
        **Polars** DataFrame.  Results should be cached where possible.
        """
        ...

    @abstractmethod
    def get_pickle(self, project: str, scenario: str, file_name: str):
        """
        Read a gzip-compressed pickle from ``timeseries/`` and return a
        **pandas** DataFrame.  Results should be cached where possible.
        """
        ...

    # ------------------------------------------------------------------
    # Geo files
    # ------------------------------------------------------------------

    @abstractmethod
    def get_geofile(self, project: str, scenario: str, file_name: str) -> dict:
        """
        Read a GeoJSON file from ``geo/`` and return it as a parsed dict.
        """
        ...

    # ------------------------------------------------------------------
    # Uploads
    # ------------------------------------------------------------------

    @abstractmethod
    def post_file(
        self,
        project: str,
        scenario: str,
        layer: str,
        file_name: str,
        data: bytes,
    ) -> None:
        """
        Write *data* to ``{root}/{project}/{scenario}/{layer}/{file_name}``.

        *layer* is a free-form string supplied by the caller (e.g.
        ``"geo"``, ``"timeseries"``, ``"dispatch"``).
        """
        ...

    # ------------------------------------------------------------------
    # Generic file uploads (not scenario-scoped)
    # ------------------------------------------------------------------

    @abstractmethod
    def upload_file(self, file_type: str, sha256_hex: str, data: bytes) -> str:
        """
        Persist *data* using content-addressable storage and return the
        relative path ``uploads/{file_type}/{sha256hex}`` as the
        *content_hash* stored in the DB.

        *sha256_hex* is the hex digest computed by the caller while streaming
        the upload (so the hash is never re-computed from the full buffer).
        If a file with that hash already exists the write is skipped,
        enabling transparent deduplication.

        ``file_type`` is ``"geometry"`` or ``"dataset"``.
        """
        ...

    @abstractmethod
    def read_file_bytes(self, file_id: str) -> bytes:
        """
        Read and return the raw bytes for a file previously saved via
        :meth:`upload_file`, given its *file_id*.
        """
        ...

    @abstractmethod
    def get_dataset_columns(self, file_id: str) -> List[str]:
        """
        Return the column names of a tabular dataset (CSV or Parquet)
        identified by *file_id*.
        """
        ...

    # ------------------------------------------------------------------
    # Date-partitioned timeseries storage
    # ------------------------------------------------------------------

    @abstractmethod
    def write_partition(self, base_dir: str, date_str: str, parquet_bytes: bytes) -> None:
        """
        Write one day's worth of timeseries data as a parquet file.

        Files are stored at ``{root}/{base_dir}/partitions/{date_str}.parquet``.
        ``base_dir`` should be the dataset's ``content_hash``
        (e.g. ``uploads/dataset/{sha256hex}``).
        """
        ...

    @abstractmethod
    def read_partition(self, base_dir: str, date_str: str) -> bytes:
        """
        Return the raw parquet bytes for a date partition previously written
        with :meth:`write_partition`.
        """
        ...

    @abstractmethod
    def list_partitions(self, base_dir: str) -> List[str]:
        """
        Return a sorted list of available date strings (``YYYY-MM-DD``) for
        the given *base_dir*.  Returns an empty list if no partitions exist.
        """
        ...
