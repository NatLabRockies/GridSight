# lib/data_lake.py
# ---------------------------------------------------------------------------
# DEPRECATED — this module is retained only for backwards compatibility.
#
# The storage layer has been refactored into lib/storage/:
#
#   lib/storage/base.py        — BaseStorageHandler (abstract interface)
#   lib/storage/filesystem.py  — FileSystemHandler  (local disk, default)
#   lib/storage/s3.py          — S3Handler          (S3 / MinIO)
#   lib/storage/__init__.py    — create_storage_handler() factory
#
# Instead of importing S3Handler directly, use the factory:
#
#   from lib.storage import create_storage_handler
#   storage = create_storage_handler()
#
# The factory selects the backend from the STORAGE_BACKEND environment
# variable ("filesystem" or "s3").  See lib/storage/__init__.py for details.
# ---------------------------------------------------------------------------

import warnings

warnings.warn(
    "lib.data_lake is deprecated and will be removed in a future release. "
    "Import from lib.storage instead:  from lib.storage import create_storage_handler",
    DeprecationWarning,
    stacklevel=2,
)

# Re-export S3Handler so that any existing code that does
#   from lib.data_lake import S3Handler
# continues to work without modification.
from lib.storage.s3 import S3Handler  # noqa: F401, E402

__all__ = ["S3Handler"]
