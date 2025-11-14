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

"""WebSocket proxy handler for DataChannel.

Receives WebSocket frames over DataChannel, establishes upstream WebSocket
connections, and relays messages bidirectionally.
"""

import asyncio
import logging
from typing import Any

import aiohttp

from .router import RequestRouter
from .ws_frame import (
    WSCloseFrame,
    WSConnectFrame,
    WSDataFrame,
    WSOpcode,
    deserialize_ws_close,
    deserialize_ws_connect,
    deserialize_ws_data,
    serialize_ws_close,
    serialize_ws_data,
)

logger = logging.getLogger(__name__)


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
            send_frame: Async callable to send frames back to client (signature: async def(bytes) -> None)
        """
        self.router = router
        self.send_frame = send_frame
        self.connections: dict[int, aiohttp.ClientWebSocketResponse] = {}
        self.relay_tasks: dict[int, asyncio.Task[None]] = {}
        self.session: aiohttp.ClientSession | None = None

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

        try:
            # Deserialize frame
            frame = deserialize_ws_connect(data)
            conn_id = frame["connection_id"]
            url = frame["url"]

            logger.info(f"WebSocket CONNECT {conn_id}: {url}")

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
                headers=frame["headers"],
                timeout=aiohttp.ClientTimeout(total=30),
            )

            # Store connection
            self.connections[conn_id] = ws

            # Start relay task (upstream → client)
            task = asyncio.create_task(self._relay_upstream_messages(conn_id))
            self.relay_tasks[conn_id] = task

            logger.info(f"WebSocket {conn_id} connected successfully")

            # Note: We could send a WS_CONNECT_ACK frame here,
            # but for simplicity, client assumes success until WS_CLOSE or WS_DATA arrives

        except Exception as e:
            logger.error(f"Error handling WS_CONNECT: {e}")
            # Send WS_CLOSE with error
            try:
                error_frame: WSCloseFrame = {
                    "connection_id": frame["connection_id"],
                    "close_code": 1006,  # Abnormal closure
                    "reason": f"Connection failed: {str(e)}",
                }
                close_data = serialize_ws_close(error_frame)
                await self.send_frame(close_data)
            except Exception as send_error:
                logger.error(f"Error sending error WS_CLOSE: {send_error}")

    async def handle_data(self, data: bytes) -> None:
        """Handle WS_DATA frame - forward to upstream WebSocket.

        Args:
            data: Binary WS_DATA frame (without frame type byte)
        """
        try:
            # Deserialize frame
            frame = deserialize_ws_data(data)
            conn_id = frame["connection_id"]

            # Get connection
            ws = self.connections.get(conn_id)
            if not ws:
                logger.warning(f"WS_DATA for unknown connection: {conn_id}")
                return

            # Forward to upstream
            if frame["opcode"] == WSOpcode.TEXT:
                # Text message
                text = frame["payload"].decode("utf-8")
                await ws.send_str(text)
                logger.debug(f"WebSocket {conn_id}: Sent text message ({len(text)} chars)")
            elif frame["opcode"] == WSOpcode.BINARY:
                # Binary message
                await ws.send_bytes(frame["payload"])
                logger.debug(f"WebSocket {conn_id}: Sent binary message ({len(frame['payload'])} bytes)")
            elif frame["opcode"] == WSOpcode.PING:
                # Ping
                await ws.ping(frame["payload"])
                logger.debug(f"WebSocket {conn_id}: Sent ping")
            elif frame["opcode"] == WSOpcode.PONG:
                # Pong
                await ws.pong(frame["payload"])
                logger.debug(f"WebSocket {conn_id}: Sent pong")

        except Exception as e:
            logger.error(f"Error handling WS_DATA: {e}")

    async def handle_close(self, data: bytes) -> None:
        """Handle WS_CLOSE frame - close upstream WebSocket.

        Args:
            data: Binary WS_CLOSE frame (without frame type byte)
        """
        try:
            # Deserialize frame
            frame = deserialize_ws_close(data)
            conn_id = frame["connection_id"]

            logger.info(f"WebSocket CLOSE {conn_id}: code={frame['close_code']}, reason={frame['reason']}")

            # Get connection
            ws = self.connections.get(conn_id)
            if ws:
                # Close upstream connection
                await ws.close(code=frame["close_code"], message=frame["reason"].encode("utf-8"))
                del self.connections[conn_id]

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
                    # Text message
                    payload = msg.data.encode("utf-8")
                    data_frame: WSDataFrame = {
                        "connection_id": conn_id,
                        "opcode": WSOpcode.TEXT,
                        "payload": payload,
                    }
                    frame_data = serialize_ws_data(data_frame)
                    await self.send_frame(frame_data)
                    logger.debug(f"WebSocket {conn_id}: Relayed text message ({len(msg.data)} chars)")

                elif msg.type == aiohttp.WSMsgType.BINARY:
                    # Binary message
                    data_frame: WSDataFrame = {
                        "connection_id": conn_id,
                        "opcode": WSOpcode.BINARY,
                        "payload": msg.data,
                    }
                    frame_data = serialize_ws_data(data_frame)
                    await self.send_frame(frame_data)
                    logger.debug(f"WebSocket {conn_id}: Relayed binary message ({len(msg.data)} bytes)")

                elif msg.type == aiohttp.WSMsgType.PING:
                    # Ping (relay as data)
                    data_frame: WSDataFrame = {
                        "connection_id": conn_id,
                        "opcode": WSOpcode.PING,
                        "payload": msg.data,
                    }
                    frame_data = serialize_ws_data(data_frame)
                    await self.send_frame(frame_data)
                    logger.debug(f"WebSocket {conn_id}: Relayed ping")

                elif msg.type == aiohttp.WSMsgType.PONG:
                    # Pong (relay as data)
                    data_frame: WSDataFrame = {
                        "connection_id": conn_id,
                        "opcode": WSOpcode.PONG,
                        "payload": msg.data,
                    }
                    frame_data = serialize_ws_data(data_frame)
                    await self.send_frame(frame_data)
                    logger.debug(f"WebSocket {conn_id}: Relayed pong")

                elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING):
                    # Connection closed by server
                    close_frame: WSCloseFrame = {
                        "connection_id": conn_id,
                        "close_code": ws.close_code or 1000,
                        "reason": "Server closed connection",
                    }
                    close_data = serialize_ws_close(close_frame)
                    await self.send_frame(close_data)
                    logger.info(f"WebSocket {conn_id}: Server closed connection (code: {ws.close_code})")
                    break

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    # Error
                    logger.error(f"WebSocket {conn_id}: Error from upstream")
                    close_frame: WSCloseFrame = {
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
                close_frame: WSCloseFrame = {
                    "connection_id": conn_id,
                    "close_code": 1006,
                    "reason": f"Relay error: {str(e)}",
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
