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

"""Message dispatcher for routing DataChannel frames by type.

Routes incoming binary frames to appropriate handlers based on frame type:
- 0x01 HTTP_REQUEST → HTTPProxyHandler
- 0x02 HTTP_RESPONSE → (not expected from client)
- 0x10 WS_CONNECT → WSProxyHandler
- 0x11 WS_DATA → WSProxyHandler
- 0x12 WS_CLOSE → WSProxyHandler
"""

import logging
import struct

from .http_frame import FrameType
from .http_proxy import HTTPProxyHandler
from .ws_proxy import WSProxyHandler

logger = logging.getLogger(__name__)


class MessageDispatcher:
    """Dispatches DataChannel messages to appropriate handlers based on frame type."""

    def __init__(
        self,
        http_handler: HTTPProxyHandler,
        ws_handler: WSProxyHandler,
    ) -> None:
        """Initialize message dispatcher.

        Args:
            http_handler: HTTP proxy handler
            ws_handler: WebSocket proxy handler
        """
        self.http_handler = http_handler
        self.ws_handler = ws_handler

    async def dispatch(self, data: bytes) -> bytes | None:
        """Dispatch incoming message to appropriate handler.

        Args:
            data: Binary frame from DataChannel

        Returns:
            Response bytes to send back (for HTTP), or None (for WebSocket)

        Raises:
            ValueError: If frame type is unknown
        """
        if len(data) < 1:
            raise ValueError("Frame too short (no frame type)")

        # Read frame type (first byte)
        (frame_type,) = struct.unpack(">B", data[:1])

        logger.debug(f"Dispatching frame type: 0x{frame_type:02x}")

        # Dispatch based on frame type
        if frame_type == FrameType.HTTP_REQUEST:
            # HTTP request → HTTPProxyHandler
            # Returns response bytes
            return await self.http_handler.handle_request(data)

        elif frame_type == FrameType.HTTP_RESPONSE:
            # HTTP response from client (unexpected)
            logger.warning("Received HTTP_RESPONSE from client (unexpected)")
            return None

        elif frame_type == FrameType.WS_CONNECT:
            # WebSocket CONNECT → WSProxyHandler
            await self.ws_handler.handle_connect(data)
            return None

        elif frame_type == FrameType.WS_DATA:
            # WebSocket DATA → WSProxyHandler
            await self.ws_handler.handle_data(data)
            return None

        elif frame_type == FrameType.WS_CLOSE:
            # WebSocket CLOSE → WSProxyHandler
            await self.ws_handler.handle_close(data)
            return None

        else:
            # Unknown frame type
            raise ValueError(f"Unknown frame type: 0x{frame_type:02x}")
