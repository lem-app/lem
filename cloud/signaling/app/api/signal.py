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

import json
import logging
from typing import Any

import aiosqlite
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from jose import JWTError

from ..core.security import decode_access_token
from ..db import get_db

router = APIRouter(tags=["signaling"])
logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manage WebSocket connections for signaling."""

    def __init__(self) -> None:
        """Initialize connection manager."""
        # Map device_id -> WebSocket
        self.active_connections: dict[str, WebSocket] = {}

    async def connect(self, device_id: str, websocket: WebSocket) -> None:
        """Connect a device.

        Args:
            device_id: Device identifier.
            websocket: WebSocket connection.
        """
        # Close existing connection if any
        if device_id in self.active_connections:
            old_ws = self.active_connections[device_id]
            logger.info(f"Closing existing connection for device {device_id}")
            try:
                await old_ws.close(code=status.WS_1008_POLICY_VIOLATION)
            except Exception as e:
                logger.warning(f"Error closing old connection: {e}")

        await websocket.accept()
        self.active_connections[device_id] = websocket
        logger.info(f"Device {device_id} connected to signaling server")

    def disconnect(self, device_id: str) -> None:
        """Disconnect a device.

        Args:
            device_id: Device identifier.
        """
        if device_id in self.active_connections:
            del self.active_connections[device_id]
            logger.info(f"Device {device_id} disconnected from signaling server")

    async def send_message(self, device_id: str, message: dict[str, Any]) -> bool:
        """Send a message to a specific device.

        Args:
            device_id: Target device identifier.
            message: Message to send.

        Returns:
            True if message was sent, False if device not connected.
        """
        if device_id in self.active_connections:
            websocket = self.active_connections[device_id]
            await websocket.send_json(message)
            return True
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
    token: str = Query(..., description="JWT access token"),
    device_id: str = Query(..., description="Device ID"),
) -> None:
    """WebSocket endpoint for WebRTC signaling.

    Handles SDP/ICE message exchange between peers.

    Args:
        websocket: WebSocket connection.
        token: JWT access token.
        device_id: Device identifier.
    """
    db_conn: aiosqlite.Connection | None = None

    try:
        # Get database connection
        db_gen = get_db()
        db_conn = await db_gen.__anext__()

        # Verify token and device
        try:
            user_id, verified_device_id = await verify_token_and_device(
                token, device_id, db_conn
            )
        except ValueError as e:
            logger.warning(f"Authentication failed: {e}")
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        # Connect the device
        await manager.connect(verified_device_id, websocket)

        # Send connection confirmation
        await websocket.send_json(
            {
                "type": "connected",
                "device_id": verified_device_id,
                "message": "Connected to signaling server",
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
        logger.info(f"WebSocket disconnected for device {device_id}")
    except Exception as e:
        logger.error(f"Unexpected error in WebSocket handler: {e}")
    finally:
        # Clean up
        manager.disconnect(device_id)
        if db_conn:
            await db_conn.close()
