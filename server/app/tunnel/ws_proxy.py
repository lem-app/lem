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

"""WebSocket proxy handler for DataChannel (protocol v3).

Receives WebSocket frames over DataChannel, establishes upstream WebSocket
connections, and relays messages bidirectionally.

Two v3 changes live here:

* **The handshake is acknowledged.** ``WS_CONNECT_ACK`` is sent after
  ``ws_connect()`` returns and *before* the relay task starts, so a fast first
  server message cannot arrive ahead of the ack. v2 sent nothing at all, which
  left the browser's ``ProxiedWebSocket`` in CONNECTING forever.
* **Messages are fragmented** to the negotiated chunk size and reassembled on
  receipt, bounded by ``MAX_WS_MESSAGE_BYTES``.
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

import aiohttp
from multidict import CIMultiDict

from .http_frame import MAX_CHUNK_BYTES
from .router import RequestRouter
from .ws_frame import (
    MAX_WS_MESSAGE_BYTES,
    WSCloseFrame,
    WSConnectAckFrame,
    WSConnectErrorFrame,
    WSDataFrame,
    WSOpcode,
    deserialize_ws_close,
    deserialize_ws_connect,
    deserialize_ws_data,
    serialize_ws_close,
    serialize_ws_connect_ack,
    serialize_ws_connect_error,
    serialize_ws_data,
)

logger = logging.getLogger(__name__)

# Connection IDs are chosen by the peer, so an unbounded map lets one peer
# exhaust local sockets and memory. Cap the number of live upstream sockets.
MAX_WS_CONNECTIONS = 64

# Close codes (spec section 7.2).
WS_CODE_UPSTREAM_ERROR = 1011
WS_CODE_CONNECTION_LIMIT = 4004
WS_CODE_MESSAGE_TOO_LARGE = 4005


@dataclass
class PendingMessage:
    """A WebSocket message being reassembled from fragments."""

    opcode: int
    parts: list[bytes] = field(default_factory=list)
    size: int = 0


class WSProxyHandler:
    """WebSocket proxy handler for DataChannel messages.

    Establishes upstream WebSocket connections and relays messages.
    """

    def __init__(
        self,
        router: RequestRouter,
        send_frame: Any,  # Callable to send frames back over DataChannel
    ) -> None:
        """Initialize WebSocket proxy handler.

        Args:
            router: Request router for determining WebSocket targets
            send_frame: Async callable to send frames back to the client
                (signature: ``async def(bytes) -> None``)
        """
        self.router = router
        self.send_frame = send_frame
        self.connections: dict[int, aiohttp.ClientWebSocketResponse] = {}
        self.relay_tasks: dict[int, asyncio.Task[None]] = {}
        self.session: aiohttp.ClientSession | None = None

        # Fragments received per connection, awaiting a FIN.
        self.pending_messages: dict[int, PendingMessage] = {}

        # Negotiated in HELLO; the default stands until then.
        self.effective_max_chunk = MAX_CHUNK_BYTES

    def negotiate_limits(self, peer_max_chunk_bytes: int) -> None:
        """Apply the peer's advertised chunk limit from HELLO.

        Args:
            peer_max_chunk_bytes: Largest frame payload the peer will accept
        """
        self.effective_max_chunk = max(1, min(MAX_CHUNK_BYTES, peer_max_chunk_bytes))

    async def start(self) -> None:
        """Start the proxy handler (create HTTP session)."""
        self.session = aiohttp.ClientSession()
        logger.info("WebSocket proxy handler started")

    async def stop(self) -> None:
        """Stop the proxy handler (close all connections and session)."""
        # Cancel all relay tasks
        for task in self.relay_tasks.values():
            task.cancel()

        # Close all WebSocket connections
        for conn_id, ws in list(self.connections.items()):
            try:
                await ws.close()
            except Exception as e:
                logger.error(f"Error closing WebSocket {conn_id}: {e}")

        self.connections.clear()
        self.relay_tasks.clear()
        self.pending_messages.clear()

        # Close HTTP session
        if self.session and not self.session.closed:
            await self.session.close()
            self.session = None

        logger.info("WebSocket proxy handler stopped")

    async def handle_connect(self, data: bytes) -> None:
        """Handle WS_CONNECT frame - establish upstream WebSocket connection.

        Args:
            data: Binary WS_CONNECT frame (without frame type byte)
        """
        if self.session is None:
            raise RuntimeError("WebSocket session not started")

        error_code = WS_CODE_UPSTREAM_ERROR

        try:
            # Deserialize frame
            frame = deserialize_ws_connect(data)
            conn_id = frame["connection_id"]
            url = frame["url"]

            logger.info(f"WebSocket CONNECT {conn_id}: {url}")

            # Refuse to open more upstream sockets than we are willing to hold
            if conn_id not in self.connections and len(self.connections) >= MAX_WS_CONNECTIONS:
                error_code = WS_CODE_CONNECTION_LIMIT
                raise RuntimeError(
                    f"WebSocket connection limit reached ({MAX_WS_CONNECTIONS} open)"
                )

            # Use router to determine target
            # Extract path from WebSocket URL
            from urllib.parse import urlparse

            parsed = urlparse(url)
            path = parsed.path + ("?" + parsed.query if parsed.query else "")
            target_base = self.router.route(path)

            # Rebuild WebSocket URL with target base
            # Convert http:// to ws://, https:// to wss://
            ws_scheme = "wss" if target_base.startswith("https://") else "ws"
            target_host = target_base.replace("http://", "").replace("https://", "")
            ws_url = f"{ws_scheme}://{target_host}{parsed.path}"
            if parsed.query:
                ws_url += f"?{parsed.query}"

            logger.info(f"Connecting to upstream WebSocket: {ws_url}")

            # Establish WebSocket connection
            ws = await self.session.ws_connect(
                ws_url,
                headers=CIMultiDict(frame["headers"]),
                timeout=aiohttp.ClientWSTimeout(ws_close=30.0),
            )

            # Store connection
            self.connections[conn_id] = ws

            # Acknowledge BEFORE starting the relay task, so a fast first
            # server message cannot arrive ahead of the ack and leave the
            # browser handling data for a socket it still thinks is CONNECTING.
            ack: WSConnectAckFrame = {
                "connection_id": conn_id,
                "protocol": ws.protocol or "",
            }
            await self.send_frame(serialize_ws_connect_ack(ack))

            # Start relay task (upstream → client)
            task = asyncio.create_task(self._relay_upstream_messages(conn_id))
            self.relay_tasks[conn_id] = task

            logger.info(f"WebSocket {conn_id} connected successfully")

        except Exception as e:
            logger.error(f"Error handling WS_CONNECT: {e}")
            # Tell the peer the handshake failed, so it fails fast instead of
            # waiting out its connect timeout.
            try:
                error_frame: WSConnectErrorFrame = {
                    "connection_id": frame["connection_id"],
                    "error_code": error_code,
                    # Generic reason: the cause is in the log, not in the frame
                    "reason": "Connection failed",
                }
                await self.send_frame(serialize_ws_connect_error(error_frame))
            except Exception as send_error:
                logger.error(f"Error sending WS_CONNECT_ERROR: {send_error}")

    async def handle_data(self, data: bytes) -> None:
        """Handle WS_DATA frame - forward to upstream WebSocket.

        Args:
            data: Binary WS_DATA frame (without frame type byte)
        """
        try:
            # Deserialize frame
            frame = deserialize_ws_data(data, self.effective_max_chunk)
            conn_id = frame["connection_id"]

            # Get connection
            ws = self.connections.get(conn_id)
            if not ws:
                logger.warning(f"WS_DATA for unknown connection: {conn_id}")
                return

            assembled = self._reassemble(conn_id, frame)
            if assembled is None:
                return
            opcode, payload = assembled

            # Forward to upstream
            if opcode == WSOpcode.TEXT:
                # Text message
                text = payload.decode("utf-8")
                await ws.send_str(text)
                logger.debug(f"WebSocket {conn_id}: Sent text message ({len(text)} chars)")
            elif opcode == WSOpcode.BINARY:
                # Binary message
                await ws.send_bytes(payload)
                logger.debug(f"WebSocket {conn_id}: Sent binary message ({len(payload)} bytes)")
            elif opcode == WSOpcode.PING:
                # Ping
                await ws.ping(payload)
                logger.debug(f"WebSocket {conn_id}: Sent ping")
            elif opcode == WSOpcode.PONG:
                # Pong
                await ws.pong(payload)
                logger.debug(f"WebSocket {conn_id}: Sent pong")

        except Exception as e:
            logger.error(f"Error handling WS_DATA: {e}")

    def _reassemble(self, conn_id: int, frame: WSDataFrame) -> tuple[int, bytes] | None:
        """Reassemble a possibly-fragmented WS_DATA frame.

        Args:
            conn_id: Connection the frame belongs to
            frame: Decoded WS_DATA frame

        Returns:
            ``(opcode, payload)`` once a complete message is in hand, otherwise
            None (more fragments expected, or the fragment was invalid)
        """
        opcode = frame["opcode"]
        payload = frame["payload"]

        if opcode == WSOpcode.CONTINUATION:
            pending = self.pending_messages.get(conn_id)
            if pending is None:
                logger.warning(f"WebSocket {conn_id}: CONTINUATION with no message in progress")
                return None

            # Total across fragments is a separate bound from the per-frame one.
            if pending.size + len(payload) > MAX_WS_MESSAGE_BYTES:
                logger.warning(
                    f"WebSocket {conn_id}: message exceeded MAX_WS_MESSAGE_BYTES "
                    f"({pending.size + len(payload)} > {MAX_WS_MESSAGE_BYTES})"
                )
                del self.pending_messages[conn_id]
                asyncio.create_task(
                    self._close_connection(conn_id, WS_CODE_MESSAGE_TOO_LARGE, "Message too large")
                )
                return None

            pending.parts.append(payload)
            pending.size += len(payload)

            if not frame["fin"]:
                return None

            del self.pending_messages[conn_id]
            return pending.opcode, b"".join(pending.parts)

        if not frame["fin"]:
            # First fragment of a fragmented message. Control frames must never
            # be fragmented (RFC 6455 5.5).
            if opcode in (WSOpcode.CLOSE, WSOpcode.PING, WSOpcode.PONG):
                logger.warning(f"WebSocket {conn_id}: fragmented control frame refused")
                return None
            if len(payload) > MAX_WS_MESSAGE_BYTES:
                logger.warning(f"WebSocket {conn_id}: first fragment already over the cap")
                return None
            self.pending_messages[conn_id] = PendingMessage(
                opcode=opcode, parts=[payload], size=len(payload)
            )
            return None

        return opcode, payload

    async def _close_connection(self, conn_id: int, code: int, reason: str) -> None:
        """Close one upstream socket and tell the peer.

        Args:
            conn_id: Connection to close
            code: Close code
            reason: Generic reason
        """
        ws = self.connections.pop(conn_id, None)
        task = self.relay_tasks.pop(conn_id, None)
        self.pending_messages.pop(conn_id, None)
        if task is not None:
            task.cancel()
        if ws is not None:
            try:
                await ws.close(code=code)
            except Exception as exc:
                logger.error(f"Error closing WebSocket {conn_id}: {exc}")
        close_frame: WSCloseFrame = {
            "connection_id": conn_id,
            "close_code": code,
            "reason": reason,
        }
        await self.send_frame(serialize_ws_close(close_frame))

    async def _send_ws_message(self, conn_id: int, opcode: int, payload: bytes) -> None:
        """Send one upstream message to the peer, fragmenting if needed.

        Args:
            conn_id: Connection the message belongs to
            opcode: RFC 6455 opcode of the message
            payload: Complete message payload
        """
        limit = self.effective_max_chunk

        if len(payload) <= limit:
            frame: WSDataFrame = {
                "connection_id": conn_id,
                "opcode": opcode,
                "payload": payload,
                "fin": True,
            }
            await self.send_frame(serialize_ws_data(frame))
            return

        offset = 0
        first = True
        while offset < len(payload):
            piece = payload[offset : offset + limit]
            offset += limit
            fragment: WSDataFrame = {
                "connection_id": conn_id,
                "opcode": opcode if first else WSOpcode.CONTINUATION,
                "payload": piece,
                "fin": offset >= len(payload),
            }
            await self.send_frame(serialize_ws_data(fragment))
            first = False

    async def handle_close(self, data: bytes) -> None:
        """Handle WS_CLOSE frame - close upstream WebSocket.

        Args:
            data: Binary WS_CLOSE frame (without frame type byte)
        """
        try:
            # Deserialize frame
            frame = deserialize_ws_close(data)
            conn_id = frame["connection_id"]

            logger.info(
                f"WebSocket CLOSE {conn_id}: code={frame['close_code']}, reason={frame['reason']}"
            )

            # Get connection
            ws = self.connections.get(conn_id)
            if ws:
                # Close upstream connection
                await ws.close(code=frame["close_code"], message=frame["reason"].encode("utf-8"))
                del self.connections[conn_id]
                self.pending_messages.pop(conn_id, None)

                # Cancel relay task
                task = self.relay_tasks.get(conn_id)
                if task:
                    task.cancel()
                    del self.relay_tasks[conn_id]

                logger.info(f"WebSocket {conn_id} closed")

        except Exception as e:
            logger.error(f"Error handling WS_CLOSE: {e}")

    async def _relay_upstream_messages(self, conn_id: int) -> None:
        """Relay messages from upstream WebSocket to client.

        Args:
            conn_id: Connection ID
        """
        ws = self.connections.get(conn_id)
        if not ws:
            logger.warning(f"Relay task started for unknown connection: {conn_id}")
            return

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    # Text message. Fragmented if it exceeds the negotiated
                    # chunk size, which is what makes a long model response
                    # survive the DataChannel's message limit.
                    await self._send_ws_message(conn_id, WSOpcode.TEXT, msg.data.encode("utf-8"))
                    logger.debug(
                        f"WebSocket {conn_id}: Relayed text message ({len(msg.data)} chars)"
                    )

                elif msg.type == aiohttp.WSMsgType.BINARY:
                    # Binary message
                    await self._send_ws_message(conn_id, WSOpcode.BINARY, msg.data)
                    logger.debug(
                        f"WebSocket {conn_id}: Relayed binary message ({len(msg.data)} bytes)"
                    )

                elif msg.type == aiohttp.WSMsgType.PING:
                    # Ping (relay as data; control frames are never fragmented)
                    await self._send_ws_message(conn_id, WSOpcode.PING, msg.data)
                    logger.debug(f"WebSocket {conn_id}: Relayed ping")

                elif msg.type == aiohttp.WSMsgType.PONG:
                    # Pong (relay as data; control frames are never fragmented)
                    await self._send_ws_message(conn_id, WSOpcode.PONG, msg.data)
                    logger.debug(f"WebSocket {conn_id}: Relayed pong")

                elif msg.type in (
                    aiohttp.WSMsgType.CLOSE,
                    aiohttp.WSMsgType.CLOSED,
                    aiohttp.WSMsgType.CLOSING,
                ):
                    # Connection closed by server
                    close_frame: WSCloseFrame = {
                        "connection_id": conn_id,
                        "close_code": ws.close_code or 1000,
                        "reason": "Server closed connection",
                    }
                    close_data = serialize_ws_close(close_frame)
                    await self.send_frame(close_data)
                    logger.info(
                        f"WebSocket {conn_id}: Server closed connection (code: {ws.close_code})"
                    )
                    break

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    # Error
                    logger.error(f"WebSocket {conn_id}: Error from upstream")
                    close_frame = {
                        "connection_id": conn_id,
                        "close_code": 1006,  # Abnormal closure
                        "reason": "Upstream error",
                    }
                    close_data = serialize_ws_close(close_frame)
                    await self.send_frame(close_data)
                    break

        except asyncio.CancelledError:
            logger.info(f"WebSocket {conn_id}: Relay task cancelled")
        except Exception as e:
            logger.error(f"WebSocket {conn_id}: Relay error: {e}")
            # Send close frame on error
            try:
                close_frame = {
                    "connection_id": conn_id,
                    "close_code": 1006,
                    # Generic reason: the cause is in the log, not in the frame
                    "reason": "Relay error",
                }
                close_data = serialize_ws_close(close_frame)
                await self.send_frame(close_data)
            except Exception as send_error:
                logger.error(f"Error sending error close frame: {send_error}")
        finally:
            # Clean up
            if conn_id in self.connections:
                del self.connections[conn_id]
            if conn_id in self.relay_tasks:
                del self.relay_tasks[conn_id]
            self.pending_messages.pop(conn_id, None)
