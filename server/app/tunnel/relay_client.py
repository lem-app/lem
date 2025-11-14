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

"""WebSocket relay client for tunneling agent fallback.

This module implements the relay client that connects to the relay server
when WebRTC P2P or TURN connections fail. It uses the same HTTP framing
protocol as the DataChannel implementation.
"""

import asyncio
import logging
from collections.abc import Callable
from enum import Enum

import aiohttp

from .http_proxy import HTTPProxyHandler
from .message_dispatcher import MessageDispatcher
from .router import create_router_with_client_discovery
from .ws_proxy import WSProxyHandler

logger = logging.getLogger(__name__)


class RelayConnectionState(str, Enum):
    """Relay connection states."""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    FAILED = "failed"
    CLOSED = "closed"


class RelayClient:
    """WebSocket relay client for HTTP tunneling.

    Connects to relay server and forwards HTTP frames over WebSocket
    when WebRTC P2P/TURN connections are unavailable.
    """

    def __init__(self, local_server_url: str = "http://localhost:5142") -> None:
        """Initialize the relay client.

        Args:
            local_server_url: Base URL of local Lem server to proxy to
        """
        self.relay_url: str | None = None
        self.session_id: str | None = None
        self.token: str | None = None

        # WebSocket connection
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.ws_session: aiohttp.ClientSession | None = None

        # Message dispatcher with HTTP and WebSocket proxies
        self.router = create_router_with_client_discovery(local_server_url)
        self.http_proxy: HTTPProxyHandler = HTTPProxyHandler(
            local_server_url, router=self.router
        )
        self.ws_proxy: WSProxyHandler = WSProxyHandler(self.router, self._send_frame)
        self.message_dispatcher: MessageDispatcher = MessageDispatcher(
            self.http_proxy, self.ws_proxy
        )

        # Connection state
        self.state: RelayConnectionState = RelayConnectionState.DISCONNECTED

        # Callbacks
        self.on_state_change: Callable[[RelayConnectionState], None] | None = None

        # Reconnection
        self.should_reconnect: bool = True
        self.reconnect_delay: float = 2.0
        self.max_reconnect_delay: float = 60.0

    async def connect(
        self,
        relay_url: str,
        session_id: str,
        token: str,
    ) -> None:
        """Connect to relay server via WebSocket.

        Args:
            relay_url: Base URL of relay server (e.g., ws://localhost:8001)
            session_id: Session identifier (shared between both clients)
            token: JWT access token for authentication

        Raises:
            RuntimeError: If connection fails
        """
        self.relay_url = relay_url
        self.session_id = session_id
        self.token = token

        await self._set_state(RelayConnectionState.CONNECTING)

        # Start proxy handlers
        await self.http_proxy.start()
        await self.ws_proxy.start()

        # Connect to relay server
        await self._connect_relay()

    async def disconnect(self) -> None:
        """Disconnect and clean up resources."""
        self.should_reconnect = False

        # Stop proxy handlers
        await self.http_proxy.stop()
        await self.ws_proxy.stop()

        # Close WebSocket
        if self.ws and not self.ws.closed:
            await self.ws.close()
            self.ws = None

        # Close session
        if self.ws_session and not self.ws_session.closed:
            await self.ws_session.close()
            self.ws_session = None

        await self._set_state(RelayConnectionState.DISCONNECTED)
        logger.info("RelayClient disconnected")

    async def send(self, data: bytes) -> None:
        """Send binary frame over WebSocket.

        Args:
            data: Binary frame to send

        Raises:
            RuntimeError: If WebSocket is not connected
        """
        if self.ws is None or self.ws.closed:
            raise RuntimeError("WebSocket not connected")

        await self.ws.send_bytes(data)
        logger.debug(f"Sent {len(data)} bytes over relay")

    def get_state(self) -> RelayConnectionState:
        """Get current connection state.

        Returns:
            Current RelayConnectionState
        """
        return self.state

    def is_connected(self) -> bool:
        """Check if connection is established.

        Returns:
            True if connected, False otherwise
        """
        return self.state == RelayConnectionState.CONNECTED

    async def _connect_relay(self) -> None:
        """Connect to relay server via WebSocket.

        Raises:
            RuntimeError: If connection parameters are not set
        """
        if not self.relay_url or not self.session_id or not self.token:
            raise RuntimeError("Connection parameters not set")

        # Close old session if exists
        if self.ws_session and not self.ws_session.closed:
            await self.ws_session.close()

        # Create WebSocket connection
        self.ws_session = aiohttp.ClientSession()

        # Build WebSocket URL: ws://localhost:8001/relay/{session_id}?token={jwt}
        ws_url = f"{self.relay_url}/relay/{self.session_id}?token={self.token}"

        try:
            self.ws = await self.ws_session.ws_connect(ws_url)
            logger.info(f"Connected to relay server: {ws_url}")

            await self._set_state(RelayConnectionState.CONNECTED)

            # Start message handling loop
            asyncio.create_task(self._handle_messages())

        except Exception as e:
            logger.error(f"Failed to connect to relay server: {e}")
            await self._set_state(RelayConnectionState.FAILED)
            raise

    async def _handle_messages(self) -> None:
        """Handle incoming WebSocket messages (binary HTTP frames)."""
        if self.ws is None:
            return

        try:
            async for msg in self.ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    # Binary message - dispatch to appropriate handler (HTTP or WebSocket)
                    logger.debug(f"Relay binary message: {len(msg.data)} bytes")
                    await self._handle_relay_message(msg.data)

                elif msg.type == aiohttp.WSMsgType.CLOSED:
                    logger.info("Relay WebSocket closed by server")
                    await self._set_state(RelayConnectionState.CLOSED)
                    if self.should_reconnect:
                        await self._handle_reconnect()
                    return

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    logger.error(f"Relay WebSocket error: {msg.data}")
                    await self._set_state(RelayConnectionState.FAILED)
                    if self.should_reconnect:
                        await self._handle_reconnect()
                    return

        except Exception as e:
            logger.error(f"Error handling relay messages: {e!r}")
            await self._set_state(RelayConnectionState.FAILED)
            if self.should_reconnect:
                await self._handle_reconnect()

    async def _handle_relay_message(self, data: bytes) -> None:
        """Handle incoming relay message (HTTP or WebSocket frame).

        Args:
            data: Binary frame (HTTP_REQUEST, WS_CONNECT, WS_DATA, WS_CLOSE)
        """
        try:
            # Dispatch message to appropriate handler (same as DataChannel)
            response_data = await self.message_dispatcher.dispatch(data)

            # Send response back if provided (HTTP responses only)
            if response_data:
                await self.send(response_data)

        except Exception as e:
            logger.error(f"Error handling relay message: {e}")

    async def _send_frame(self, data: bytes) -> None:
        """Send frame back over WebSocket (used by WebSocket proxy).

        Args:
            data: Binary frame to send
        """
        if self.ws and not self.ws.closed:
            await self.send(data)
        else:
            logger.warning("Cannot send frame: WebSocket not open")

    async def _set_state(self, state: RelayConnectionState) -> None:
        """Update connection state and notify callback.

        Args:
            state: New connection state
        """
        if self.state != state:
            old_state = self.state
            self.state = state
            logger.info(f"RelayClient state change: {old_state} → {state}")

            if self.on_state_change:
                self.on_state_change(state)

    async def _handle_reconnect(self, immediate: bool = False) -> None:
        """Handle reconnection logic with exponential backoff.

        Args:
            immediate: If True, skip the reconnect delay
        """
        if not self.should_reconnect:
            return

        if not immediate:
            logger.info(f"Attempting relay reconnect in {self.reconnect_delay}s...")
            await asyncio.sleep(self.reconnect_delay)
            # Exponential backoff
            self.reconnect_delay = min(self.reconnect_delay * 2, self.max_reconnect_delay)
        else:
            logger.info("Attempting immediate relay reconnect...")

        try:
            await self._reconnect_full()

            # Reset delay on successful reconnect
            self.reconnect_delay = 2.0
        except Exception as e:
            logger.error(f"Relay reconnect failed: {e}")
            await self._handle_reconnect(immediate=False)

    async def _reconnect_full(self) -> None:
        """Reconnect to relay server.

        Creates a new WebSocket connection to the relay server.
        """
        if not self.relay_url or not self.session_id or not self.token:
            raise RuntimeError("Connection parameters not set")

        # Close old WebSocket if exists
        if self.ws and not self.ws.closed:
            try:
                await self.ws.close()
            except Exception as e:
                logger.warning(f"Error closing old WebSocket: {e}")
            self.ws = None

        # Close old session
        if self.ws_session and not self.ws_session.closed:
            try:
                await self.ws_session.close()
            except Exception as e:
                logger.warning(f"Error closing old session: {e}")
            self.ws_session = None

        # Reconnect to relay server
        await self._connect_relay()

        logger.info("Relay reconnection complete")
