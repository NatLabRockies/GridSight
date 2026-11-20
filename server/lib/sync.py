"""
WebSocket relay for multi-window/multi-machine state synchronization.

Clients connect to /ws/sync/{session_key} and send JSON messages.
The server relays each message to all other clients in the same session.
Sessions are created on first connection and cleaned up when empty.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


@dataclass
class _ClientEntry:
    ws: WebSocket
    role: str = "operator"          # 'operator' | 'guest'
    label: str = ""                 # human-readable identifier
    invite_id: str | None = None    # set for guest clients


class SyncSession:
    """A group of connected WebSocket clients sharing state."""

    def __init__(self, session_key: str):
        self.session_key = session_key
        self.entries: list[_ClientEntry] = []

    @property
    def clients(self) -> list[WebSocket]:
        return [e.ws for e in self.entries]

    async def add(
        self,
        ws: WebSocket,
        *,
        role: str = "operator",
        label: str = "",
        invite_id: str | None = None,
    ) -> None:
        await ws.accept()
        entry = _ClientEntry(ws=ws, role=role, label=label, invite_id=invite_id)
        self.entries.append(entry)
        logger.info(
            "Client joined session '%s' role=%s (%d clients)",
            self.session_key, role, len(self.entries),
        )
        await self._broadcast_presence()

    def remove(self, ws: WebSocket) -> None:
        before = len(self.entries)
        self.entries = [e for e in self.entries if e.ws is not ws]
        if len(self.entries) != before:
            logger.info(
                "Client left session '%s' (%d remaining)",
                self.session_key, len(self.entries),
            )
        # Presence broadcast is fire-and-forget; we're inside a sync caller
        # so spawn a task only if there's anyone left to receive it.
        if self.entries:
            import asyncio
            asyncio.create_task(self._broadcast_presence())

    async def relay(self, message: dict[str, Any], sender: WebSocket) -> None:
        """Send a message to all clients in this session except the sender."""
        data = json.dumps(message)
        disconnected = []
        for entry in self.entries:
            if entry.ws is sender:
                continue
            try:
                await entry.ws.send_text(data)
            except Exception:
                disconnected.append(entry.ws)
        for ws in disconnected:
            self.remove(ws)

    async def close_clients_by_invite(self, invite_id: str) -> int:
        """Force-close all guest clients tied to a given invite_id. Returns count."""
        targets = [e for e in self.entries if e.invite_id == invite_id]
        for e in targets:
            try:
                await e.ws.close(code=4001, reason="Invite revoked")
            except Exception:
                pass
            self.remove(e.ws)
        return len(targets)

    async def _broadcast_presence(self) -> None:
        """Push the current peer list to every client on the 'presence' channel."""
        roster = [
            {"role": e.role, "label": e.label, "inviteId": e.invite_id}
            for e in self.entries
        ]
        msg = {
            "channel": "presence",
            "action": "update",
            "payload": {"sessionKey": self.session_key, "peers": roster},
            "sourceId": "_server",
            "timestamp": int(time.time() * 1000),
        }
        data = json.dumps(msg)
        disconnected = []
        for entry in self.entries:
            try:
                await entry.ws.send_text(data)
            except Exception:
                disconnected.append(entry.ws)
        for ws in disconnected:
            self.remove(ws)

    @property
    def is_empty(self) -> bool:
        return len(self.entries) == 0


class SyncConnectionManager:
    """Manages WebSocket sessions for state synchronization."""

    def __init__(self):
        self._sessions: dict[str, SyncSession] = {}
        # SSE subscribers — one Queue per connected frontend in single-window
        # desktop mode (no WebSocket sync session). The MCP bridge and the AI
        # chart endpoint push messages here as well as to WS clients.
        self._sse_queues: list[asyncio.Queue] = []
        self._seq = itertools.count(1)

    def generate_session_key(self) -> str:
        """Generate a short, URL-safe session key."""
        return secrets.token_urlsafe(8)

    def get_or_create_session(self, session_key: str) -> SyncSession:
        """Get an existing session or create a new one."""
        if session_key not in self._sessions:
            self._sessions[session_key] = SyncSession(session_key)
            logger.info("Created session '%s'", session_key)
        return self._sessions[session_key]

    def remove_session_if_empty(self, session_key: str) -> None:
        """Clean up a session if it has no more clients."""
        session = self._sessions.get(session_key)
        if session and session.is_empty:
            del self._sessions[session_key]
            logger.info("Removed empty session '%s'", session_key)

    def list_sessions(self) -> list[dict[str, Any]]:
        """List active sessions with client counts."""
        return [
            {
                "session_key": key,
                "client_count": len(session.clients),
            }
            for key, session in self._sessions.items()
        ]

    async def close_invite_clients(self, invite_id: str) -> int:
        """Force-close all guest clients tied to invite_id across every session."""
        total = 0
        for session in list(self._sessions.values()):
            total += await session.close_clients_by_invite(invite_id)
        return total

    async def inject_to_all(self, message: dict[str, Any]) -> int:
        """Broadcast a server-originated message to every connected WebSocket
        client across all sessions. No sender to exclude. Returns the number
        of clients that received the message."""
        data = json.dumps(message)
        sent = 0
        for session in list(self._sessions.values()):
            disconnected = []
            for entry in session.entries:
                try:
                    await entry.ws.send_text(data)
                    sent += 1
                except Exception:
                    disconnected.append(entry.ws)
            for ws in disconnected:
                session.remove(ws)
        return sent

    # -- SSE subscribers (single-window desktop bridge) --

    def add_sse_subscriber(self) -> asyncio.Queue:
        """Register an SSE subscriber and return its message queue."""
        queue: asyncio.Queue = asyncio.Queue()
        self._sse_queues.append(queue)
        return queue

    def remove_sse_subscriber(self, queue: asyncio.Queue) -> None:
        try:
            self._sse_queues.remove(queue)
        except ValueError:
            pass

    async def inject(self, channel: str, payload: dict[str, Any], action: str = "update") -> int:
        """Wrap a payload in a full stateBus envelope and deliver it to every
        connected client — WebSocket sync sessions AND SSE subscribers. This is
        the single entry point for server-originated bus messages (MCP control
        tools, AI-generated charts). Returns the total recipient count."""
        msg = {
            "channel": channel,
            "action": action,
            "payload": payload,
            "sourceId": "mcp",
            "timestamp": int(time.time() * 1000),
            "seq": next(self._seq),
            "force": True,
        }
        ws_sent = await self.inject_to_all(msg)
        for queue in list(self._sse_queues):
            await queue.put(msg)
        return ws_sent + len(self._sse_queues)


# Singleton manager
sync_manager = SyncConnectionManager()


# ---------------------------------------------------------------------------
# Short-lived WebSocket tickets
#
# Bun's "Give Control" flow mints a guest cookie + a one-shot ticket via
# `mintWsTicket`. Bun then registers `(ticket, session_key, invite_id, ttl)`
# with this store via POST /api/sync/ws-tickets. The WS handshake on
# /ws/sync/{session_key}?ticket=... consumes the ticket, validates the
# session match, and tags the client entry with role='guest'.
# ---------------------------------------------------------------------------


@dataclass
class _Ticket:
    session_key: str
    invite_id: str | None
    expires_at: float


class WsTicketStore:
    def __init__(self) -> None:
        self._tickets: dict[str, _Ticket] = {}

    def issue(self, ticket: str, session_key: str, invite_id: str | None, ttl_ms: int) -> None:
        self._tickets[ticket] = _Ticket(
            session_key=session_key,
            invite_id=invite_id,
            expires_at=time.monotonic() + (ttl_ms / 1000.0),
        )
        # Lazy cleanup of expired tickets — bounded sweep so we don't grow.
        self._sweep()

    def consume(self, ticket: str, session_key: str) -> _Ticket | None:
        t = self._tickets.pop(ticket, None)
        if not t:
            return None
        if t.expires_at < time.monotonic():
            return None
        if t.session_key != session_key:
            return None
        return t

    def _sweep(self) -> None:
        now = time.monotonic()
        expired = [k for k, v in self._tickets.items() if v.expires_at < now]
        for k in expired:
            self._tickets.pop(k, None)


ws_ticket_store = WsTicketStore()
