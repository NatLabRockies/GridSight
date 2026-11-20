"""
Storage helpers for extensions and core services.

`resolve_path(uri)` accepts both filesystem paths and `s3://bucket/key`
URIs and gives back a *local* Path the caller can read from and write
to as if it were a regular file. When the URI is on S3:

  - On call: the object is downloaded to a stable local cache file (or
    no-op'd if the object doesn't exist yet, so first-run code paths
    that create the file still work).
  - On `atexit`: if the local file exists and `persist_on_exit=True`
    (default), it's uploaded back to S3.

This is the intended pattern for a "database lives on S3" deployment:
the application keeps treating its DB as a single local file, and the
helper handles the round-trip. **It's not a transactional sync** — a
SIGKILL between writes and shutdown loses the in-flight changes.
Single-replica deployments only.

Credentials follow the standard boto3 chain (env / IRSA / instance
role / shared config). Override the endpoint with the standard
``AWS_ENDPOINT_URL_S3`` or ``AWS_ENDPOINT_URL`` env vars (lets you
point at SeaweedFS / MinIO / private S3 mirrors without code changes).
"""

from __future__ import annotations

import atexit
import gzip
import hashlib
import logging
import os
import shutil
from pathlib import Path
from typing import Callable

# gzip-compressed streams begin with these two bytes regardless of the
# filename. We sniff the first two bytes of the downloaded object so a
# gzipped DB pushed past a WAF (which often blocks raw SQLite/DuckDB
# magic) is transparently decompressed for the application.
_GZIP_MAGIC = b"\x1f\x8b"

logger = logging.getLogger(__name__)

# Upload callbacks registered by `resolve_path(...)`. `flush_pending()`
# walks them in order and invokes each one synchronously. This exists
# because `atexit` handlers run AFTER Python tears down the
# concurrent.futures executors that boto3 relies on, so an
# atexit-registered upload fails with "cannot schedule new futures
# after interpreter shutdown" on a real shutdown. The application's
# lifespan teardown (FastAPI's lifespan ctx mgr exit) should call
# flush_pending() while the runtime is still healthy. The atexit
# registration remains as a backstop for non-lifespan callers.
_pending_flushes: list[Callable[[], None]] = []


def flush_pending() -> None:
    """Execute every pending S3 upload synchronously.

    Idempotent: each callback removes itself from the list after a
    successful run, so a subsequent atexit-fired call is a no-op.
    Failures log + leave the callback registered so atexit can retry,
    though the boto3-shutdown race usually causes that retry to fail
    too — better to call this from a real shutdown hook.
    """
    while _pending_flushes:
        cb = _pending_flushes.pop()
        try:
            cb()
        except Exception as e:
            logger.error("[storage] flush_pending callback failed: %s", e)


def is_s3_uri(uri: str) -> bool:
    return isinstance(uri, str) and uri.startswith("s3://")


def _split_s3(uri: str) -> tuple[str, str]:
    rest = uri[len("s3://"):]
    bucket, _, key = rest.partition("/")
    return bucket, key


def _make_s3_client():
    """Build a boto3 S3 client.

    Credentials, region, and endpoint come from boto3's default chain
    (``AWS_ACCESS_KEY_ID`` / ``AWS_SECRET_ACCESS_KEY`` / ``AWS_REGION``
    / IRSA / instance profile / shared config). Endpoint overrides
    use the standard ``AWS_ENDPOINT_URL_S3`` (with ``AWS_ENDPOINT_URL``
    as a fallback). When deploying against a non-AWS backend like
    SeaweedFS, map your local creds in compose:

        AWS_ACCESS_KEY_ID:     ${SEAWEEDFS_ACCESS_KEY}
        AWS_SECRET_ACCESS_KEY: ${SEAWEEDFS_SECRET_KEY}
        AWS_ENDPOINT_URL_S3:   ${SEAWEEDFS_ENDPOINT}

    When an endpoint override is in play we force path-style addressing
    + SigV4 because SeaweedFS / MinIO reject virtual-host requests.
    Real AWS S3 keeps its defaults so we don't accidentally regress
    bucket-name compatibility.
    """
    import boto3
    from botocore.config import Config

    endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL")
    cfg_kwargs: dict = {"retries": {"max_attempts": 3}}
    if endpoint:
        cfg_kwargs["signature_version"] = "s3v4"
        cfg_kwargs["s3"] = {"addressing_style": "path"}

    kwargs: dict = {"config": Config(**cfg_kwargs)}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    return boto3.client("s3", **kwargs)


def _cache_root() -> Path:
    """Where downloaded S3 objects live on local disk.

    Order: STORAGE_CACHE_DIR > DATA_DIR/_s3_cache > /tmp/_s3_cache.
    DATA_DIR is the standard gridsight server volume, so by default the
    cache rides on the same PVC as the rest of /data — handy for
    avoiding a re-download on every pod restart.
    """
    explicit = os.environ.get("STORAGE_CACHE_DIR")
    if explicit:
        return Path(explicit)
    data_dir = os.environ.get("DATA_DIR")
    if data_dir:
        return Path(data_dir) / "_s3_cache"
    return Path("/tmp/_s3_cache")


def _looks_gzipped(path: Path) -> bool:
    """Return True if `path` exists and starts with the gzip magic bytes."""
    try:
        with open(path, "rb") as fh:
            return fh.read(2) == _GZIP_MAGIC
    except OSError:
        return False


def _gunzip_in_place(path: Path) -> None:
    """Decompress `path` (a gzip stream) and replace it with the raw bytes.

    Streams chunk-by-chunk so multi-GB DB files don't load fully into
    memory. The intermediate file is written next to the original and
    atomically renamed at the end.
    """
    tmp = path.with_suffix(path.suffix + ".raw")
    with gzip.open(path, "rb") as src, open(tmp, "wb") as dst:
        shutil.copyfileobj(src, dst)
    tmp.replace(path)


def _gzip_to(src: Path, dst: Path) -> None:
    """Stream-compress `src` to `dst` (gzip)."""
    with open(src, "rb") as src_fh, gzip.open(dst, "wb") as dst_fh:
        shutil.copyfileobj(src_fh, dst_fh)


def commit_path(src: str | os.PathLike, dest: str) -> None:
    """Persist a local file to ``dest``, which may be:

      - ``s3://bucket/key`` — uploaded via boto3 (gzipped if the key
        ends with ``.gz``).
      - any other path — copied to that path on the local filesystem
        (NFS / SMB / PVC mounts all look like local paths to this
        function; the storage backend is whatever ``mount`` says).

    Use this when an extension has a single conceptual data root that
    operators can configure as either a directory or an S3 URI without
    the extension code having to branch.
    """
    if is_s3_uri(dest):
        push_to_s3(src, dest)
        return
    src_path = Path(src)
    if not src_path.is_file():
        raise FileNotFoundError(src_path)
    dest_path = Path(dest)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    import shutil as _shutil
    _shutil.copy2(src_path, dest_path)
    logger.info("[storage] copied %s → %s", src_path, dest_path)


def delete_prefix(uri: str) -> int:
    """Delete every object under ``uri``.

    Mirror of ``commit_path``: ``s3://bucket/prefix/`` walks S3 keys,
    a local path walks the directory tree (matching directory or any
    file whose name starts with the prefix). Returns the count of
    objects/files removed.
    """
    if is_s3_uri(uri):
        return delete_s3_prefix(uri)
    p = Path(uri)
    if p.is_dir():
        import shutil as _shutil
        # Count first so the return value is meaningful before rmtree.
        count = sum(1 for _ in p.rglob("*") if _.is_file())
        _shutil.rmtree(p, ignore_errors=True)
        if count:
            logger.info("[storage] removed %d files under %s", count, p)
        return count
    if p.exists():
        p.unlink()
        return 1
    return 0


def push_to_s3(local: str | os.PathLike, uri: str) -> None:
    """Upload a single local file to ``uri`` (s3://bucket/key).

    If ``uri`` ends with ``.gz``, the file is gzip-compressed in flight
    via a tempfile next to the source — useful for getting past WAFs
    that block raw SQLite / DuckDB / HDF5 magic bytes.
    """
    if not is_s3_uri(uri):
        raise ValueError(f"Not an s3:// URI: {uri!r}")
    bucket, key = _split_s3(uri)
    if not bucket or not key:
        raise ValueError(f"Invalid S3 URI: {uri!r}")

    src = Path(local)
    if not src.is_file():
        raise FileNotFoundError(src)

    s3 = _make_s3_client()
    if key.endswith(".gz"):
        tmp = src.with_suffix(src.suffix + ".__push.gz")
        try:
            _gzip_to(src, tmp)
            s3.upload_file(str(tmp), bucket, key)
            logger.info("[storage] gzipped + uploaded %s → s3://%s/%s", src, bucket, key)
        finally:
            tmp.unlink(missing_ok=True)
    else:
        s3.upload_file(str(src), bucket, key)
        logger.info("[storage] uploaded %s → s3://%s/%s", src, bucket, key)


def delete_s3_prefix(uri: str) -> int:
    """Delete every object under ``uri`` (treated as a prefix).

    ``uri`` should look like ``s3://bucket/prefix/``. The trailing
    slash is optional but recommended — without it the call also
    matches keys that happen to share the prefix as a substring.
    Returns the number of objects deleted.
    """
    if not is_s3_uri(uri):
        raise ValueError(f"Not an s3:// URI: {uri!r}")
    bucket, prefix = _split_s3(uri)
    if not bucket:
        raise ValueError(f"Invalid S3 URI: {uri!r}")

    s3 = _make_s3_client()
    paginator = s3.get_paginator("list_objects_v2")
    deleted = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        contents = page.get("Contents") or []
        if not contents:
            continue
        # delete_objects caps at 1000 per call; pages are 1000-keyed.
        objs = [{"Key": o["Key"]} for o in contents]
        s3.delete_objects(Bucket=bucket, Delete={"Objects": objs, "Quiet": True})
        deleted += len(objs)
    if deleted:
        logger.info("[storage] deleted %d objects under s3://%s/%s", deleted, bucket, prefix)
    return deleted


def resolve_path(uri: str | os.PathLike, *, persist_on_exit: bool = True) -> Path:
    """Resolve a local path or s3:// URI to a writable local Path.

    Args:
        uri: Local filesystem path or ``s3://bucket/key``. If the S3 key
            ends with ``.gz`` (or the downloaded object is gzip-magic
            even without that suffix), the helper transparently
            decompresses on download and re-compresses on upload. Useful
            when an inline WAF blocks raw SQLite / DuckDB magic bytes
            and the operator pre-compressed the object out of band.
        persist_on_exit: If True (default) and `uri` is on S3, register
            an atexit hook that uploads the local file back to S3 on
            shutdown. Pass False when the caller has its own flush
            cadence and wants to push explicitly.

    Returns:
        A Path to a local file. Caller may read, write, or create it.
        The file may not exist yet if the S3 object doesn't.
    """
    uri_str = str(uri)
    if not is_s3_uri(uri_str):
        return Path(uri_str)

    bucket, key = _split_s3(uri_str)
    if not bucket or not key:
        raise ValueError(f"Invalid S3 URI: {uri_str!r}")

    # Compression is opted into by `.gz` on the S3 key. The local cache
    # file drops the `.gz` suffix so SQLite / DuckDB see a normal DB
    # filename — the application stays oblivious to wire-format details.
    key_compressed = key.endswith(".gz")
    local_key = key[:-3] if key_compressed else key

    cache_root = _cache_root()
    cache_root.mkdir(parents=True, exist_ok=True)
    # Stable, deterministic local name keyed on (bucket, key) so multiple
    # `resolve_path` calls for the same URI reuse the same file. Hash
    # the key so slashes / odd characters don't escape the cache root.
    digest = hashlib.sha1(f"{bucket}/{key}".encode()).hexdigest()[:16]
    suffix = Path(local_key).suffix
    local = cache_root / f"{digest}{suffix}"

    s3 = _make_s3_client()
    try:
        s3.download_file(bucket, key, str(local))
        logger.info("[storage] downloaded s3://%s/%s → %s", bucket, key, local)
        # Decompress if the key advertises `.gz` OR if the bytes look
        # gzipped (operator may have pushed compressed content under a
        # raw .db key to dodge a WAF). Magic-byte sniff is cheap and
        # bulletproof against suffix mismatches.
        if key_compressed or _looks_gzipped(local):
            _gunzip_in_place(local)
            logger.info("[storage] decompressed gzip → %s", local)
    except Exception as e:
        # First-run case: object doesn't exist yet, the caller will
        # create the local file and atexit will upload it. Surface this
        # as info so a real auth failure is still visible in logs.
        logger.info(
            "[storage] s3://%s/%s not pulled (%s: %s); local %s will be created fresh",
            bucket, key, type(e).__name__, e, local,
        )

    if persist_on_exit:
        # Closure-flag idempotency: flush_pending and atexit both fire
        # this callback. The second invocation would normally fail
        # because boto3's threadpool is gone by atexit time. After the
        # first successful upload, become a no-op.
        state = {"fired": False}
        def _push():
            if state["fired"]:
                return
            if not local.exists():
                logger.info("[storage] no local file at %s, skipping upload", local)
                state["fired"] = True
                return
            try:
                if key_compressed:
                    # Upload a freshly-gzipped temp so the on-disk DB
                    # remains usable for a subsequent flush in the same
                    # process (think long-running container that calls
                    # flush_pending() multiple times).
                    tmp = local.with_suffix(local.suffix + ".gz")
                    _gzip_to(local, tmp)
                    s3.upload_file(str(tmp), bucket, key)
                    tmp.unlink(missing_ok=True)
                    logger.info(
                        "[storage] gzipped + uploaded %s → s3://%s/%s",
                        local, bucket, key,
                    )
                else:
                    s3.upload_file(str(local), bucket, key)
                    logger.info("[storage] uploaded %s → s3://%s/%s", local, bucket, key)
                state["fired"] = True
            except Exception as e:
                # Not raising — atexit suppresses exceptions anyway, and a
                # log entry is the only useful signal during shutdown.
                logger.error("[storage] upload to s3://%s/%s failed: %s", bucket, key, e)
        # Belt-and-suspenders: try the lifespan-driven flush first, fall
        # back to atexit for callers that never invoke flush_pending().
        _pending_flushes.append(_push)
        atexit.register(_push)

    return local
