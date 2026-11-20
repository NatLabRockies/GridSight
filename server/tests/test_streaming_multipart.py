"""Tests for the streaming multipart helper.

The contract: every byte of a file part lands on disk exactly once, and
the parse completes in time proportional to the byte stream — never
buffers a whole file in memory. These tests fake a Starlette ``Request``
with a body iterator so we can exercise the parser without spinning up
the full app.
"""
from __future__ import annotations

import asyncio
import os

from lib.streaming_multipart import stream_multipart_to_dir


class _FakeRequest:
    """Just enough of starlette.Request for the streaming parser:
    a ``headers`` dict and an async ``stream()`` iterator."""

    def __init__(self, body_chunks: list[bytes], boundary: bytes):
        self._chunks = body_chunks
        self.headers = {
            "content-type": f"multipart/form-data; boundary={boundary.decode()}"
        }

    async def stream(self):
        for chunk in self._chunks:
            yield chunk


def _build_body(boundary: bytes, parts: list[tuple[str, str | None, bytes]]) -> bytes:
    """Construct a valid multipart body. Each part is
    (field_name, filename_or_None, content_bytes)."""
    out = bytearray()
    for field_name, filename, content in parts:
        out += b"--" + boundary + b"\r\n"
        if filename is not None:
            out += (
                f'Content-Disposition: form-data; name="{field_name}"; '
                f'filename="{filename}"\r\n'
            ).encode()
            out += b"Content-Type: application/octet-stream\r\n"
        else:
            out += (
                f'Content-Disposition: form-data; name="{field_name}"\r\n'
            ).encode()
        out += b"\r\n"
        out += content
        out += b"\r\n"
    out += b"--" + boundary + b"--\r\n"
    return bytes(out)


def test_form_field_only(tmp_path):
    boundary = b"--------testboundary"
    body = _build_body(boundary, [("project", None, b"my-project")])
    req = _FakeRequest([body], boundary)

    result = asyncio.run(stream_multipart_to_dir(req, tmp_path))

    assert result.form_data == {"project": "my-project"}
    assert result.file_paths == {}


def test_single_file_lands_on_disk_exactly_once(tmp_path):
    boundary = b"--------testboundary"
    payload = b"x" * (5 * 1024 * 1024)  # 5 MB
    body = _build_body(boundary, [("system_file", "sys.json", payload)])
    req = _FakeRequest([body], boundary)

    result = asyncio.run(stream_multipart_to_dir(req, tmp_path))

    assert "system_file" in result.file_paths
    assert len(result.file_paths["system_file"]) == 1
    p = result.file_paths["system_file"][0]
    assert os.path.getsize(p) == len(payload)
    with open(p, "rb") as f:
        assert f.read() == payload


def test_multiple_files_same_field(tmp_path):
    boundary = b"--------testboundary"
    body = _build_body(boundary, [
        ("simulation_files", "a.h5", b"AAA"),
        ("simulation_files", "b.h5", b"BBBB"),
        ("project", None, b"my-project"),
    ])
    req = _FakeRequest([body], boundary)

    result = asyncio.run(stream_multipart_to_dir(req, tmp_path))

    assert len(result.file_paths["simulation_files"]) == 2
    sizes = sorted(os.path.getsize(p) for p in result.file_paths["simulation_files"])
    assert sizes == [3, 4]
    assert result.form_data == {"project": "my-project"}


def test_chunked_body_reassembles_correctly(tmp_path):
    """The underlying network delivers small chunks. Streaming parse
    must reassemble the bytes correctly when a single file part is
    split across many chunks."""
    boundary = b"--------testboundary"
    payload = bytes(range(256)) * 200  # 51,200 bytes, deterministic
    body = _build_body(boundary, [("file", "data.bin", payload)])
    # Cut into 4 KB chunks
    chunks = [body[i:i + 4096] for i in range(0, len(body), 4096)]
    req = _FakeRequest(chunks, boundary)

    result = asyncio.run(stream_multipart_to_dir(req, tmp_path))

    p = result.file_paths["file"][0]
    with open(p, "rb") as f:
        got = f.read()
    assert got == payload, (
        f"chunked reassembly mismatch: {len(got)} vs {len(payload)} bytes"
    )


def test_unsafe_filename_is_sanitized(tmp_path):
    boundary = b"--------testboundary"
    body = _build_body(boundary, [
        ("file", "../../../etc/passwd", b"hostile"),
    ])
    req = _FakeRequest([body], boundary)

    result = asyncio.run(stream_multipart_to_dir(req, tmp_path))

    p = result.file_paths["file"][0]
    # No path traversal — destination is inside tmp_path
    assert os.path.dirname(p) == str(tmp_path)
    assert "etc/passwd" not in p


def test_rejects_non_multipart():
    import pytest
    req = _FakeRequest([b"hello"], b"x")
    req.headers = {"content-type": "application/json"}
    with pytest.raises(ValueError, match="multipart/form-data"):
        asyncio.run(stream_multipart_to_dir(req, "/tmp"))
