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

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from ..core.security import validate_token
from ..core.session_manager import session_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/relay", tags=["relay"])


@router.websocket("/{session_id}")
async def relay_websocket(websocket: WebSocket, session_id: str, token: str | None = None) -> None:
    """WebSocket relay endpoint.

    Connects two WebSocket clients via a relay session. Frames from one client
    are forwarded to the other bidirectionally.

    Args:
        websocket: WebSocket connection.
        session_id: Unique session identifier (shared by both clients).
        token: JWT access token for authentication (query parameter).

    Raises:
        HTTPException: If authentication fails.
    """
    # Validate JWT token
    if token is None or not validate_token(token):
        logger.warning(f"Session {session_id}: Authentication failed")
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Invalid token")
        return

    logger.info(f"Session {session_id}: WebSocket connection request")

    # Accept the WebSocket connection
    await websocket.accept()

    try:
        # Get or create session
        session = await session_manager.get_or_create_session(session_id)

        # Add this WebSocket to the session
        both_connected = session.add_connection(websocket)

        # Start forwarding (will wait if needed)
        await session.start_forwarding(both_connected)

    except WebSocketDisconnect:
        logger.info(f"Session {session_id}: WebSocket disconnected")
    except Exception as e:
        logger.error(f"Session {session_id}: Error in relay: {e}", exc_info=True)
    finally:
        # Clean up session
        await session_manager.remove_session(session_id)
