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
import json
import logging
from collections.abc import Callable
from enum import Enum

import aiohttp

from .http_proxy import HTTPProxyHandler
from .message_dispatcher import MessageDispatcher
from .router import create_router_with_client_discovery
from .ws_proxy import WSProxyHandler

logger = logging.getLogger(__name__)

# Reason codes the relay puts on ``{"type": "error"}`` frames. The authority is
# ``cloud/relay/app/core/errors.py``; this is the subset a client must branch
# on. A retryable rejection means the same request may succeed later, unchanged
# - backing off is correct and disabling reconnection is not.
RETRYABLE_RELAY_REASONS = frozenset({"relay-at-capacity", "account-session-limit"})

# Reasons whose cure is new credentials, as opposed to a different request.
AUTH_RELAY_REASONS = frozenset({"auth-failed", "grant-already-used", "session-mismatch"})

# Close codes the relay uses. 1013 is "try again later"; 1008 is a policy
# rejection. The error frame is authoritative, but the socket may drop before
# it arrives, so the close code is the fallback classifier.
WS_POLICY_VIOLATION = 1008
WS_TRY_AGAIN_LATER = 1013


class RelayRejection:
    """A classified rejection from the relay.

    ``retryable`` is read from the frame, not inferred from the close code:
    the relay sends the two independently and the frame arrives first.
    """

    def __init__(self, reason: str, message: str, retryable: bool) -> None:
        """Initialize the rejection.

        Args:
            reason: Machine-readable reason code from the relay
            message: Human-readable message from the relay
            retryable: Whether reconnecting later could succeed
        """
        self.reason = reason
        self.message = message
        self.retryable = retryable

    def describe(self) -> str:
        """Build an operator-facing description.

        Returns:
            One line naming the cure, not just the failure
        """
        if self.retryable:
            return (
                f"Relay is temporarily unavailable ({self.reason or 'unknown reason'}): "
                f"{self.message or 'try again shortly'}. Retrying with backoff."
            )
        if self.reason in AUTH_RELAY_REASONS or not self.reason:
            return (
                f"Relay rejected our credentials ({self.reason or 'unknown reason'}): "
                f"{self.message or 'authentication failed'}. Re-authentication is required."
            )
        return (
            f"Relay refused the connection ({self.reason}): "
            f"{self.message or 'no message'}. Retrying will not help."
        )


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
            local_server_url,
            router=self.router,
            send_frame=self._send_frame,
            close_channel=self._close_channel,
        )
        self.ws_proxy: WSProxyHandler = WSProxyHandler(self.router, self._send_frame)
        self.message_dispatcher: MessageDispatcher = MessageDispatcher(
            self.http_proxy,
            self.ws_proxy,
            send_frame=self._send_frame,
            close_channel=self._close_channel,
        )

        # Connection state
        self.state: RelayConnectionState = RelayConnectionState.DISCONNECTED

        # Last classified rejection, kept so the close path does not re-decide
        # what the error frame already settled.
        self.last_rejection: RelayRejection | None = None

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

        # An explicit connect() is a fresh decision by the caller: a terminal
        # rejection from a previous attempt must not disable this one.
        self.should_reconnect = True
        self.last_rejection = None

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

        # Create WebSocket connection (without token in URL for security)
        self.ws_session = aiohttp.ClientSession()
        ws_url = f"{self.relay_url}/relay/{self.session_id}"

        try:
            self.ws = await self.ws_session.ws_connect(ws_url)

            # Send auth message instead of passing token in URL
            auth_message = json.dumps({"type": "auth", "token": self.token})
            await self.ws.send_str(auth_message)
            logger.info(f"Connected to relay server: {ws_url}")

            await self._set_state(RelayConnectionState.CONNECTED)

            # HELLO is the first frame on a newly opened channel, before any
            # other traffic (spec section 5.8).
            await self.message_dispatcher.begin_negotiation()

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

                elif msg.type == aiohttp.WSMsgType.TEXT:
                    # Control frame. A terminal rejection stops reconnection;
                    # a retryable one must not, or a busy relay permanently
                    # disables the fallback path for the session.
                    if self._handle_control_message(msg.data):
                        await self._set_state(RelayConnectionState.FAILED)
                        return

                elif msg.type == aiohttp.WSMsgType.CLOSED:
                    logger.info("Relay WebSocket closed by server")
                    self._apply_close_code()
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

            # The iterator also ends without a CLOSED message when the peer
            # closes cleanly; the close code is only readable here.
            self._apply_close_code()
            await self._set_state(RelayConnectionState.CLOSED)
            if self.should_reconnect:
                await self._handle_reconnect()

        except Exception as e:
            logger.error(f"Error handling relay messages: {e!r}")
            await self._set_state(RelayConnectionState.FAILED)
            if self.should_reconnect:
                await self._handle_reconnect()

    def _handle_control_message(self, raw: str) -> bool:
        """Classify a JSON control frame from the relay.

        The relay sends ``reason`` and ``retryable`` on every error frame
        precisely so a client does not have to infer permanence from a close
        code that arrives separately and may never arrive at all.

        Args:
            raw: Text frame payload

        Returns:
            True if the rejection is terminal and reconnection must stop
        """
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("Ignoring non-JSON relay control frame")
            return False

        if not isinstance(parsed, dict) or parsed.get("type") != "error":
            return False

        reason = parsed.get("reason")
        message = parsed.get("message")
        retryable_field = parsed.get("retryable")

        reason_str = reason if isinstance(reason, str) else ""
        # Trust the explicit boolean; fall back to the known reason set only
        # when a relay omits it.
        retryable = (
            retryable_field
            if isinstance(retryable_field, bool)
            else reason_str in RETRYABLE_RELAY_REASONS
        )

        rejection = RelayRejection(
            reason=reason_str,
            message=message if isinstance(message, str) else "",
            retryable=retryable,
        )
        self.last_rejection = rejection

        if rejection.retryable:
            logger.warning(rejection.describe())
            return False

        logger.error(rejection.describe())
        self.should_reconnect = False
        return True

    def _apply_close_code(self) -> None:
        """Classify a close that arrived without an error frame.

        Only used as a fallback: if the relay already told us on the frame, its
        answer stands. 1008 is a policy rejection that a retry cannot fix; 1013
        explicitly means "try again later" and must keep reconnection alive.
        """
        if self.last_rejection is not None:
            return

        close_code = self.ws.close_code if self.ws is not None else None
        if close_code == WS_POLICY_VIOLATION:
            logger.error(
                "Relay closed the connection with 1008 (policy violation) and no error frame. "
                "Re-authentication is required; not reconnecting."
            )
            self.should_reconnect = False
        elif close_code == WS_TRY_AGAIN_LATER:
            logger.warning(
                "Relay closed the connection with 1013 (try again later). Retrying with backoff."
            )

    async def _handle_relay_message(self, data: bytes) -> None:
        """Handle incoming relay message (HTTP or WebSocket frame).

        Args:
            data: Binary frame (HTTP_REQUEST, WS_CONNECT, WS_DATA, WS_CLOSE)
        """
        try:
            # v3 handlers emit their own frames through _send_frame; the
            # dispatcher no longer returns a response blob to forward.
            await self.message_dispatcher.dispatch(data)

        except Exception as e:
            logger.error(f"Error handling relay message: {e}")

    async def _close_channel(self, code: int, reason: str) -> None:
        """Close the relay connection after a peer-behaviour violation.

        Args:
            code: Close code (WebSocket space)
            reason: Generic reason, logged locally
        """
        logger.error(f"Closing relay channel: {code} {reason}")
        self.should_reconnect = False
        if self.ws and not self.ws.closed:
            await self.ws.close(code=code)

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
