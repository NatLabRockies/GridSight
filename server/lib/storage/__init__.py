# lib/storage/__init__.py
# Factory that selects and instantiates the correct storage backend.
#
# Set the STORAGE_BACKEND environment variable to control which backend is used:
#
#   STORAGE_BACKEND=filesystem   (default)
#       Stores data on the local filesystem.
#       Controlled by: DATA_DIR (default: ./data)
#
#   STORAGE_BACKEND=s3
#       Stores data in an S3-compatible object store (AWS S3, MinIO, etc.).
#       Requires: ACCESS_KEY, SECRET_KEY, BUCKET_NAME
#       Optional: ENDPOINT_URL (omit for real AWS S3)
#
# Usage:
#   from lib.storage import create_storage_handler
#   handler = create_storage_handler()

from __future__ import annotations

import os

from .base import BaseStorageHandler


def create_storage_handler() -> BaseStorageHandler:
    """
    Instantiate and return the storage backend selected by the
    ``STORAGE_BACKEND`` environment variable.

    Supported values (case-insensitive):
    - ``filesystem`` *(default)* — :class:`~lib.storage.filesystem.FileSystemHandler`
    - ``s3``                     — :class:`~lib.storage.s3.S3Handler`

    Raises
    ------
    ValueError
        If ``STORAGE_BACKEND`` is set to an unrecognised value.
    EnvironmentError
        If required environment variables for the chosen backend are missing.
    """
    backend = os.environ.get("STORAGE_BACKEND", "filesystem").strip().lower()

    if backend == "filesystem":
        from .filesystem import FileSystemHandler

        data_dir = os.environ.get("DATA_DIR", "./data")
        return FileSystemHandler(data_dir=data_dir)

    if backend == "s3":
        from .s3 import S3Handler

        missing = [
            v
            for v in ("ACCESS_KEY", "SECRET_KEY", "BUCKET_NAME")
            if not os.environ.get(v)
        ]
        if missing:
            raise EnvironmentError(
                f"S3 storage backend requires the following environment "
                f"variables to be set: {', '.join(missing)}"
            )

        return S3Handler(
            key=os.environ["ACCESS_KEY"],
            secret=os.environ["SECRET_KEY"],
            endpoint_url=os.environ.get("ENDPOINT_URL"),  # None → real AWS S3
            bucket_name=os.environ["BUCKET_NAME"],
        )

    raise ValueError(
        f"Unknown STORAGE_BACKEND '{backend}'. Supported values: 'filesystem', 's3'."
    )


__all__ = ["BaseStorageHandler", "create_storage_handler"]
