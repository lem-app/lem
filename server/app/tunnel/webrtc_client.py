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

"""WebRTC client for tunneling agent.

This module implements the local server's WebRTC client that connects to the
signaling server and establishes peer-to-peer DataChannels for HTTP proxying.
"""

import asyncio
import json
import logging
from collections.abc import Callable
from enum import Enum
from typing import Any

import aiohttp
from aiortc import (
    RTCConfiguration,
    RTCDataChannel,
    RTCIceCandidate,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.sdp import candidate_from_sdp, candidate_to_sdp

from .http_proxy import HTTPProxyHandler
from .message_dispatcher import MessageDispatcher
from .relay_client import RelayClient, RelayConnectionState
from .router import create_router_with_client_discovery
from .ws_proxy import WSProxyHandler

logger = logging.getLogger(__name__)


class ConnectionState(str, Enum):
    """WebRTC connection states."""

    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    FAILED = "failed"
    CLOSED = "closed"


class TunnelAgent:
    """WebRTC tunneling agent for remote access.

    Manages WebSocket signaling connection, RTCPeerConnection setup,
    ICE candidate gathering, and DataChannel for HTTP proxying.
    """

    def __init__(
        self,
        local_server_url: str = "http://localhost:5142",
        relay_url: str = "ws://localhost:8001",
    ) -> None:
        """Initialize the tunnel agent.

        Args:
            local_server_url: Base URL of local Lem server to proxy to
            relay_url: Base URL of relay server for WebSocket fallback
        """
        self.signal_url: str | None = None
        self.device_id: str | None = None
        self.token: str | None = None
        self.target_device_id: str | None = None
        self.peer_device_id: str | None = None  # Device we're connected to (for responder)

        # WebSocket connection for signaling
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.ws_session: aiohttp.ClientSession | None = None

        # WebRTC peer connection
        self.pc: RTCPeerConnection | None = None
        self.data_channel: RTCDataChannel | None = None

        # ICE servers configuration (preserved across reconnections)
        self.ice_servers: list[dict[str, Any]] = []

        # Relay client for WebSocket fallback
        self.relay_url: str = relay_url
        self.relay_client: RelayClient | None = None

        # Connection mode tracking
        self.connection_mode: str = "webrtc"  # "webrtc" or "relay"
        self.webrtc_attempts: int = 0
        self.max_webrtc_attempts: int = 3  # Try WebRTC 3 times before falling back to relay
        self.webrtc_timeout: float = 15.0  # Wait 15 seconds for WebRTC before trying relay

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
        self.state: ConnectionState = ConnectionState.DISCONNECTED
        self.ice_gathering_complete: asyncio.Event = asyncio.Event()

        # Callbacks
        self.on_data_channel_message: Callable[[str | bytes], None] | None = None
        self.on_state_change: Callable[[ConnectionState], None] | None = None

        # Reconnection
        self.should_reconnect: bool = True
        self.reconnect_delay: float = 2.0
        self.max_reconnect_delay: float = 60.0

    async def connect(
        self,
        signal_url: str,
        device_id: str,
        token: str,
        target_device_id: str | None = None,
        ice_servers: list[dict[str, Any]] | None = None,
    ) -> None:
        """Connect to signaling server and establish WebRTC connection.

        Args:
            signal_url: WebSocket URL for signaling server (e.g., ws://localhost:8000/signal)
            device_id: Local device identifier
            token: JWT access token for authentication
            target_device_id: Target device to connect to (for browser client)
            ice_servers: ICE servers configuration (STUN/TURN)
        """
        self.signal_url = signal_url
        self.device_id = device_id
        self.token = token
        self.target_device_id = target_device_id

        # Default ICE servers (STUN only for now)
        if ice_servers is None:
            ice_servers = [{"urls": "stun:stun.l.google.com:19302"}]

        # Store ICE servers for reconnection
        self.ice_servers = ice_servers

        # Create RTCPeerConnection
        ice_server_configs = [
            RTCIceServer(urls=server["urls"])
            if "username" not in server
            else RTCIceServer(
                urls=server["urls"],
                username=server.get("username", ""),
                credential=server.get("credential", ""),
            )
            for server in ice_servers
        ]

        config = RTCConfiguration(iceServers=ice_server_configs)
        self.pc = RTCPeerConnection(configuration=config)

        # Set up connection state callbacks
        @self.pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            """Handle connection state changes."""
            if self.pc is None:
                return

            logger.info(f"Connection state: {self.pc.connectionState}")

            if self.pc.connectionState == "connected":
                await self._set_state(ConnectionState.CONNECTED)
            elif self.pc.connectionState == "failed":
                await self._set_state(ConnectionState.FAILED)
                await self._handle_reconnect()
            elif self.pc.connectionState == "closed":
                await self._set_state(ConnectionState.CLOSED)
                # Reset WebRTC state immediately so we're ready for new offers
                # This handles explicit disconnects (browser closes connection)
                await self._handle_reconnect()

        @self.pc.on("icecandidate")
        async def on_icecandidate(candidate: RTCIceCandidate | None) -> None:
            """Handle ICE candidate gathering."""
            if candidate is None:
                # ICE gathering complete
                self.ice_gathering_complete.set()
                logger.info("ICE gathering complete")
            else:
                # Send ICE candidate to peer via signaling
                # Use peer_device_id (responder) or target_device_id (initiator)
                target = self.peer_device_id or self.target_device_id
                if target:
                    candidate_sdp = candidate_to_sdp(candidate)
                    await self._send_signaling_message(
                        {
                            "type": "ice-candidate",
                            "target_device_id": target,
                            "payload": {
                                "candidate": candidate_sdp,
                                "sdpMid": candidate.sdpMid,
                                "sdpMLineIndex": candidate.sdpMLineIndex,
                            },
                        }
                    )
                    logger.debug(f"Sent ICE candidate to {target}")

        @self.pc.on("datachannel")
        def on_datachannel(channel: RTCDataChannel) -> None:
            """Handle incoming DataChannel (for answering peer)."""
            logger.info(f"DataChannel received: {channel.label}")
            self._setup_data_channel(channel)

        # Start proxy handlers
        await self.http_proxy.start()
        await self.ws_proxy.start()

        # Connect to signaling server
        await self._connect_signaling()

    async def create_data_channel(self, label: str = "http-proxy") -> RTCDataChannel:
        """Create a DataChannel for HTTP proxying.

        Args:
            label: DataChannel label

        Returns:
            RTCDataChannel instance

        Raises:
            RuntimeError: If peer connection is not initialized
        """
        if self.pc is None:
            raise RuntimeError("Peer connection not initialized")

        channel = self.pc.createDataChannel(label)
        self._setup_data_channel(channel)
        return channel

    def _setup_data_channel(self, channel: RTCDataChannel) -> None:
        """Set up DataChannel event handlers.

        Args:
            channel: RTCDataChannel to configure
        """
        self.data_channel = channel

        @channel.on("open")
        def on_open() -> None:
            """Handle DataChannel open event."""
            logger.info(f"DataChannel '{channel.label}' opened")

        @channel.on("close")
        def on_close() -> None:
            """Handle DataChannel close event."""
            logger.info(f"DataChannel '{channel.label}' closed")

        @channel.on("message")
        def on_message(message: str | bytes) -> None:
            """Handle DataChannel messages.

            Args:
                message: Received message (text or binary)
            """
            if isinstance(message, bytes):
                # Binary message - dispatch to appropriate handler (HTTP or WebSocket)
                logger.debug(f"DataChannel binary message: {len(message)} bytes")
                asyncio.create_task(self._handle_datachannel_message(message))
            else:
                # Text message - pass to callback
                logger.debug(f"DataChannel text message: {message[:100]}...")
                if self.on_data_channel_message:
                    self.on_data_channel_message(message)

    async def create_offer(self) -> RTCSessionDescription:
        """Create SDP offer.

        Returns:
            RTCSessionDescription offer

        Raises:
            RuntimeError: If peer connection is not initialized
        """
        if self.pc is None:
            raise RuntimeError("Peer connection not initialized")

        offer = await self.pc.createOffer()
        await self.pc.setLocalDescription(offer)

        # Don't wait for ICE gathering - use Trickle ICE
        # Candidates will be sent separately via icecandidate events
        logger.info("Created SDP offer (Trickle ICE enabled)")
        return offer

    async def create_answer(self, offer: RTCSessionDescription) -> RTCSessionDescription:
        """Create SDP answer for received offer.

        Args:
            offer: Remote SDP offer

        Returns:
            RTCSessionDescription answer

        Raises:
            RuntimeError: If peer connection is not initialized
        """
        if self.pc is None:
            raise RuntimeError("Peer connection not initialized")

        await self.pc.setRemoteDescription(offer)
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)

        # Don't wait for ICE gathering - use Trickle ICE
        # Candidates will be sent separately via icecandidate events
        logger.info("Created SDP answer (Trickle ICE enabled)")
        return answer

    async def set_remote_description(self, sdp: RTCSessionDescription) -> None:
        """Set remote SDP description.

        Args:
            sdp: Remote session description

        Raises:
            RuntimeError: If peer connection is not initialized
        """
        if self.pc is None:
            raise RuntimeError("Peer connection not initialized")

        await self.pc.setRemoteDescription(sdp)
        logger.info(f"Set remote description: {sdp.type}")

    async def add_ice_candidate(self, candidate_dict: dict[str, Any]) -> None:
        """Add remote ICE candidate.

        Args:
            candidate_dict: ICE candidate data with 'candidate' SDP string

        Raises:
            RuntimeError: If peer connection is not initialized
        """
        if self.pc is None:
            raise RuntimeError("Peer connection not initialized")

        # Parse candidate from SDP string
        candidate_sdp = candidate_dict["candidate"]
        candidate = candidate_from_sdp(candidate_sdp)

        # Set sdpMid and sdpMLineIndex from dict
        candidate.sdpMid = candidate_dict.get("sdpMid")
        candidate.sdpMLineIndex = candidate_dict.get("sdpMLineIndex")

        await self.pc.addIceCandidate(candidate)
        logger.debug("Added ICE candidate")

    async def send_data(self, data: str) -> None:
        """Send data over DataChannel.

        Args:
            data: Data to send

        Raises:
            RuntimeError: If DataChannel is not open
        """
        if self.data_channel is None or self.data_channel.readyState != "open":
            raise RuntimeError("DataChannel not open")

        self.data_channel.send(data)

    async def disconnect(self) -> None:
        """Disconnect and clean up resources."""
        self.should_reconnect = False

        # Stop proxy handlers
        await self.http_proxy.stop()
        await self.ws_proxy.stop()

        # Close relay client
        if self.relay_client:
            await self.relay_client.disconnect()
            self.relay_client = None

        # Close DataChannel
        if self.data_channel:
            self.data_channel.close()
            self.data_channel = None

        # Close peer connection
        if self.pc:
            await self.pc.close()
            self.pc = None

        # Close WebSocket
        if self.ws and not self.ws.closed:
            await self.ws.close()
            self.ws = None

        # Close session
        if self.ws_session and not self.ws_session.closed:
            await self.ws_session.close()
            self.ws_session = None

        await self._set_state(ConnectionState.DISCONNECTED)
        logger.info("Disconnected")

    async def _connect_signaling(self) -> None:
        """Connect to signaling server via WebSocket.

        Raises:
            RuntimeError: If connection parameters are not set
        """
        if not self.signal_url or not self.device_id or not self.token:
            raise RuntimeError("Connection parameters not set")

        await self._set_state(ConnectionState.CONNECTING)

        # Close old session if exists
        if self.ws_session and not self.ws_session.closed:
            await self.ws_session.close()

        # Create WebSocket connection
        self.ws_session = aiohttp.ClientSession()
        url = f"{self.signal_url}?token={self.token}&device_id={self.device_id}"

        try:
            self.ws = await self.ws_session.ws_connect(url)
            logger.info(f"Connected to signaling server: {self.signal_url}")

            # Start message handling loop
            asyncio.create_task(self._handle_signaling_messages())

        except Exception as e:
            logger.error(f"Failed to connect to signaling server: {e}")
            await self._set_state(ConnectionState.FAILED)
            raise

    async def _handle_signaling_messages(self) -> None:
        """Handle incoming signaling messages."""
        if self.ws is None:
            return

        try:
            async for msg in self.ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    await self._process_signaling_message(data)
                elif msg.type == aiohttp.WSMsgType.CLOSED:
                    logger.info("WebSocket closed by server")
                    return
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    logger.error(f"WebSocket error: {msg.data}")
                    await self._handle_reconnect()
                    return
        except Exception as e:
            logger.error(f"Error handling signaling messages: {e!r}")
            if self.should_reconnect:
                await self._handle_reconnect()

    async def _process_signaling_message(self, message: dict[str, Any]) -> None:
        """Process signaling message.

        Args:
            message: Signaling message
        """
        msg_type = message.get("type")

        if msg_type == "connected":
            logger.info("Signaling connection confirmed")

        elif msg_type == "offer":
            # Received SDP offer - create answer
            sender_device_id = message.get("sender_device_id")

            # Store peer device ID for ICE candidate exchange
            if sender_device_id:
                self.peer_device_id = sender_device_id
                logger.info(f"Received offer from {sender_device_id}")

            payload = message.get("payload", {})
            offer = RTCSessionDescription(
                sdp=payload.get("sdp", ""),
                type=payload.get("type", "offer"),
            )
            answer = await self.create_answer(offer)

            # Send answer back
            if sender_device_id:
                await self._send_signaling_message(
                    {
                        "type": "answer",
                        "target_device_id": sender_device_id,
                        "payload": {"sdp": answer.sdp, "type": answer.type},
                    }
                )
                logger.info(f"Sent answer to {sender_device_id}")

        elif msg_type == "answer":
            # Received SDP answer
            payload = message.get("payload", {})
            answer = RTCSessionDescription(
                sdp=payload.get("sdp", ""),
                type=payload.get("type", "answer"),
            )
            await self.set_remote_description(answer)

        elif msg_type == "ice-candidate":
            # Received ICE candidate
            payload = message.get("payload", {})
            await self.add_ice_candidate(payload)

        elif msg_type == "error":
            logger.error(f"Signaling error: {message.get('message')}")

        elif msg_type == "ack":
            logger.debug(f"Signaling ack: {message.get('message')}")

    async def _send_signaling_message(self, message: dict[str, Any]) -> None:
        """Send message to signaling server.

        Args:
            message: Message to send

        Raises:
            RuntimeError: If WebSocket is not connected
        """
        if self.ws is None or self.ws.closed:
            raise RuntimeError("WebSocket not connected")

        await self.ws.send_json(message)
        logger.debug(f"Sent signaling message: {message.get('type')}")

    async def _set_state(self, state: ConnectionState) -> None:
        """Update connection state and notify callback.

        Args:
            state: New connection state
        """
        if self.state != state:
            old_state = self.state
            self.state = state
            logger.info(f"State change: {old_state} → {state}")

            if self.on_state_change:
                self.on_state_change(state)

    async def _handle_reconnect(self, immediate: bool = False) -> None:
        """Handle reconnection logic with exponential backoff and relay fallback.

        Args:
            immediate: If True, skip the reconnect delay (for explicit disconnects)
        """
        if not self.should_reconnect:
            return

        if not immediate:
            logger.info(f"Attempting reconnect in {self.reconnect_delay}s...")
            await asyncio.sleep(self.reconnect_delay)
            # Exponential backoff
            self.reconnect_delay = min(self.reconnect_delay * 2, self.max_reconnect_delay)
        else:
            logger.info("Attempting immediate reconnect...")

        try:
            # Decide whether to try WebRTC or fall back to relay
            if self.webrtc_attempts < self.max_webrtc_attempts:
                logger.info(
                    f"Attempting WebRTC connection "
                    f"(attempt {self.webrtc_attempts + 1}/{self.max_webrtc_attempts})"
                )
                self.webrtc_attempts += 1

                # Clean up old WebRTC state (but preserve connection parameters)
                await self._reset_webrtc_state()

                # Try WebRTC with timeout
                try:
                    await asyncio.wait_for(
                        self._reconnect_full(),
                        timeout=self.webrtc_timeout
                    )

                    # Reset attempts on successful WebRTC connection
                    self.webrtc_attempts = 0
                    self.connection_mode = "webrtc"

                    # Reset delay on successful reconnect
                    self.reconnect_delay = 2.0

                except TimeoutError:
                    logger.warning(f"WebRTC connection timeout after {self.webrtc_timeout}s")
                    # Will retry or fall back to relay
                    await self._handle_reconnect(immediate=False)

            else:
                # Fall back to relay after max WebRTC attempts
                logger.info("Max WebRTC attempts reached, falling back to relay")
                await self._try_relay_fallback()

        except Exception as e:
            logger.error(f"Reconnect failed: {e}")
            await self._handle_reconnect(immediate=False)

    async def _reset_webrtc_state(self) -> None:
        """Reset WebRTC state (PeerConnection, DataChannel) without disconnecting signaling.

        This prepares the agent for a fresh WebRTC connection attempt.
        """
        # Close DataChannel
        if self.data_channel:
            try:
                self.data_channel.close()
            except Exception as e:
                logger.warning(f"Error closing DataChannel: {e}")
            self.data_channel = None

        # Close peer connection
        if self.pc:
            try:
                await self.pc.close()
            except Exception as e:
                logger.warning(f"Error closing PeerConnection: {e}")
            self.pc = None

        # Reset ICE gathering event
        self.ice_gathering_complete.clear()

        logger.info("WebRTC state reset complete")

    async def _reconnect_full(self) -> None:
        """Reconnect signaling and re-establish WebRTC connection.

        This creates a brand new RTCPeerConnection and reconnects to the signaling server.
        """
        if not self.signal_url or not self.device_id or not self.token:
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

        # Create new RTCPeerConnection with saved ICE servers
        ice_server_configs = [
            RTCIceServer(urls=server["urls"])
            if "username" not in server
            else RTCIceServer(
                urls=server["urls"],
                username=server.get("username", ""),
                credential=server.get("credential", ""),
            )
            for server in self.ice_servers
        ]

        config = RTCConfiguration(iceServers=ice_server_configs)
        self.pc = RTCPeerConnection(configuration=config)

        # Set up connection state callbacks (same as in connect())
        @self.pc.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            """Handle connection state changes."""
            if self.pc is None:
                return

            logger.info(f"Connection state: {self.pc.connectionState}")

            if self.pc.connectionState == "connected":
                await self._set_state(ConnectionState.CONNECTED)
            elif self.pc.connectionState == "failed":
                await self._set_state(ConnectionState.FAILED)
                await self._handle_reconnect()
            elif self.pc.connectionState == "closed":
                await self._set_state(ConnectionState.CLOSED)
                # Reset WebRTC state immediately so we're ready for new offers
                # This handles explicit disconnects (browser closes connection)
                await self._handle_reconnect(immediate=True)

        @self.pc.on("icecandidate")
        async def on_icecandidate(candidate: RTCIceCandidate | None) -> None:
            """Handle ICE candidate gathering."""
            if candidate is None:
                # ICE gathering complete
                self.ice_gathering_complete.set()
                logger.info("ICE gathering complete")
            else:
                # Send ICE candidate to peer via signaling
                # Use peer_device_id (responder) or target_device_id (initiator)
                target = self.peer_device_id or self.target_device_id
                if target:
                    candidate_sdp = candidate_to_sdp(candidate)
                    await self._send_signaling_message(
                        {
                            "type": "ice-candidate",
                            "target_device_id": target,
                            "payload": {
                                "candidate": candidate_sdp,
                                "sdpMid": candidate.sdpMid,
                                "sdpMLineIndex": candidate.sdpMLineIndex,
                            },
                        }
                    )
                    logger.debug(f"Sent ICE candidate to {target}")

        @self.pc.on("datachannel")
        def on_datachannel(channel: RTCDataChannel) -> None:
            """Handle incoming DataChannel (for answering peer)."""
            logger.info(f"DataChannel received: {channel.label}")
            self._setup_data_channel(channel)

        # Reconnect to signaling server
        await self._connect_signaling()

        logger.info("Full reconnection complete, waiting for new offer from peer")

    def get_state(self) -> ConnectionState:
        """Get current connection state.

        Returns:
            Current ConnectionState
        """
        return self.state

    def is_connected(self) -> bool:
        """Check if connection is established.

        Returns:
            True if connected, False otherwise
        """
        return self.state == ConnectionState.CONNECTED

    def get_data_channel_state(self) -> str:
        """Get DataChannel state.

        Returns:
            DataChannel readyState or "none" if no channel
        """
        if self.data_channel is None:
            return "none"
        return self.data_channel.readyState

    async def _handle_datachannel_message(self, data: bytes) -> None:
        """Handle incoming DataChannel message (HTTP or WebSocket frame).

        Args:
            data: Binary frame (HTTP_REQUEST, WS_CONNECT, WS_DATA, WS_CLOSE)
        """
        try:
            # Dispatch message to appropriate handler
            response_data = await self.message_dispatcher.dispatch(data)

            # Send response back if provided (HTTP responses only)
            if response_data and self.data_channel and self.data_channel.readyState == "open":
                self.data_channel.send(response_data)

        except Exception as e:
            logger.error(f"Error handling DataChannel message: {e}")

    async def _send_frame(self, data: bytes) -> None:
        """Send frame back over DataChannel or relay WebSocket (used by WebSocket proxy).

        Args:
            data: Binary frame to send
        """
        if self.connection_mode == "relay" and self.relay_client:
            # Send via relay WebSocket
            try:
                await self.relay_client.send(data)
            except Exception as e:
                logger.warning(f"Cannot send frame via relay: {e}")
        elif self.data_channel and self.data_channel.readyState == "open":
            # Send via WebRTC DataChannel
            self.data_channel.send(data)
        else:
            logger.warning("Cannot send frame: No active connection")

    async def _try_relay_fallback(self) -> None:
        """Try to establish relay WebSocket connection as fallback.

        Creates a RelayClient and connects to the relay server.
        """
        if not self.device_id or not self.token:
            raise RuntimeError("Cannot connect to relay: missing device_id or token")

        logger.info(f"Establishing relay connection to {self.relay_url}")

        # Clean up old relay client if exists
        if self.relay_client:
            try:
                await self.relay_client.disconnect()
            except Exception as e:
                logger.warning(f"Error closing old relay client: {e}")

        # Create new relay client
        # Note: RelayClient creates its own proxies for now
        # TODO: Consider sharing proxies/dispatcher with TunnelAgent

        # Use device_id as session_id for relay
        session_id = self.device_id

        try:
            # Create relay client
            self.relay_client = RelayClient(local_server_url=self.http_proxy.local_server_url)
            self.relay_client.on_state_change = self._on_relay_state_change

            # Connect to relay server
            await self.relay_client.connect(
                relay_url=self.relay_url,
                session_id=session_id,
                token=self.token,
            )

            # Mark as relay mode
            self.connection_mode = "relay"
            await self._set_state(ConnectionState.CONNECTED)

            # Reset reconnect delay on successful connection
            self.reconnect_delay = 2.0

            logger.info("✓ Relay connection established successfully")

        except Exception as e:
            logger.error(f"Relay connection failed: {e}")
            # Retry after delay
            await self._handle_reconnect(immediate=False)

    def _on_relay_state_change(self, state: RelayConnectionState) -> None:
        """Handle relay client state changes.

        Args:
            state: New relay connection state
        """
        logger.info(f"Relay state change: {state}")

        # Map relay states to TunnelAgent states
        if state == RelayConnectionState.CONNECTED:
            # Already handled in _try_relay_fallback
            pass
        elif state in (RelayConnectionState.FAILED, RelayConnectionState.CLOSED):
            # Relay connection lost, attempt reconnect
            asyncio.create_task(self._handle_reconnect(immediate=False))

    def get_connection_mode(self) -> str:
        """Get current connection mode.

        Returns:
            "webrtc" or "relay"
        """
        return self.connection_mode
