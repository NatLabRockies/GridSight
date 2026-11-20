"""
Internal endpoints — only mounted when MERIDIAN_DESKTOP=1.

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
