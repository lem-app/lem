# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2025 Lem
#
# This file is part of Lem.
#
# Lem is free software: you can redistribute it and/or modify it under
# the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# Lem is distributed in the hope that it will be useful, but WITHOUT
# ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
# or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
# Public License for more details.

"""Session manager for WebSocket relay pairs.

A session pairs exactly two devices, both named in the signed grant each side
presents. Previously a session paired whichever two sockets happened to arrive
at the same URL first, which is what let an unrelated account join someone
else's tunnel and both read and inject traffic.
"""

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket, status

from .config import settings
from .security import SessionGrant

logger = logging.getLogger(__name__)

# Session accounting is emitted here rather than to stdout so operators can
# route, filter and ship it like any other log stream. Note that nothing yet
# *enforces* a quota on these numbers; they are accounting only.
metering_logger = logging.getLogger("lem.relay.metering")

# How often a lone connection re-checks whether its peer has arrived while
# also watching for its own disconnect.
_PAIR_POLL_SECONDS = 0.25


class JoinRejectedError(Exception):
    """Raised when a connection may not join the session it asked for."""

    def __init__(self, reason: str, code: int = status.WS_1008_POLICY_VIOLATION) -> None:
        """Initialize the rejection.

        Args:
            reason: Human-readable reason, safe to send to the client.
            code: WebSocket close code to use.
        """
        super().__init__(reason)
        self.reason = reason
        self.code = code


@dataclass
class RelayConnection:
    """One authenticated side of a relay session."""

    grant: SessionGrant
    websocket: WebSocket
    # Frames received before the peer arrived, flushed on pairing so that a
    # client which sends immediately after connecting does not lose data.
    pending: list[bytes] = field(default_factory=list)
    pending_bytes: int = 0

    @property
    def device_id(self) -> str:
        """Device this connection authenticated as.

        Returns:
            The device identifier from the grant.
        """
        return self.grant.device_id


class RelaySession:
    """Manages a single relay session between two authenticated devices."""

    def __init__(self, session_id: str, user_id: int, device_pair: frozenset[str]) -> None:
        """Initialize relay session.

        Args:
            session_id: Unique session identifier.
            user_id: Owner of both devices.
            device_pair: The only two device ids permitted in this session.
        """
        self.session_id = session_id
        self.user_id = user_id
        self.device_pair = device_pair
        self.created_at = datetime.now(UTC)
        self.bytes_forwarded: dict[str, int] = {}
        self._connections: dict[str, RelayConnection] = {}
        self._redeemed_jti: set[str] = set()
        self._closed = False
        self._stats_logged = False

    @property
    def is_paired(self) -> bool:
        """Whether both devices are connected.

        Returns:
            True if two connections are present.
        """
        return len(self._connections) == 2

    def join(self, grant: SessionGrant, websocket: WebSocket) -> RelayConnection:
        """Admit a connection to this session.

        Args:
            grant: Verified grant presented by the connecting client.
            websocket: The accepted WebSocket.

        Returns:
            The connection record for the joined client.

        Raises:
            JoinRejectedError: If the grant does not authorize this session slot.
        """
        if self._closed:
            raise JoinRejectedError("Session is closed")

        # Every grant for a session must describe the same user and the same
        # pair of devices. A grant minted for some other conversation cannot
        # be redirected into this one.
        if grant.user_id != self.user_id or grant.device_pair != self.device_pair:
            raise JoinRejectedError("Grant does not match this session")

        if grant.jti in self._redeemed_jti:
            raise JoinRejectedError("Grant has already been used")

        if grant.device_id in self._connections:
            raise JoinRejectedError("Device is already connected to this session")

        # A session has exactly two sides. A third socket used to park in a
        # sleep loop forever; it is now refused outright.
        if self.is_paired:
            raise JoinRejectedError("Session already has two connections")

        connection = RelayConnection(grant=grant, websocket=websocket)
        self._redeemed_jti.add(grant.jti)
        self._connections[grant.device_id] = connection
        logger.info(
            f"Session {self.session_id}: device {grant.device_id} joined "
            f"({len(self._connections)}/2)"
        )
        return connection

    def peer_of(self, connection: RelayConnection) -> RelayConnection | None:
        """Find the other side of the session.

        Args:
            connection: One side of the session.

        Returns:
            The peer connection, or None if it has not joined.
        """
        for device_id, candidate in self._connections.items():
            if device_id != connection.device_id:
                return candidate
        return None

    async def run(self, connection: RelayConnection) -> None:
        """Wait for the peer, then forward this connection's frames to it.

        Both sides run this concurrently, each pumping its own receive
        direction, so no side ever blocks without also watching its socket.

        Args:
            connection: The connection this handler owns.
        """
        if not await self._await_peer(connection):
            await self.close()
            return

        peer = self.peer_of(connection)
        if peer is None:  # pragma: no cover - is_paired guarantees a peer
            await self.close()
            return

        try:
            # Flush anything that arrived while we were waiting to be paired.
            # These count towards accounting like any other relayed frame.
            for frame in connection.pending:
                self._record(connection, len(frame))
                await peer.websocket.send_bytes(frame)
            connection.pending.clear()
            connection.pending_bytes = 0

            while True:
                data = await asyncio.wait_for(
                    connection.websocket.receive_bytes(), timeout=settings.session_timeout
                )
                self._record(connection, len(data))
                await peer.websocket.send_bytes(data)
        except TimeoutError:
            logger.info(
                f"Session {self.session_id}: idle for {settings.session_timeout}s, closing"
            )
        except Exception as e:
            logger.info(f"Session {self.session_id}: {connection.device_id} closed: {e}")
        finally:
            await self.close()

    async def _await_peer(self, connection: RelayConnection) -> bool:
        """Wait for the second device, buffering early frames.

        The previous implementation slept in a loop with no timeout and no
        receive, so a peer that never arrived leaked the session forever and a
        client that hung up was never noticed. This polls the socket instead,
        so both the timeout and the disconnect are observed.

        Args:
            connection: The waiting connection.

        Returns:
            True once paired, False if the wait timed out or the client left.
        """
        if self.is_paired:
            return True

        logger.info(f"Session {self.session_id}: waiting for peer")
        deadline = time.monotonic() + settings.pair_timeout

        while not self.is_paired:
            if self._closed:
                return False

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                logger.info(
                    f"Session {self.session_id}: peer did not join within "
                    f"{settings.pair_timeout}s, abandoning"
                )
                return False

            try:
                message = await asyncio.wait_for(
                    connection.websocket.receive(),
                    timeout=min(remaining, _PAIR_POLL_SECONDS),
                )
            except TimeoutError:
                continue

            if message.get("type") == "websocket.disconnect":
                logger.info(
                    f"Session {self.session_id}: {connection.device_id} left before pairing"
                )
                return False

            data = message.get("bytes")
            if data is None:
                # Text frames before pairing carry no tunnel payload.
                continue

            connection.pending.append(data)
            connection.pending_bytes += len(data)
            if connection.pending_bytes > settings.max_prepair_buffer_bytes:
                logger.warning(
                    f"Session {self.session_id}: {connection.device_id} buffered "
                    f"{connection.pending_bytes} bytes before pairing, closing"
                )
                return False

        return True

    def _record(self, connection: RelayConnection, byte_count: int) -> None:
        """Count bytes forwarded from one device.

        Args:
            connection: Sender of the frames.
            byte_count: Number of bytes forwarded.
        """
        self.bytes_forwarded[connection.device_id] = (
            self.bytes_forwarded.get(connection.device_id, 0) + byte_count
        )

    async def close(self) -> None:
        """Close both WebSocket connections and log accounting once."""
        if self._closed:
            return

        self._closed = True
        logger.info(f"Session {self.session_id}: Closing session")

        # Emit accounting before the first await. Tearing a session down often
        # coincides with the handler task being cancelled, and CancelledError
        # is not an Exception, so anything after an await here can be skipped.
        self._log_session_stats()

        for connection in list(self._connections.values()):
            try:
                await connection.websocket.close()
            except Exception as e:
                logger.debug(f"Error closing {connection.device_id} WebSocket: {e}")

    def _log_session_stats(self) -> None:
        """Emit session statistics as JSON for metering."""
        if self._stats_logged:
            return
        self._stats_logged = True

        duration = (datetime.now(UTC) - self.created_at).total_seconds()
        stats: dict[str, Any] = {
            "event": "session_closed",
            "session_id": self.session_id,
            "user_id": self.user_id,
            "devices": sorted(self.device_pair),
            "duration_seconds": duration,
            "bytes_by_device": self.bytes_forwarded,
            "total_bytes": sum(self.bytes_forwarded.values()),
            "timestamp": datetime.now(UTC).isoformat(),
        }
        metering_logger.info(json.dumps(stats))


class SessionManager:
    """Manages all active relay sessions."""

    def __init__(self) -> None:
        """Initialize session manager."""
        self._sessions: dict[str, RelaySession] = {}
        self._lock = asyncio.Lock()

    async def join(
        self, session_id: str, grant: SessionGrant, websocket: WebSocket
    ) -> tuple[RelaySession, RelayConnection]:
        """Create or join the session named by a verified grant.

        Args:
            session_id: Session identifier from the request path.
            grant: Verified grant presented by the client.
            websocket: The accepted WebSocket.

        Returns:
            Tuple of (session, this client's connection).

        Raises:
            JoinRejectedError: If the session is full, capped, or not the caller's.
        """
        async with self._lock:
            session = self._sessions.get(session_id)

            if session is None:
                if len(self._sessions) >= settings.max_sessions:
                    raise JoinRejectedError(
                        "Relay is at capacity", code=status.WS_1013_TRY_AGAIN_LATER
                    )
                if self._user_session_count(grant.user_id) >= settings.max_sessions_per_user:
                    raise JoinRejectedError(
                        "Too many concurrent relay sessions for this account",
                        code=status.WS_1013_TRY_AGAIN_LATER,
                    )
                session = RelaySession(session_id, grant.user_id, grant.device_pair)
                self._sessions[session_id] = session
                logger.info(f"Created session {session_id} for user {grant.user_id}")

            connection = session.join(grant, websocket)
            return session, connection

    async def leave(self, session_id: str, session: RelaySession) -> None:
        """Close a session and drop it from the registry.

        Args:
            session_id: Session identifier.
            session: The session being torn down.
        """
        async with self._lock:
            if self._sessions.get(session_id) is session:
                del self._sessions[session_id]
                logger.info(f"Removed session: {session_id}")
        await session.close()

    def get_session_count(self) -> int:
        """Get the number of active sessions.

        Returns:
            Number of active sessions.
        """
        return len(self._sessions)

    def _user_session_count(self, user_id: int) -> int:
        """Count a user's active sessions.

        Args:
            user_id: User to count sessions for.

        Returns:
            Number of sessions owned by the user.
        """
        return sum(1 for session in self._sessions.values() if session.user_id == user_id)

    def reset(self) -> None:
        """Drop all sessions without closing them. Used by tests."""
        self._sessions.clear()


# Global session manager instance. One per worker process: there is no shared
# store, which is why the deployment units run a single worker.
session_manager = SessionManager()
