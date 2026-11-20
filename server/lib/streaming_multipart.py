"""Streaming multipart parser for large file uploads.

``await request.form()`` (Starlette) buffers each file part into a
``SpooledTemporaryFile`` then yields the file objects after parsing
completes. The previous extension-upload handler then ran a SECOND
``shutil.copyfileobj`` from the spool to the real destination — so a
3 GB upload paid for ~6 GB of disk I/O before the response could go
out. With Bun's max ``idleTimeout`` of 255s, the browser ↔ Bun socket
went idle waiting for that response and Bun closed it.

This helper streams the request body straight into per-part destination
files using ``python-multipart``'s callback parser. Files land on disk
exactly once, the response is sent the moment the last byte arrives,
and the only memory we hold is the per-chunk buffer (a few KB).
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO

from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.requests import Request

# Form-field values are kept in memory (most are short strings — project
# name, scenario name). If a non-file part exceeds this, raise.
_MAX_FORM_FIELD_BYTES = 1 * 1024 * 1024


def _parse_content_disposition(value: bytes) -> tuple[str | None, str | None]:
    """Pull the ``name`` and ``filename`` params out of a Content-
    Disposition header. Returns ``(field_name, filename_or_None)``."""
    _, params = parse_options_header(value)
    name = params.get(b"name")
    filename = params.get(b"filename")
    return (
        name.decode("utf-8", errors="replace") if name else None,
        filename.decode("utf-8", errors="replace") if filename else None,
    )


def _safe_filename(name: str) -> str:
    """Strip path separators + control bytes so a hostile filename
    can't escape ``temp_dir``."""
    base = os.path.basename(name)
    return re.sub(r"[^\w.\-+ ]", "_", base) or "upload"


@dataclass
class _Part:
    """In-flight state for one multipart part."""
    headers: list[tuple[bytes, bytes]] = field(default_factory=list)
    _hdr_field: bytearray = field(default_factory=bytearray)
    _hdr_value: bytearray = field(default_factory=bytearray)
    field_name: str | None = None
    filename: str | None = None
    file: BinaryIO | None = None
    file_path: Path | None = None
    value_buf: bytearray | None = None  # for non-file form fields


@dataclass
class StreamedUpload:
    """Result of a streaming multipart parse.

    ``file_paths`` mirrors the shape used by the existing extension
    upload contract: ``{group_name: [path, path, ...]}``. ``form_data``
    holds string-valued form fields keyed by name."""
    file_paths: dict[str, list[str]] = field(default_factory=dict)
    form_data: dict[str, str] = field(default_factory=dict)


async def stream_multipart_to_dir(request: Request, temp_dir: Path) -> StreamedUpload:
    """Parse ``request`` as multipart/form-data, writing each file part
    to ``temp_dir`` once, and collecting form fields into a dict.

    Raises ``ValueError`` if the request is not multipart, or if a
    form-field part exceeds ``_MAX_FORM_FIELD_BYTES``.
    """
    content_type = request.headers.get("content-type", "")
    media_type, params = parse_options_header(content_type.encode())
    if media_type != b"multipart/form-data":
        raise ValueError(
            f"Expected multipart/form-data, got {content_type!r}"
        )
    boundary = params.get(b"boundary")
    if not boundary:
        raise ValueError("multipart/form-data missing boundary parameter")

    result = StreamedUpload()
    current = _Part()

    def on_part_begin():
        nonlocal current
        current = _Part()

    def on_header_field(data: bytes, start: int, end: int):
        current._hdr_field.extend(data[start:end])

    def on_header_value(data: bytes, start: int, end: int):
        current._hdr_value.extend(data[start:end])

    def on_header_end():
        # python-multipart emits one (field, value) pair per header.
        current.headers.append((bytes(current._hdr_field), bytes(current._hdr_value)))
        current._hdr_field = bytearray()
        current._hdr_value = bytearray()

    def on_headers_finished():
        for name, value in current.headers:
            if name.lower() == b"content-disposition":
                field_name, filename = _parse_content_disposition(value)
                current.field_name = field_name
                current.filename = filename
                break
        if current.field_name is None:
            # No Content-Disposition or no name — silently drop the part.
            return
        if current.filename:
            safe = _safe_filename(current.filename)
            dest = temp_dir / f"{current.field_name}_{safe}"
            current.file_path = dest
            current.file = open(dest, "wb")
        else:
            current.value_buf = bytearray()

    def on_part_data(data: bytes, start: int, end: int):
        if current.file is not None:
            current.file.write(data[start:end])
        elif current.value_buf is not None:
            current.value_buf.extend(data[start:end])
            if len(current.value_buf) > _MAX_FORM_FIELD_BYTES:
                raise ValueError(
                    f"Form field {current.field_name!r} exceeds "
                    f"{_MAX_FORM_FIELD_BYTES} bytes"
                )

    def on_part_end():
        if current.file is not None:
            current.file.close()
            current.file = None
            assert current.field_name is not None
            assert current.file_path is not None
            result.file_paths.setdefault(current.field_name, []).append(
                str(current.file_path)
            )
        elif current.value_buf is not None and current.field_name is not None:
            result.form_data[current.field_name] = current.value_buf.decode(
                "utf-8", errors="replace"
            )

    def on_end():
        pass

    parser = MultipartParser(boundary, callbacks={
        "on_part_begin": on_part_begin,
        "on_header_field": on_header_field,
        "on_header_value": on_header_value,
        "on_header_end": on_header_end,
        "on_headers_finished": on_headers_finished,
        "on_part_data": on_part_data,
        "on_part_end": on_part_end,
        "on_end": on_end,
    })

    try:
        async for chunk in request.stream():
            if chunk:
                parser.write(chunk)
    except Exception:
        # Make sure we don't leak open file handles on disconnect/error.
        if current.file is not None:
            try:
                current.file.close()
            except Exception:
                pass
        raise

    return result
