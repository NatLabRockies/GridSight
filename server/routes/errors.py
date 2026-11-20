"""Recent errors for agents: read them, and let the web app report its own."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from lib import error_log
from lib.auth import require_api_key

router = APIRouter()


class ClientError(BaseModel):
    source: str = "web"
    message: str
    detail: Any = None
    level: str = "error"


class ClientErrorBatch(BaseModel):
    errors: list[ClientError]


@router.post("/api/client-errors")
async def report_client_errors(body: ClientErrorBatch, _=Depends(require_api_key)) -> dict:
    for e in body.errors[:50]:
        error_log.record(f"client:{e.source}", e.message, e.detail, level=e.level)
    return {"recorded": min(len(body.errors), 50), "latest_seq": error_log.latest_seq()}


@router.get("/api/errors")
async def get_errors(since: int = 0, limit: int = 100, _=Depends(require_api_key)) -> dict:
    items = error_log.since(since, max(1, min(limit, 500)))
    return {
        "errors": items,
        "next_since": items[-1]["seq"] if items else since,
        "latest_seq": error_log.latest_seq(),
    }
