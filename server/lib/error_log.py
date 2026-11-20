"""In-memory log of recent errors, for agents.

Agents (the MCP server, the in-app AI) drive the app without seeing it. This
buffer collects what went wrong so they can read it and correct themselves:

- ``http``: every API response with status >= 400 (path, status, body
  excerpt), recorded by the middleware in app.py;
- ``server:<logger>``: log records at ERROR or above;
- ``client:<source>``: errors that the web app reports (console.error,
  uncaught exceptions, failed renders) through POST /api/client-errors.

Entries have a growing ``seq`` so a caller can ask for "everything after the
last one I saw". The buffer keeps the newest 500 entries only.
"""
from __future__ import annotations

import collections
import itertools
import logging
import threading
import time
from typing import Any

_MAX = 500
_buf: collections.deque[dict[str, Any]] = collections.deque(maxlen=_MAX)
_lock = threading.Lock()
_seq = itertools.count(1)


def record(source: str, message: str, detail: Any = None, level: str = "error") -> None:
    entry = {
        "seq": 0,
        "time": time.time(),
        "level": level,
        "source": source,
        "message": str(message)[:2000],
    }
    if detail not in (None, "", {}):
        entry["detail"] = detail if isinstance(detail, (dict, list)) else str(detail)[:4000]
    with _lock:
        entry["seq"] = next(_seq)
        _buf.append(entry)


def since(seq: int = 0, limit: int = 100) -> list[dict[str, Any]]:
    """Entries newer than ``seq``, oldest first, at most ``limit``."""
    with _lock:
        items = [e for e in _buf if e["seq"] > seq]
    return items[:limit]


def latest_seq() -> int:
    with _lock:
        return _buf[-1]["seq"] if _buf else 0


_add = record


class BufferHandler(logging.Handler):
    """Copies ERROR+ log records into the buffer."""

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = record.getMessage()
            detail = None
            if record.exc_info:
                detail = logging.Formatter().formatException(record.exc_info)
            _add(f"server:{record.name}", msg, detail, level=record.levelname.lower())
        except Exception:  # never let logging break the app
            pass
