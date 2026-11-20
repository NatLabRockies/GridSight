"""
Unit tests for the FileSystemHandler storage backend.

These tests exercise the storage layer directly (no FastAPI / HTTP layer).
A fresh temporary directory is created for each test via the tmp_path fixture.
"""

import hashlib
import io

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from lib.storage.filesystem import FileSystemHandler

# ── Helpers ─────────────────────────────────────────────────────────────────

RAW_DATA = b"hello gridsight storage test"
SHA256   = hashlib.sha256(RAW_DATA).hexdigest()


def _make_parquet(rows: dict) -> bytes:
    buf = io.BytesIO()
    pq.write_table(pa.table(rows), buf)
    return buf.getvalue()


@pytest.fixture()
def storage(tmp_path):
    return FileSystemHandler(data_dir=str(tmp_path))


# ── upload_file / read_file_bytes ───────────────────────────────────────────


class TestUploadFile:
    def test_stores_bytes_under_raw_subpath(self, storage, tmp_path):
        storage.upload_file("geometry", SHA256, RAW_DATA)
        raw = tmp_path / "uploads" / "geometry" / SHA256 / "raw"
        assert raw.exists(), "raw file should be written inside the hash directory"
        assert raw.read_bytes() == RAW_DATA

    def test_returns_hash_directory_as_content_hash(self, storage):
        content_hash = storage.upload_file("geometry", SHA256, RAW_DATA)
        assert content_hash == f"uploads/geometry/{SHA256}"

    def test_dataset_stored_under_dataset_prefix(self, storage, tmp_path):
        storage.upload_file("dataset", SHA256, RAW_DATA)
        raw = tmp_path / "uploads" / "dataset" / SHA256 / "raw"
        assert raw.exists()

    def test_read_file_bytes_roundtrip(self, storage):
        content_hash = storage.upload_file("geometry", SHA256, RAW_DATA)
        assert storage.read_file_bytes(content_hash) == RAW_DATA

    def test_deduplication_skips_second_write(self, storage, tmp_path):
        """Uploading the same hash twice must not overwrite the first write."""
        storage.upload_file("dataset", SHA256, RAW_DATA)
        raw = tmp_path / "uploads" / "dataset" / SHA256 / "raw"
        raw.write_bytes(b"sentinel")                  # mutate to detect re-write
        storage.upload_file("dataset", SHA256, b"different payload")
        assert raw.read_bytes() == b"sentinel"        # unchanged


# ── write_partition / read_partition / list_partitions ──────────────────────


class TestPartitions:
    def test_write_and_read_roundtrip(self, storage):
        content_hash = storage.upload_file("dataset", SHA256, RAW_DATA)
        parquet_bytes = _make_parquet({"id": ["a", "b"], "val": [1, 2]})
        storage.write_partition(content_hash, "2024-01-01", parquet_bytes)
        assert storage.read_partition(content_hash, "2024-01-01") == parquet_bytes

    def test_list_partitions_empty_before_any_write(self, storage):
        content_hash = storage.upload_file("dataset", SHA256, RAW_DATA)
        assert storage.list_partitions(content_hash) == []

    def test_list_partitions_returns_sorted_dates(self, storage):
        content_hash = storage.upload_file("dataset", SHA256, RAW_DATA)
        pb = _make_parquet({"x": [1]})
        for date in ["2024-01-03", "2024-01-01", "2024-01-02"]:
            storage.write_partition(content_hash, date, pb)
        assert storage.list_partitions(content_hash) == [
            "2024-01-01",
            "2024-01-02",
            "2024-01-03",
        ]

    def test_raw_file_and_partition_dir_coexist(self, storage):
        """
        Regression test for the 'Not a directory' bug:
        upload_file previously stored the raw bytes at uploads/dataset/{sha256}
        (a plain file), then write_partition tried to create
        uploads/dataset/{sha256}/partitions/ as a subdirectory of that file,
        which the OS rejects with ENOTDIR.

        The fix stores raw bytes at uploads/dataset/{sha256}/raw so the hash
        path is a directory and both raw and partitions/ can coexist.
        """
        content_hash = storage.upload_file("dataset", SHA256, RAW_DATA)
        pb = _make_parquet({"id": ["z"], "v": [99]})

        # Must not raise 'Not a directory'
        storage.write_partition(content_hash, "2024-06-15", pb)

        # Both the raw file and the partition remain intact
        assert storage.read_file_bytes(content_hash) == RAW_DATA
        assert storage.read_partition(content_hash, "2024-06-15") == pb
