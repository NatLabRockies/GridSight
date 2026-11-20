"""
Internal endpoints — only mounted when GRIDSIGHT_DESKTOP=1.

Provides two things:
  1. POST /internal/bus/inject  — MCP server pushes a stateBus message here.
  2. GET  /internal/bus/stream  — SSE stream; the desktop frontend subscribes
     and receives every injected message so it can apply it to the local bus
     without needing an active WebSocket sync session.

Both the inject envelope and the SSE subscriber registry live on the shared
`sync_manager` (lib/sync.py) so the AI chart endpoint (routes/ai.py) can reach
the same subscribers.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from lib.auth import api_key_header
from lib.sync import sync_manager

router = APIRouter()

_API_KEY = os.environ.get("API_KEY", "")


def _check_key(header: str | None, query: str) -> None:
    """Accept the API key from either the standard header or a query param.
    EventSource doesn't support custom headers, so the SSE endpoint uses ?api_key=.
    """
    if (header and header == _API_KEY) or (query and query == _API_KEY):
        return
    raise HTTPException(status_code=401, detail="Invalid or missing API key")


@router.get("/internal/bus/stream")
async def bus_stream(
    request: Request,
    api_key: str = Query(default=""),
    header_key: str | None = Depends(api_key_header),
) -> EventSourceResponse:
    """SSE stream the desktop frontend subscribes to for injected bus messages.
    Auth via ?api_key= query param (EventSource can't send headers)."""
    _check_key(header_key, api_key)

    queue = sync_manager.add_sse_subscriber()

    async def generator():
        yield {"event": "connected", "data": "ok"}
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=30)
                    yield {"data": json.dumps(msg)}
                except asyncio.TimeoutError:
                    yield {"event": "ping", "data": ""}
        finally:
            sync_manager.remove_sse_subscriber(queue)

    return EventSourceResponse(generator())


class BusInjectRequest(BaseModel):
    channel: str
    payload: dict[str, Any]
    action: str = "update"


@router.post("/internal/bus/inject")
async def inject_bus_message(
    body: BusInjectRequest,
    header_key: str | None = Depends(api_key_header),
    api_key: str = Query(default=""),
) -> dict:
    """Inject a stateBus message to WebSocket clients AND SSE-subscribed frontends."""
    _check_key(header_key, api_key)
    sent = await sync_manager.inject(body.channel, body.payload, body.action)
    return {"sent": sent, "channel": body.channel}


@router.post("/internal/restart")
async def restart_backend(
    header_key: str | None = Depends(api_key_header),
    api_key: str = Query(default=""),
) -> dict:
    """Exit this process shortly after replying. The desktop watchdog
    respawns the sidecar (new port, written to backend.json), which then
    rediscovers extensions through their entry points. Use after installing
    or removing an extension. Desktop only: this router is mounted only when
    GRIDSIGHT_DESKTOP=1."""
    _check_key(header_key, api_key)
    asyncio.get_running_loop().call_later(0.5, os._exit, 0)
    return {"restarting": True}


# ── capture_view: the window renders itself to PNG for an agent ───────────
# The MCP tool injects {"type": "capture-view", "requestId": ...} on the
# "mcp" channel, the window POSTs the PNG here, and the tool polls GET.
_captures: dict[str, dict[str, Any]] = {}


class CaptureResult(BaseModel):
    png: str | None = None
    width: int | None = None
    height: int | None = None
    notes: list[str] = []
    error: str | None = None


@router.post("/internal/capture/result/{request_id}")
async def put_capture(
    request_id: str,
    body: CaptureResult,
    header_key: str | None = Depends(api_key_header),
    api_key: str = Query(default=""),
) -> dict:
    _check_key(header_key, api_key)
    if len(_captures) > 8:  # keep only a few recent captures in memory
        for k in list(_captures)[: len(_captures) - 8]:
            _captures.pop(k, None)
    _captures[request_id] = body.model_dump()
    return {"stored": True}


@router.get("/internal/capture/result/{request_id}")
async def get_capture(
    request_id: str,
    header_key: str | None = Depends(api_key_header),
    api_key: str = Query(default=""),
) -> dict:
    _check_key(header_key, api_key)
    if request_id not in _captures:
        raise HTTPException(status_code=404, detail="not ready")
    return _captures.pop(request_id)


# ── Layer tools for MCP: reuse the in-app AI's layer tools ────────────────
# The in-app chat and MCP agents should have the same layer verbs. These
# tools run in the server process (database + DuckDB), so MCP calls them here.
_LAYER_TOOLS = {
    "list_layers",          # with style ids and geometry_properties
    "style_layer",
    "update_layer_style",
    "filter_layer",
    "set_visible_layers",
    "set_category_colors",
}


@router.post("/internal/tools/{tool_name}")
async def run_layer_tool(
    tool_name: str,
    request: Request,
    header_key: str | None = Depends(api_key_header),
    api_key: str = Query(default=""),
) -> Any:
    _check_key(header_key, api_key)
    if tool_name not in _LAYER_TOOLS:
        raise HTTPException(status_code=404, detail=f"unknown tool {tool_name!r}; allowed: {sorted(_LAYER_TOOLS)}")
    import db as _db
    from lib.ai.tools import execute_tool

    args = await request.json() if (await request.body()) else {}
    out = await asyncio.to_thread(
        execute_tool, tool_name, args,
        request.app.state.duckdb_engine, request.app.state.extension_registry,
        db=_db,
    )
    try:
        return json.loads(out)
    except (TypeError, ValueError):
        return {"result": out}
