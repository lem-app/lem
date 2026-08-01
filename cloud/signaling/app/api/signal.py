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
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from jose import JWTError

from ..core.config import settings
from ..core.crypto import SIGNAL_CONTEXT, new_challenge, verify_signature
from ..core.errors import RETRYABLE_REASONS, ErrorReason
from ..core.ratelimit import signal_connect_limiter
from ..core.security import (
    create_relay_grant,
    decode_access_token,
    new_relay_session_id,
)
from ..db import USE_POSTGRES, DBConnection, DBRow, as_postgres, as_sqlite, get_db

router = APIRouter(tags=["signaling"])
logger = logging.getLogger(__name__)

# Maximum accepted signaling frame. Checked before parsing; uvicorn is
# additionally started with --ws-max-size so oversized frames are rejected at
# the transport instead of being buffered in full first.
MAX_MESSAGE_BYTES = 64 * 1024

# Seconds a client has to complete each step of the handshake.
AUTH_TIMEOUT_SECONDS = 10.0

# One message for every routing failure. Distinguishing "no such device" from
# "device offline" would turn this endpoint into a presence oracle for devices
# the caller does not own.
TARGET_UNAVAILABLE = "Target device is not available"

# Told to a client that still puts its credential in the query string. It is a
# distinct, actionable message rather than a generic auth failure, because the
# cure is upgrading the client and nothing the user does will help.
UPGRADE_REQUIRED_MESSAGE = (
    "This signaling server no longer accepts ?token= credentials. Update your "
    'Lem client: send {"type":"auth","token":"<JWT>","device_id":"<id>"} as the '
    "first message, then answer the challenge frame with an ed25519 "
    "auth-response."
)


@contextlib.asynccontextmanager
async def db_connection() -> AsyncIterator[DBConnection]:
    """Borrow a database connection for the duration of a single query.

    The WebSocket handler used to hold one connection for the entire lifetime
    of the socket. With an asyncpg pool of at most 10, roughly ten connected
    devices exhausted the pool and every further query blocked.

    Yields:
        A database connection, returned to the pool on exit.
    """
    generator = get_db()
    connection = await anext(generator)
    try:
        yield connection
    finally:
        await generator.aclose()


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

    async def disconnect(self, device_id: str, websocket: WebSocket) -> None:
        """Deregister a device, but only if it still owns the registry entry.

        On reconnect the replaced handler's cleanup runs *after* the new
        connection has registered. Without the identity check below that stale
        cleanup deleted the live connection, and the device silently stopped
        receiving anything.

        Args:
            device_id: Device identifier.
            websocket: The connection being cleaned up.
        """
        async with self._lock:
            if self.active_connections.get(device_id) is websocket:
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
                await self.disconnect(device_id, websocket)
                return False
        return False


manager = ConnectionManager()


async def fetch_device_pubkey(device_id: str, user_id: int) -> str | None:
    """Look up a device's public key, scoped to its owner.

    Args:
        device_id: Device identifier.
        user_id: User the device must belong to.

    Returns:
        The stored base64 public key, or None if the user does not own it.
    """
    device: DBRow | None
    async with db_connection() as db:
        if USE_POSTGRES:
            device = await as_postgres(db).fetchrow(
                "SELECT pubkey FROM devices WHERE id = $1 AND user_id = $2",
                device_id,
                user_id,
            )
        else:
            async with as_sqlite(db).execute(
                "SELECT pubkey FROM devices WHERE id = ? AND user_id = ?",
                (device_id, user_id),
            ) as cursor:
                device = await cursor.fetchone()
    return None if device is None else str(device["pubkey"])


async def fetch_owned_device_ids(user_id: int) -> set[str]:
    """Fetch every device id belonging to a user.

    Args:
        user_id: Owner to look up.

    Returns:
        Set of device identifiers owned by the user.
    """
    async with db_connection() as db:
        if USE_POSTGRES:
            rows = await as_postgres(db).fetch("SELECT id FROM devices WHERE user_id = $1", user_id)
            return {str(row["id"]) for row in rows}
        async with as_sqlite(db).execute(
            "SELECT id FROM devices WHERE user_id = ?", (user_id,)
        ) as cursor:
            return {str(row["id"]) for row in await cursor.fetchall()}


class OwnedDeviceCache:
    """The set of devices an authenticated connection is allowed to talk to.

    Signaling previously routed on whatever ``target_device_id`` the sender
    supplied, so any account could push messages to a stranger's device. Every
    routed message is now checked against this set.

    The set is cached per connection and refreshed at most every
    ``REFRESH_INTERVAL_SECONDS`` on a miss, so a device registered after the
    socket opened becomes reachable shortly afterwards without letting a
    hostile client trigger a database query per message.
    """

    REFRESH_INTERVAL_SECONDS = 5.0

    def __init__(self, user_id: int) -> None:
        """Initialize the cache.

        Args:
            user_id: Authenticated owner whose devices may be addressed.
        """
        self.user_id = user_id
        self._owned: set[str] = set()
        self._loaded_at = float("-inf")

    async def owns(self, device_id: str) -> bool:
        """Check whether the authenticated user owns a device.

        Args:
            device_id: Candidate target device.

        Returns:
            True if the device belongs to this connection's user.
        """
        if device_id in self._owned:
            return True
        if time.monotonic() - self._loaded_at < self.REFRESH_INTERVAL_SECONDS:
            return False
        await self.refresh()
        return device_id in self._owned

    async def refresh(self) -> None:
        """Reload the owned-device set from the database."""
        self._owned = await fetch_owned_device_ids(self.user_id)
        self._loaded_at = time.monotonic()


async def verify_token_and_device(token: str, device_id: str) -> tuple[int, str]:
    """Verify a JWT token and that the caller owns the device it claims.

    Args:
        token: JWT access token.
        device_id: Device ID to verify.

    Returns:
        Tuple of (user_id, stored device public key).

    Raises:
        ValueError: If token is invalid or device doesn't belong to user.
    """
    try:
        payload = decode_access_token(token)
    except JWTError as e:
        raise ValueError(f"Invalid token: {e}") from e

    user_id: int | None = payload.get("user_id")
    if user_id is None:
        raise ValueError("Invalid token: missing user_id")

    pubkey = await fetch_device_pubkey(device_id, user_id)
    if pubkey is None:
        raise ValueError(f"Device {device_id} not found for user {user_id}")

    return user_id, pubkey


async def receive_json_message(websocket: WebSocket, timeout: float | None = None) -> Any:
    """Receive one text frame and parse it, enforcing the size limit first.

    Args:
        websocket: Connection to read from.
        timeout: Optional seconds to wait before giving up.

    Returns:
        The parsed JSON value.

    Raises:
        TimeoutError: If no frame arrives within the timeout.
        ValueError: If the frame is too large or is not valid JSON.
    """
    if timeout is None:
        data = await websocket.receive_text()
    else:
        data = await asyncio.wait_for(websocket.receive_text(), timeout=timeout)

    # Check the size before handing anything to the JSON parser.
    if len(data.encode("utf-8")) > MAX_MESSAGE_BYTES:
        raise ValueError(f"Message exceeds {MAX_MESSAGE_BYTES} byte limit")

    try:
        return json.loads(data)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid JSON: {e}") from e


async def authenticate_connection(websocket: WebSocket) -> tuple[int, str] | None:
    """Authenticate a signaling connection and prove device key possession.

    Credentials are only ever read from the ``auth`` message. The old
    ``?token=`` query parameter is gone: it put a credential in the request
    line, where uvicorn's access log and nginx's default log format both
    record it in plaintext on every documented deployment.

    Args:
        websocket: Accepted WebSocket connection.

    Returns:
        Tuple of (user_id, device_id) on success, None if the socket was closed.
    """
    try:
        auth_msg = await receive_json_message(websocket, timeout=AUTH_TIMEOUT_SECONDS)
    except TimeoutError:
        logger.warning("Auth timeout - no auth message received")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return None
    except ValueError as e:
        await close_with_error(websocket, f"Invalid auth message: {e}", ErrorReason.PROTOCOL_ERROR)
        return None

    if not isinstance(auth_msg, dict) or auth_msg.get("type") != "auth":
        await close_with_error(
            websocket, "First message must be auth message", ErrorReason.PROTOCOL_ERROR
        )
        return None

    auth_token = auth_msg.get("token")
    auth_device_id = auth_msg.get("device_id")

    if not isinstance(auth_token, str) or not isinstance(auth_device_id, str):
        await close_with_error(
            websocket,
            "Auth message missing token or device_id",
            ErrorReason.PROTOCOL_ERROR,
        )
        return None

    if not auth_token or not auth_device_id:
        await close_with_error(
            websocket,
            "Auth message missing token or device_id",
            ErrorReason.PROTOCOL_ERROR,
        )
        return None

    try:
        user_id, pubkey = await verify_token_and_device(auth_token, auth_device_id)
    except ValueError as e:
        logger.warning(f"Authentication failed: {e}")
        await close_with_error(websocket, "Authentication failed", ErrorReason.AUTH_FAILED)
        return None

    # Proof of possession. The account token alone only proves the caller has
    # an account; this proves the caller holds the device's private key.
    challenge = new_challenge()
    await websocket.send_json(
        {
            "type": "challenge",
            "device_id": auth_device_id,
            "challenge": challenge,
            "context": SIGNAL_CONTEXT.decode("ascii"),
        }
    )

    try:
        response = await receive_json_message(websocket, timeout=AUTH_TIMEOUT_SECONDS)
    except TimeoutError:
        logger.warning(f"Challenge timeout for device {auth_device_id}")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return None
    except ValueError as e:
        await close_with_error(
            websocket, f"Invalid challenge response: {e}", ErrorReason.PROTOCOL_ERROR
        )
        return None

    if not isinstance(response, dict) or response.get("type") != "auth-response":
        await close_with_error(
            websocket, "Expected auth-response message", ErrorReason.PROTOCOL_ERROR
        )
        return None

    signature = response.get("signature")
    if not isinstance(signature, str) or not verify_signature(
        pubkey, SIGNAL_CONTEXT, auth_device_id, challenge, signature
    ):
        logger.warning(f"Device key proof failed for {auth_device_id} (user {user_id})")
        await close_with_error(
            websocket,
            "Device key verification failed",
            ErrorReason.DEVICE_KEY_VERIFICATION_FAILED,
        )
        return None

    return user_id, auth_device_id


def error_frame(message: str, reason: str) -> dict[str, Any]:
    """Build a classified error frame.

    ``reason`` and ``retryable`` travel on the frame itself so a client never
    has to infer permanence from a close code that arrives separately, and may
    not arrive at all if the socket drops first.

    Args:
        message: Human-readable reason.
        reason: Machine-readable reason code from ``ErrorReason``.

    Returns:
        The frame to send.
    """
    return {
        "type": "error",
        "message": message,
        "reason": reason,
        "retryable": reason in RETRYABLE_REASONS,
    }


async def close_with_error(websocket: WebSocket, message: str, reason: str) -> None:
    """Send a classified error frame then close the connection.

    Args:
        websocket: Connection to close.
        message: Human-readable reason.
        reason: Machine-readable reason code from ``ErrorReason``.
    """
    with contextlib.suppress(Exception):
        await websocket.send_json(error_frame(message, reason))
    with contextlib.suppress(Exception):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)


async def route_message(
    websocket: WebSocket,
    message: dict[str, Any],
    device_id: str,
    user_id: int,
    owned: OwnedDeviceCache,
) -> None:
    """Validate and route one signaling message.

    Args:
        websocket: Sender's connection.
        message: Parsed message.
        device_id: Authenticated sender device id.
        user_id: Authenticated sender user id.
        owned: Devices the sender is allowed to address.
    """
    target_device_id = message.get("target_device_id")
    msg_type = message.get("type")
    if not isinstance(msg_type, str) or not isinstance(target_device_id, str):
        await websocket.send_json(
            error_frame(
                "Invalid message format: missing type or target_device_id",
                ErrorReason.PROTOCOL_ERROR,
            )
        )
        return

    # Authorization: a device may only be addressed by its own owner.
    if not await owned.owns(target_device_id):
        logger.warning(
            f"Blocked cross-user routing: device {device_id} (user {user_id}) "
            f"targeted {target_device_id}"
        )
        await websocket.send_json(error_frame(TARGET_UNAVAILABLE, ErrorReason.TARGET_UNAVAILABLE))
        return

    if msg_type == "connect-request":
        await handle_connect_request(websocket, message, device_id, target_device_id, user_id)
        return

    if msg_type == "connect-ack":
        notification: dict[str, Any] = {
            "type": "connect-ack-received",
            "from_device_id": device_id,
            "transport": message.get("transport"),
            "relay_session_id": message.get("relay_session_id"),
            "status": message.get("status"),
        }
        delivered = await manager.send_message(target_device_id, notification)
    else:
        # Generic message routing (WebRTC signaling, etc.)
        message["sender_device_id"] = device_id
        delivered = await manager.send_message(target_device_id, message)

    if delivered:
        logger.info(f"Routed {msg_type} from {device_id} to {target_device_id}")
        await websocket.send_json(
            {"type": "ack", "message": f"Message delivered to {target_device_id}"}
        )
    else:
        logger.info(f"Target device {target_device_id} owned but not connected")
        await websocket.send_json(error_frame(TARGET_UNAVAILABLE, ErrorReason.TARGET_UNAVAILABLE))


async def handle_connect_request(
    websocket: WebSocket,
    message: dict[str, Any],
    device_id: str,
    target_device_id: str,
    user_id: int,
) -> None:
    """Mint a relay session for two devices owned by the same user.

    The session id and both grants are minted here rather than chosen by the
    client. A client-chosen id was guessable and bound to nobody, so any
    account could join the resulting relay session.

    Args:
        websocket: Requester's connection.
        message: Parsed connect-request message.
        device_id: Authenticated requester device id.
        target_device_id: Device to connect to, already checked for ownership.
        user_id: Owner of both devices.
    """
    if target_device_id == device_id:
        await websocket.send_json(
            error_frame("Cannot open a relay session to the same device", ErrorReason.SAME_DEVICE)
        )
        return

    preferred_transport = message.get("preferred_transport", "auto")
    session_id = new_relay_session_id()

    notification: dict[str, Any] = {
        "type": "connect-request-received",
        "from_device_id": device_id,
        "preferred_transport": preferred_transport,
        "relay_session_id": session_id,
        "relay_url": settings.relay_url,
        "relay_token": create_relay_grant(session_id, target_device_id, device_id, user_id),
        "relay_token_expires_in": settings.relay_grant_ttl_seconds,
    }

    delivered = await manager.send_message(target_device_id, notification)
    if not delivered:
        logger.info(f"Target device {target_device_id} owned but not connected")
        await websocket.send_json(error_frame(TARGET_UNAVAILABLE, ErrorReason.TARGET_UNAVAILABLE))
        return

    logger.info(f"Minted relay session for {device_id} <-> {target_device_id}")
    await websocket.send_json(
        {
            "type": "connect-request-sent",
            "target_device_id": target_device_id,
            "relay_session_id": session_id,
            "relay_url": settings.relay_url,
            "relay_token": create_relay_grant(session_id, device_id, target_device_id, user_id),
            "relay_token_expires_in": settings.relay_grant_ttl_seconds,
        }
    )


@router.websocket("/signal")
async def websocket_signal_endpoint(websocket: WebSocket) -> None:
    """WebSocket endpoint for WebRTC signaling.

    Handles SDP/ICE message exchange between devices belonging to the same
    user. The handshake is: an ``auth`` message, then a server-issued
    ``challenge`` the client answers with an ``auth-response`` carrying an
    ed25519 signature.

    A request carrying a ``?token=`` query parameter is refused outright with
    an explicit upgrade message rather than hanging or failing generically.

    Args:
        websocket: WebSocket connection.
    """
    client = websocket.client
    source = client.host if client is not None else "unknown"
    if not signal_connect_limiter.check(source):
        logger.warning(f"Signaling connection rate limit exceeded for {source}")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()

    if "token" in websocket.query_params:
        logger.warning(f"Refused query-string credential from {source}")
        await close_with_error(websocket, UPGRADE_REQUIRED_MESSAGE, ErrorReason.UNSUPPORTED_CLIENT)
        return

    try:
        identity = await authenticate_connection(websocket)
    except WebSocketDisconnect:
        # A client hanging up mid-handshake is ordinary, not an error.
        logger.info("Client disconnected during signaling handshake")
        return
    if identity is None:
        return
    user_id, verified_device_id = identity

    owned = OwnedDeviceCache(user_id)
    await owned.refresh()

    await manager.register(verified_device_id, websocket)

    try:
        await websocket.send_json(
            {
                "type": "connected",
                "device_id": verified_device_id,
                "message": "Connected to signaling server",
                "ice_servers": settings.ice_servers,
            }
        )

        while True:
            try:
                message = await receive_json_message(websocket)
            except ValueError as e:
                # Oversized or unparseable frames end the connection rather
                # than being answered, so a peer cannot keep spending server
                # time on frames it knows are invalid.
                logger.warning(f"Closing {verified_device_id}: {e}")
                await close_with_error(websocket, str(e), ErrorReason.PROTOCOL_ERROR)
                return

            if not isinstance(message, dict):
                await websocket.send_json(
                    error_frame("Message must be a JSON object", ErrorReason.PROTOCOL_ERROR)
                )
                continue

            try:
                await route_message(websocket, message, verified_device_id, user_id, owned)
            except WebSocketDisconnect:
                raise
            except Exception as e:
                logger.error(f"Error processing message: {e}")
                await websocket.send_json(error_frame("Internal error", ErrorReason.INTERNAL_ERROR))

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for device {verified_device_id}")
    except Exception as e:
        logger.error(f"Unexpected error in WebSocket handler: {e}")
    finally:
        await manager.disconnect(verified_device_id, websocket)
