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

"""WebSocket relay endpoint."""

import asyncio
import contextlib
import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from ..core.security import InvalidGrantError, SessionGrant, decode_session_grant
from ..core.session_manager import JoinRejectedError, session_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/relay", tags=["relay"])

# Seconds a client has to send its auth message after connecting.
AUTH_TIMEOUT_SECONDS = 10.0

# Longest accepted auth frame. The grant is a JWT, so this is generous.
MAX_AUTH_FRAME_BYTES = 8 * 1024


async def close_with_error(websocket: WebSocket, message: str, code: int) -> None:
    """Send an error frame then close the connection.

    Args:
        websocket: Connection to close.
        message: Human-readable reason.
        code: WebSocket close code.
    """
    with contextlib.suppress(Exception):
        await websocket.send_json({"type": "error", "message": message})
    with contextlib.suppress(Exception):
        await websocket.close(code=code)


async def authenticate(
    websocket: WebSocket, session_id: str, token: str | None
) -> SessionGrant | None:
    """Read and verify the caller's session grant.

    Args:
        websocket: Accepted WebSocket connection.
        session_id: Session identifier from the request path.
        token: Grant supplied as a query parameter, if any.

    Returns:
        The verified grant, or None if the connection was closed.
    """
    grant_token = token

    if grant_token is None:
        try:
            auth_data = await asyncio.wait_for(
                websocket.receive_text(), timeout=AUTH_TIMEOUT_SECONDS
            )
        except TimeoutError:
            logger.warning(f"Session {session_id}: Auth timeout")
            with contextlib.suppress(Exception):
                await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return None
        except WebSocketDisconnect:
            return None

        if len(auth_data.encode("utf-8")) > MAX_AUTH_FRAME_BYTES:
            await close_with_error(
                websocket, "Auth message too large", status.WS_1009_MESSAGE_TOO_BIG
            )
            return None

        try:
            auth_msg = json.loads(auth_data)
        except json.JSONDecodeError:
            await close_with_error(
                websocket, "Invalid JSON in auth message", status.WS_1008_POLICY_VIOLATION
            )
            return None

        if not isinstance(auth_msg, dict) or auth_msg.get("type") != "auth":
            await close_with_error(
                websocket, "First message must be auth message", status.WS_1008_POLICY_VIOLATION
            )
            return None

        grant_token = auth_msg.get("token")

    if not isinstance(grant_token, str) or not grant_token:
        await close_with_error(
            websocket, "Auth message missing token", status.WS_1008_POLICY_VIOLATION
        )
        return None

    try:
        return decode_session_grant(grant_token, session_id)
    except InvalidGrantError as e:
        # Log the reason, but tell the client nothing that would help it probe
        # for valid session ids.
        logger.warning(f"Session {session_id}: grant rejected: {e}")
        await close_with_error(
            websocket, "Authentication failed", status.WS_1008_POLICY_VIOLATION
        )
        return None


@router.websocket("/{session_id}")
async def relay_websocket(
    websocket: WebSocket,
    session_id: str,
    token: str | None = Query(
        None, description="Relay session grant (deprecated, use auth message)"
    ),
) -> None:
    """WebSocket relay endpoint.

    Connects the two devices named in a relay session grant. Frames from one
    are forwarded to the other bidirectionally.

    The grant is minted by the signaling server after it has confirmed that
    both devices belong to the same account. It names the session, the bearer
    and the single permitted peer, so an unrelated account holding a perfectly
    valid login token cannot join.

    Authentication is provided by either:
    1. A ``token`` query parameter (deprecated, token visible in logs).
    2. A first message ``{"type": "auth", "token": "<grant>"}`` (preferred).

    Args:
        websocket: WebSocket connection.
        session_id: Session identifier, minted by the signaling server.
        token: Relay session grant (optional, deprecated).
    """
    await websocket.accept()

    grant = await authenticate(websocket, session_id, token)
    if grant is None:
        return

    try:
        session, connection = await session_manager.join(session_id, grant, websocket)
    except JoinRejectedError as e:
        logger.warning(f"Session {session_id}: join rejected for {grant.device_id}: {e.reason}")
        await close_with_error(websocket, e.reason, e.code)
        return

    logger.info(f"Session {session_id}: {grant.device_id} authenticated")

    try:
        await session.run(connection)
    except WebSocketDisconnect:
        logger.info(f"Session {session_id}: WebSocket disconnected")
    except Exception as e:
        logger.error(f"Session {session_id}: Error in relay: {e}", exc_info=True)
    finally:
        await session_manager.leave(session_id, session)
