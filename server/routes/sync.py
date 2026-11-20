"""Sync session HTTP routes + WebSocket relay."""
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from lib.auth import require_api_key
from lib.responses import make_response

router = APIRouter()


@router.post("/api/sync/sessions")
async def createSyncSession(_=Depends(require_api_key)):
    from lib.sync import sync_manager

    key = sync_manager.generate_session_key()
    sync_manager.get_or_create_session(key)
    return make_response({"session_key": key})


@router.get("/api/sync/sessions")
async def listSyncSessions(_=Depends(require_api_key)):
    from lib.sync import sync_manager

    return make_response({"sessions": sync_manager.list_sessions()})


@router.post("/api/sync/ws-tickets")
async def registerWsTicket(body: dict, _=Depends(require_api_key)):
    from lib.sync import ws_ticket_store

    ticket = body.get("ticket")
    session_key = body.get("sessionKey")
    invite_id = body.get("inviteId")
    ttl_ms = int(body.get("ttlMs", 60_000))
    if not isinstance(ticket, str) or not isinstance(session_key, str):
        return make_response({"error": "ticket + sessionKey required"}, status=400)
    ws_ticket_store.issue(ticket, session_key, invite_id, ttl_ms)
    return make_response({"ok": True})


@router.delete("/api/sync/invites/{invite_id}/clients")
async def revokeInviteClients(invite_id: str, _=Depends(require_api_key)):
    from lib.sync import sync_manager

    n = await sync_manager.close_invite_clients(invite_id)
    return make_response({"ok": True, "closed": n})


@router.websocket("/ws/sync/{session_key}")
async def websocket_sync(websocket: WebSocket, session_key: str):
    from lib.sync import sync_manager, ws_ticket_store

    role = "operator"
    invite_id: str | None = None
    label = ""
    ticket = websocket.query_params.get("ticket")
    if ticket:
        consumed = ws_ticket_store.consume(ticket, session_key)
        if not consumed:
            await websocket.close(code=4003, reason="Invalid or expired ticket")
            return
        role = "guest"
        invite_id = consumed.invite_id

    session = sync_manager.get_or_create_session(session_key)
    await session.add(websocket, role=role, label=label, invite_id=invite_id)
    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                await session.relay(msg, websocket)
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        session.remove(websocket)
        sync_manager.remove_session_if_empty(session_key)
