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

"""WebSocket signaling endpoint for WebRTC peer connection establishment."""

import asyncio
import json
import logging
from typing import Any

import aiosqlite
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from jose import JWTError

from ..core.config import settings
from ..core.security import decode_access_token
from ..db import USE_POSTGRES, get_db

router = APIRouter(tags=["signaling"])
logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manage WebSocket connections for signaling."""

    def __init__(self) -> None:
        """Initialize connection manager."""
        # Map device_id -> WebSocket
        self.active_connections: dict[str, WebSocket] = {}
        # Lock to prevent race conditions during connect/disconnect
        self._lock = asyncio.Lock()

    async def register(self, device_id: str, websocket: WebSocket) -> None:
        """Register an already-accepted WebSocket connection for a device.

        Closes any existing connection for this device before registering.

        Args:
            device_id: Device identifier.
            websocket: Already-accepted WebSocket connection.
        """
        async with self._lock:
            # Close existing connection if any
            if device_id in self.active_connections:
                old_ws = self.active_connections[device_id]
                logger.info(f"Closing existing connection for device {device_id}")
                try:
                    await old_ws.close(code=status.WS_1008_POLICY_VIOLATION)
                except Exception as e:
                    logger.warning(f"Error closing old connection: {e}")

            self.active_connections[device_id] = websocket
            logger.info(f"Device {device_id} connected to signaling server")

    async def disconnect(self, device_id: str) -> None:
        """Disconnect a device.

        Args:
            device_id: Device identifier.
        """
        async with self._lock:
            if device_id in self.active_connections:
                del self.active_connections[device_id]
                logger.info(f"Device {device_id} disconnected from signaling server")

    async def send_message(self, device_id: str, message: dict[str, Any]) -> bool:
        """Send a message to a specific device.

        Args:
            device_id: Target device identifier.
            message: Message to send.

        Returns:
            True if message was sent, False if device not connected or send failed.
        """
        websocket: WebSocket | None = None
        async with self._lock:
            websocket = self.active_connections.get(device_id)

        if websocket is not None:
            try:
                await websocket.send_json(message)
                return True
            except Exception as e:
                logger.warning(f"Failed to send message to {device_id}: {e}")
                # Remove disconnected device from active connections
                await self.disconnect(device_id)
                return False
        return False


manager = ConnectionManager()


async def verify_token_and_device(
    token: str, device_id: str, db: aiosqlite.Connection
) -> tuple[int, str]:
    """Verify JWT token and device ownership.

    Args:
        token: JWT access token.
        device_id: Device ID to verify.
        db: Database connection.

    Returns:
        Tuple of (user_id, device_id).

    Raises:
        ValueError: If token is invalid or device doesn't belong to user.
    """
    try:
        payload = decode_access_token(token)
        user_id: int | None = payload.get("user_id")
        if user_id is None:
            raise ValueError("Invalid token: missing user_id")

        # Verify device belongs to user
        if USE_POSTGRES:
            device = await db.fetchrow(
                "SELECT id FROM devices WHERE id = $1 AND user_id = $2",
                device_id, user_id
            )
        else:
            async with db.execute(
                "SELECT id FROM devices WHERE id = ? AND user_id = ?",
                (device_id, user_id),
            ) as cursor:
                device = await cursor.fetchone()
        if not device:
            raise ValueError(f"Device {device_id} not found for user {user_id}")

        return user_id, device_id

    except JWTError as e:
        raise ValueError(f"Invalid token: {e}")


@router.websocket("/signal")
async def websocket_signal_endpoint(
    websocket: WebSocket,
    token: str | None = Query(None, description="JWT access token (deprecated, use auth message)"),
    device_id: str | None = Query(None, description="Device ID (deprecated, use auth message)"),
) -> None:
    """WebSocket endpoint for WebRTC signaling.

    Handles SDP/ICE message exchange between peers.

    Authentication can be provided via:
    1. Query parameters (deprecated, token visible in logs)
    2. First message with type "auth" (preferred, more secure)

    Args:
        websocket: WebSocket connection.
        token: JWT access token (optional, deprecated).
        device_id: Device identifier (optional, deprecated).
    """
    verified_device_id: str | None = None
    auth_token: str | None = token
    auth_device_id: str | None = device_id

    # Accept connection first (auth happens after)
    await websocket.accept()

    # Use async for to properly manage the database connection lifecycle
    # The generator yields once and cleanup happens automatically when we exit
    async for db_conn in get_db():
        try:
            # If no token in query params, wait for auth message
            if not auth_token or not auth_device_id:
                try:
                    # Wait for auth message with 10 second timeout
                    auth_data = await asyncio.wait_for(
                        websocket.receive_text(),
                        timeout=10.0
                    )
                    auth_msg = json.loads(auth_data)

                    if auth_msg.get("type") != "auth":
                        await websocket.send_json({
                            "type": "error",
                            "message": "First message must be auth message"
                        })
                        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                        return

                    auth_token = auth_msg.get("token")
                    auth_device_id = auth_msg.get("device_id")

                    if not auth_token or not auth_device_id:
                        await websocket.send_json({
                            "type": "error",
                            "message": "Auth message missing token or device_id"
                        })
                        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                        return

                except TimeoutError:
                    logger.warning("Auth timeout - no auth message received")
                    await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                    return
                except json.JSONDecodeError:
                    await websocket.send_json({
                        "type": "error",
                        "message": "Invalid JSON in auth message"
                    })
                    await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                    return

            # Verify token and device
            try:
                user_id, verified_device_id = await verify_token_and_device(
                    auth_token, auth_device_id, db_conn
                )
            except ValueError as e:
                logger.warning(f"Authentication failed: {e}")
                await websocket.send_json({
                    "type": "error",
                    "message": "Authentication failed"
                })
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                return

            # Register connection (websocket already accepted)
            await manager.register(verified_device_id, websocket)

            # Send connection confirmation with ICE servers configuration
            await websocket.send_json(
                {
                    "type": "connected",
                    "device_id": verified_device_id,
                    "message": "Connected to signaling server",
                    "ice_servers": settings.ice_servers,
                }
            )

            # Handle incoming messages
            while True:
                data = await websocket.receive_text()

                try:
                    message: dict[str, Any] = json.loads(data)

                    # Validate message structure
                    if "type" not in message or "target_device_id" not in message:
                        await websocket.send_json(
                            {
                                "type": "error",
                                "message": "Invalid message format: missing type or target_device_id",
                            }
                        )
                        continue

                    # Check payload size (64 KB limit as per architecture)
                    if len(data) > 64 * 1024:
                        await websocket.send_json(
                            {"type": "error", "message": "Message exceeds 64 KB limit"}
                        )
                        continue

                    target_device_id: str = message["target_device_id"]
                    msg_type: str = message["type"]

                    # Handle relay coordination messages
                    if msg_type == "connect-request":
                        # Transform to connect-request-received
                        notification = {
                            "type": "connect-request-received",
                            "from_device_id": verified_device_id,
                            "preferred_transport": message.get("preferred_transport", "auto"),
                            "relay_session_id": message.get("relay_session_id"),
                            "relay_url": settings.relay_url,
                        }
                        success = await manager.send_message(target_device_id, notification)

                    elif msg_type == "connect-ack":
                        # Transform to connect-ack-received
                        notification = {
                            "type": "connect-ack-received",
                            "from_device_id": verified_device_id,
                            "transport": message.get("transport"),
                            "relay_session_id": message.get("relay_session_id"),
                            "status": message.get("status"),
                        }
                        success = await manager.send_message(target_device_id, notification)

                    else:
                        # Generic message routing (WebRTC signaling, etc.)
                        # Add sender information
                        message["sender_device_id"] = verified_device_id
                        # Route message to target device
                        success = await manager.send_message(target_device_id, message)

                    if success:
                        logger.info(
                            f"Routed {message['type']} from {verified_device_id} to {target_device_id}"
                        )
                        # Send acknowledgment
                        await websocket.send_json(
                            {
                                "type": "ack",
                                "message": f"Message delivered to {target_device_id}",
                            }
                        )
                    else:
                        logger.warning(
                            f"Target device {target_device_id} not connected"
                        )
                        await websocket.send_json(
                            {
                                "type": "error",
                                "message": f"Target device {target_device_id} not connected",
                            }
                        )

                except json.JSONDecodeError:
                    await websocket.send_json(
                        {"type": "error", "message": "Invalid JSON format"}
                    )
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    await websocket.send_json({"type": "error", "message": "Internal error"})

        except WebSocketDisconnect:
            disconnect_id = verified_device_id or auth_device_id or "unknown"
            logger.info(f"WebSocket disconnected for device {disconnect_id}")
        except Exception as e:
            logger.error(f"Unexpected error in WebSocket handler: {e}")
        finally:
            # Clean up connection manager - only if we have a valid device_id
            cleanup_device_id = verified_device_id or auth_device_id
            if cleanup_device_id:
                await manager.disconnect(cleanup_device_id)
            # Note: db_conn cleanup happens automatically via the async for context
