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

"""Session manager for WebSocket relay pairs."""

import asyncio
import json
import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class RelaySession:
    """Manages a single relay session with two WebSocket connections."""

    def __init__(self, session_id: str) -> None:
        """Initialize relay session.

        Args:
            session_id: Unique session identifier.
        """
        self.session_id = session_id
        self.client_ws: WebSocket | None = None
        self.server_ws: WebSocket | None = None
        self.created_at = datetime.now(UTC)
        self.bytes_client_to_server = 0
        self.bytes_server_to_client = 0
        self._forward_tasks: list[asyncio.Task[None]] = []
        self._closed = False
        self._forwarding_started = False

    def add_connection(self, websocket: WebSocket) -> bool:
        """Add a WebSocket connection to this session.

        Args:
            websocket: WebSocket to add.

        Returns:
            True if both sides are now connected, False if waiting for second connection.
        """
        if self.client_ws is None:
            self.client_ws = websocket
            logger.info(f"Session {self.session_id}: First connection joined (client)")
            return False
        elif self.server_ws is None:
            self.server_ws = websocket
            logger.info(f"Session {self.session_id}: Second connection joined (server)")
            return True
        else:
            # Session already has two connections
            return False

    def is_ready(self) -> bool:
        """Check if both connections are present.

        Returns:
            True if both client and server are connected.
        """
        return self.client_ws is not None and self.server_ws is not None

    async def start_forwarding(self, is_second_connection: bool) -> None:
        """Start bidirectional frame forwarding between the two WebSockets.

        Args:
            is_second_connection: True if this is the second connection joining.
        """
        # If this is the first connection, wait for the second
        if not is_second_connection:
            logger.info(f"Session {self.session_id}: Waiting for second connection...")
            while not self.is_ready():
                await asyncio.sleep(1)

        # Wait if not ready yet
        while not self.is_ready():
            await asyncio.sleep(0.1)

        # Prevent multiple forwarding tasks
        if self._forwarding_started:
            # If forwarding already started, wait for it to complete
            while not self._closed:
                await asyncio.sleep(1)
            return

        self._forwarding_started = True
        logger.info(f"Session {self.session_id}: Starting bidirectional forwarding")

        # Create forwarding tasks
        self._forward_tasks = [
            asyncio.create_task(self._forward(self.client_ws, self.server_ws, "client->server")),
            asyncio.create_task(self._forward(self.server_ws, self.client_ws, "server->client")),
        ]

        # Wait for either task to complete (connection closed)
        done, pending = await asyncio.wait(
            self._forward_tasks, return_when=asyncio.FIRST_COMPLETED
        )

        # Cancel remaining tasks
        for task in pending:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        # Log session stats
        self._log_session_stats()

    async def _forward(
        self, source: WebSocket | None, dest: WebSocket | None, direction: str
    ) -> None:
        """Forward frames from source to destination WebSocket.

        Args:
            source: Source WebSocket.
            dest: Destination WebSocket.
            direction: Human-readable direction for logging.
        """
        if source is None or dest is None:
            return

        try:
            while True:
                # Receive frame from source
                data = await source.receive_bytes()

                # Update byte counter
                byte_count = len(data)
                if direction == "client->server":
                    self.bytes_client_to_server += byte_count
                else:
                    self.bytes_server_to_client += byte_count

                # Forward to destination
                await dest.send_bytes(data)

        except Exception as e:
            logger.info(f"Session {self.session_id}: {direction} connection closed: {e}")
        finally:
            await self.close()

    async def close(self) -> None:
        """Close both WebSocket connections and clean up."""
        if self._closed:
            return

        self._closed = True
        logger.info(f"Session {self.session_id}: Closing session")

        # Close both WebSockets
        for ws, name in [(self.client_ws, "client"), (self.server_ws, "server")]:
            if ws is not None:
                try:
                    await ws.close()
                except Exception as e:
                    logger.debug(f"Error closing {name} WebSocket: {e}")

        # Cancel any pending forward tasks
        for task in self._forward_tasks:
            if not task.done():
                task.cancel()

        self._log_session_stats()

    def _log_session_stats(self) -> None:
        """Log session statistics as JSON for metering."""
        duration = (datetime.now(UTC) - self.created_at).total_seconds()
        stats: dict[str, Any] = {
            "event": "session_closed",
            "session_id": self.session_id,
            "duration_seconds": duration,
            "bytes_client_to_server": self.bytes_client_to_server,
            "bytes_server_to_client": self.bytes_server_to_client,
            "total_bytes": self.bytes_client_to_server + self.bytes_server_to_client,
            "timestamp": datetime.now(UTC).isoformat(),
        }
        # Log as JSON for future metering/billing
        print(json.dumps(stats))


class SessionManager:
    """Manages all active relay sessions."""

    def __init__(self) -> None:
        """Initialize session manager."""
        self._sessions: dict[str, RelaySession] = {}
        self._lock = asyncio.Lock()

    async def get_or_create_session(self, session_id: str) -> RelaySession:
        """Get or create a relay session.

        Args:
            session_id: Session identifier.

        Returns:
            RelaySession instance.
        """
        async with self._lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = RelaySession(session_id)
                logger.info(f"Created new session: {session_id}")
            return self._sessions[session_id]

    async def remove_session(self, session_id: str) -> None:
        """Remove a session from the manager.

        Args:
            session_id: Session identifier.
        """
        async with self._lock:
            if session_id in self._sessions:
                session = self._sessions[session_id]
                await session.close()
                del self._sessions[session_id]
                logger.info(f"Removed session: {session_id}")

    def get_session_count(self) -> int:
        """Get the number of active sessions.

        Returns:
            Number of active sessions.
        """
        return len(self._sessions)


# Global session manager instance
session_manager = SessionManager()
