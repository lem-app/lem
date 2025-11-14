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

"""HTTP proxy handler for WebRTC DataChannel.

Receives HTTP request frames over DataChannel, forwards them to the local
Lem server or client UIs based on routing rules, and sends responses back over DataChannel.
"""

import logging
from typing import Any

import aiohttp

from .http_frame import HTTPRequestFrame, HTTPResponseFrame, deserialize_request, serialize_response
from .router import RequestRouter, create_router_with_client_discovery

logger = logging.getLogger(__name__)


class HTTPProxyHandler:
    """HTTP proxy handler for DataChannel messages.

    Forwards HTTP requests to local server or client UIs based on routing rules.
    """

    def __init__(
        self,
        local_server_url: str = "http://localhost:5142",
        router: RequestRouter | None = None,
    ) -> None:
        """Initialize HTTP proxy handler.

        Args:
            local_server_url: Base URL of local Lem server (used if router not provided)
            router: Optional custom router for advanced routing logic
        """
        self.local_server_url = local_server_url.rstrip("/")
        self.router = router or create_router_with_client_discovery(local_server_url)
        self.session: aiohttp.ClientSession | None = None

    async def start(self) -> None:
        """Start the proxy handler (create HTTP session)."""
        self.session = aiohttp.ClientSession()
        logger.info(f"HTTP proxy handler started (target: {self.local_server_url})")

    async def stop(self) -> None:
        """Stop the proxy handler (close HTTP session)."""
        if self.session and not self.session.closed:
            await self.session.close()
            self.session = None
        logger.info("HTTP proxy handler stopped")

    async def handle_request(self, data: bytes) -> bytes:
        """Handle incoming HTTP request frame.

        Args:
            data: Binary request frame

        Returns:
            Binary response frame

        Raises:
            RuntimeError: If session is not started
        """
        if self.session is None:
            raise RuntimeError("HTTP session not started")

        try:
            # Deserialize request
            request_frame = deserialize_request(data)
            logger.info(
                f"Received request {request_frame['request_id']}: "
                f"{request_frame['method']} {request_frame['path']}"
            )

            # Forward to local server
            response_frame = await self._forward_request(request_frame)

            # Serialize response
            response_data = serialize_response(response_frame)
            logger.info(
                f"Sent response {response_frame['request_id']}: {response_frame['status_code']}"
            )

            return response_data

        except Exception as e:
            logger.error(f"Error handling request: {e}")
            # Return error response
            error_frame: HTTPResponseFrame = {
                "request_id": 0,  # Will be overwritten if we can parse request_id
                "status_code": 500,
                "headers": {"Content-Type": "application/json"},
                "body": f'{{"error": "Internal proxy error: {str(e)}"}}',
            }

            # Try to extract request_id for proper correlation
            try:
                import struct

                if len(data) >= 4:
                    (request_id,) = struct.unpack(">I", data[:4])
                    error_frame["request_id"] = request_id
            except Exception:
                pass

            return serialize_response(error_frame)

    async def _forward_request(self, request_frame: HTTPRequestFrame) -> HTTPResponseFrame:
        """Forward HTTP request to appropriate target (local server or client).

        Args:
            request_frame: Deserialized request

        Returns:
            Response frame
        """
        if self.session is None:
            raise RuntimeError("HTTP session not started")

        # Use router to determine target
        target_url = self.router.route(request_frame["path"])

        # Build full URL
        url = f"{target_url}{request_frame['path']}"

        # Prepare request parameters
        kwargs: dict[str, Any] = {
            "headers": request_frame["headers"],
            "timeout": aiohttp.ClientTimeout(total=30),
        }

        # Add body if present
        if request_frame["body"]:
            kwargs["data"] = request_frame["body"]

        try:
            # Make request to local server
            async with self.session.request(request_frame["method"], url, **kwargs) as response:
                # Read response body
                body = await response.text()

                # Convert headers to dict
                headers = dict(response.headers)

                # Create response frame
                response_frame: HTTPResponseFrame = {
                    "request_id": request_frame["request_id"],
                    "status_code": response.status,
                    "headers": headers,
                    "body": body,
                }

                return response_frame

        except aiohttp.ClientError as e:
            logger.error(f"HTTP client error: {e}")
            # Return 502 Bad Gateway
            return {
                "request_id": request_frame["request_id"],
                "status_code": 502,
                "headers": {"Content-Type": "application/json"},
                "body": f'{{"error": "Bad Gateway: {str(e)}"}}',
            }

        except Exception as e:
            logger.error(f"Unexpected error forwarding request: {e}")
            # Return 500 Internal Server Error
            return {
                "request_id": request_frame["request_id"],
                "status_code": 500,
                "headers": {"Content-Type": "application/json"},
                "body": f'{{"error": "Internal Server Error: {str(e)}"}}',
            }
