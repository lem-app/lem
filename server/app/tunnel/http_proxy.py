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

Everything in a request frame is chosen by the remote peer, so the path is
validated and joined (never concatenated) onto the routed base URL, and the
forwarded headers are filtered. Without that, a peer could turn this handler
into an open proxy onto the loopback interface, the LAN, or a cloud metadata
endpoint.
"""

import json
import logging
from typing import Any

import aiohttp
from yarl import URL

from app.security import CLIENT_HEADER, get_api_token

from .http_frame import HTTPRequestFrame, HTTPResponseFrame, deserialize_request, serialize_response
from .router import RequestRouter, create_router_with_client_discovery

logger = logging.getLogger(__name__)

# Headers that describe a single hop and must not be forwarded (RFC 7230 §6.1),
# plus headers that would let a peer retarget or desynchronize the upstream
# request (Host), and headers aiohttp must recompute for the body it sends.
HOP_BY_HOP_HEADERS = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
    }
)

# Headers the proxy sets itself; a peer-supplied value is always discarded.
PROXY_CONTROLLED_HEADERS = frozenset({CLIENT_HEADER, "authorization", "origin", "referer"})

# Generic text returned to the peer; the real reason goes to the server log only.
GENERIC_PROXY_ERROR = "Proxy error"
GENERIC_GATEWAY_ERROR = "Bad gateway"


def validate_path(path: str) -> str:
    """Validate a peer-supplied request path.

    Args:
        path: Path (with optional query string) from the request frame

    Returns:
        The validated path

    Raises:
        ValueError: If the path could resolve to a host other than the target

    Examples:
        A path of ``@evil.example.com/v1/admin`` concatenated onto
        ``http://localhost:5142`` yields
        ``http://localhost:5142@evil.example.com/v1/admin`` - userinfo, not a
        host, so the request goes to evil.example.com. A path of
        ``//evil.example.com/x`` is protocol-relative and does the same.
        Both are rejected here.
    """
    if not path.startswith("/"):
        raise ValueError("Path must start with '/'")
    if path.startswith("//") or path.startswith("/\\"):
        raise ValueError("Path must not start with a network-path reference")
    if any(ord(char) <= 0x20 or ord(char) == 0x7F for char in path):
        raise ValueError("Path must not contain whitespace or control characters")
    return path


def build_target_url(base_url: str, path: str) -> URL:
    """Join a validated path onto a base URL without letting it change the host.

    Args:
        base_url: Routed target base URL
        path: Peer-supplied path (validated by :func:`validate_path`)

    Returns:
        Absolute URL to request

    Raises:
        ValueError: If the path is invalid or the join changed the origin
    """
    base = URL(base_url)
    url = base.join(URL(validate_path(path)))

    # Defense in depth: yarl's join must not have moved us off the target.
    if (url.scheme, url.host, url.port) != (base.scheme, base.host, base.port):
        raise ValueError("Path resolved to a different origin")
    return url


def filter_request_headers(headers: dict[str, str]) -> dict[str, str]:
    """Drop hop-by-hop and proxy-controlled headers from a peer's request.

    Args:
        headers: Peer-supplied headers

    Returns:
        Headers safe to forward upstream
    """
    return {
        name: value
        for name, value in headers.items()
        if name.lower() not in HOP_BY_HOP_HEADERS and name.lower() not in PROXY_CONTROLLED_HEADERS
    }


def error_body(message: str) -> str:
    """Build a JSON error body.

    Uses json.dumps so a message containing a quote or backslash cannot break
    out of the JSON string and produce a malformed frame.

    Args:
        message: Client-facing message

    Returns:
        JSON document as a string
    """
    return json.dumps({"error": message})


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
            # Return error response (details stay in the log, not in the frame)
            error_frame: HTTPResponseFrame = {
                "request_id": 0,  # Will be overwritten if we can parse request_id
                "status_code": 500,
                "headers": {"Content-Type": "application/json"},
                "body": error_body(GENERIC_PROXY_ERROR),
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

        # Build full URL from a validated path (never string concatenation)
        try:
            url = build_target_url(target_url, request_frame["path"])
        except ValueError as e:
            logger.warning(f"Rejected proxy request path {request_frame['path']!r}: {e}")
            return {
                "request_id": request_frame["request_id"],
                "status_code": 400,
                "headers": {"Content-Type": "application/json"},
                "body": error_body("Invalid request path"),
            }

        headers = filter_request_headers(request_frame["headers"])
        # The tunnel is an authenticated datapath, so it presents the local
        # server's own credentials rather than the peer's.
        if str(url.origin()) == str(URL(self.local_server_url).origin()):
            headers[CLIENT_HEADER] = "lem-tunnel"
            token = get_api_token()
            if token is not None:
                headers["Authorization"] = f"Bearer {token}"

        # Prepare request parameters
        kwargs: dict[str, Any] = {
            "headers": headers,
            "timeout": aiohttp.ClientTimeout(total=30),
            # Redirects are relayed to the peer, never followed here: following
            # one would let an upstream Location header pick a new host.
            "allow_redirects": False,
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
            # Return 502 Bad Gateway (details stay in the log)
            return {
                "request_id": request_frame["request_id"],
                "status_code": 502,
                "headers": {"Content-Type": "application/json"},
                "body": error_body(GENERIC_GATEWAY_ERROR),
            }

        except Exception as e:
            logger.error(f"Unexpected error forwarding request: {e}")
            # Return 500 Internal Server Error (details stay in the log)
            return {
                "request_id": request_frame["request_id"],
                "status_code": 500,
                "headers": {"Content-Type": "application/json"},
                "body": error_body(GENERIC_PROXY_ERROR),
            }
