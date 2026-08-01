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

"""Tests for tunnel datapath hardening (SSRF, header forwarding, frame caps)."""

import asyncio
import json
import struct
from collections.abc import AsyncGenerator

import pytest
import uvicorn
from fastapi import FastAPI

from app.security import ALLOWED_ORIGINS, LocalApiSecurityMiddleware
from app.tunnel.http_frame import (
    MAX_BODY_BYTES,
    MAX_HEADERS_BYTES,
    FrameType,
    HTTPRequestFrame,
    deserialize_request,
    deserialize_response,
    serialize_request,
)
from app.tunnel.http_proxy import (
    HTTPProxyHandler,
    build_target_url,
    error_body,
    filter_request_headers,
    validate_path,
)
from app.tunnel.router import RequestRouter
from app.tunnel.ws_proxy import MAX_WS_CONNECTIONS

LOCAL_SERVER = "http://localhost:5142"


# ============================================================================
# Path validation / SSRF (S3)
# ============================================================================


def test_evil_userinfo_path_is_rejected() -> None:
    """Regression: the verified open-proxy exploit.

    Concatenating this path onto the base URL produced
    http://localhost:5142@evil.example.com/v1/admin - "localhost:5142" is
    userinfo there, and the request actually goes to evil.example.com.
    """
    exploit = "@evil.example.com/v1/admin"

    with pytest.raises(ValueError):
        validate_path(exploit)
    with pytest.raises(ValueError):
        build_target_url(LOCAL_SERVER, exploit)


@pytest.mark.parametrize(
    "path",
    [
        "@evil.example.com/v1/admin",
        "//evil.example.com/v1/admin",
        "/\\evil.example.com/v1/admin",
        "http://169.254.169.254/latest/meta-data/",
        "https://evil.example.com/",
        "v1/health",
        "",
        "/v1/health\r\nX-Injected: 1",
        "/v1/health\n",
        "/v1 health",
    ],
)
def test_hostile_paths_are_rejected(path: str) -> None:
    """Anything that is not exactly one absolute path is refused."""
    with pytest.raises(ValueError):
        build_target_url(LOCAL_SERVER, path)


@pytest.mark.parametrize(
    "path,expected",
    [
        ("/v1/health", "http://localhost:5142/v1/health"),
        ("/v1/services?category=backend", "http://localhost:5142/v1/services?category=backend"),
        ("/", "http://localhost:5142/"),
        ("/@handle/profile", "http://localhost:5142/@handle/profile"),
        ("/a%20b", "http://localhost:5142/a%20b"),
    ],
)
def test_legitimate_paths_keep_the_target_host(path: str, expected: str) -> None:
    """Normal proxying still works and never leaves the routed origin."""
    url = build_target_url(LOCAL_SERVER, path)

    assert str(url) == expected
    assert url.host == "localhost"
    assert url.port == 5142


def test_metadata_endpoint_cannot_be_reached_via_path() -> None:
    """A peer cannot pivot to the cloud metadata service."""
    with pytest.raises(ValueError):
        build_target_url(LOCAL_SERVER, "@169.254.169.254/latest/meta-data/")


# ============================================================================
# Header filtering (S3)
# ============================================================================


def test_hop_by_hop_and_host_headers_are_stripped() -> None:
    """Host/Content-Length smuggling headers never reach the upstream."""
    filtered = filter_request_headers(
        {
            "Host": "evil.example.com",
            "Content-Length": "999999",
            "Transfer-Encoding": "chunked",
            "Connection": "keep-alive",
            "Upgrade": "websocket",
            "Proxy-Authorization": "Basic xxx",
            "Accept": "application/json",
        }
    )

    assert filtered == {"Accept": "application/json"}


def test_peer_cannot_supply_proxy_controlled_headers() -> None:
    """A peer cannot forge the CSRF header, credentials, or an Origin."""
    filtered = filter_request_headers(
        {
            "x-lem-client": "spoofed",
            "Authorization": "Bearer stolen",
            "Origin": "https://evil.example.com",
            "Referer": "https://evil.example.com/",
            "User-Agent": "lem-remote",
        }
    )

    assert filtered == {"User-Agent": "lem-remote"}


# ============================================================================
# Error bodies (S5)
# ============================================================================


def test_error_body_is_valid_json_for_hostile_messages() -> None:
    """f-string bodies produced malformed JSON for messages with quotes."""
    body = error_body('boom " \\ \n end')

    assert json.loads(body) == {"error": 'boom " \\ \n end'}


@pytest.mark.parametrize("attribute", ["GENERIC_PROXY_ERROR", "GENERIC_GATEWAY_ERROR"])
def test_generic_errors_carry_no_internals(attribute: str) -> None:
    """Peers get a fixed string; the cause goes to the server log."""
    from app.tunnel import http_proxy

    message: str = getattr(http_proxy, attribute)
    assert message in ("Proxy error", "Bad gateway")


async def test_forward_rejects_hostile_path_without_network_call() -> None:
    """The handler answers 400 itself rather than issuing the request."""
    handler = HTTPProxyHandler(local_server_url=LOCAL_SERVER)
    await handler.start()
    try:
        response = await handler._forward_request(
            {
                "request_id": 7,
                "method": "GET",
                "path": "@evil.example.com/v1/admin",
                "headers": {},
                "body": "",
            }
        )
    finally:
        await handler.stop()

    assert response["status_code"] == 400
    assert response["request_id"] == 7
    assert json.loads(response["body"]) == {"error": "Invalid request path"}


# ============================================================================
# Frame size caps (S6)
# ============================================================================


def _forged_request(headers_len: int, body_len: int) -> bytes:
    """Build a request frame with attacker-chosen length fields.

    Args:
        headers_len: Value to declare for headers_len
        body_len: Value to declare for body_len

    Returns:
        Serialized request frame
    """
    method = b"POST"
    path = b"/v1/x"
    headers = b"{}"
    return b"".join(
        [
            struct.pack(">B", FrameType.HTTP_REQUEST),
            struct.pack(">I", 1),
            struct.pack(">H", len(method)),
            method,
            struct.pack(">H", len(path)),
            path,
            struct.pack(">I", headers_len),
            headers,
            struct.pack(">I", body_len),
        ]
    )


def _forged_response(body_len: int) -> bytes:
    """Build a response frame with an attacker-chosen body length.

    Args:
        body_len: Value to declare for body_len

    Returns:
        Serialized response frame
    """
    headers = b"{}"
    return b"".join(
        [
            struct.pack(">B", FrameType.HTTP_RESPONSE),
            struct.pack(">I", 1),
            struct.pack(">H", 200),
            struct.pack(">I", len(headers)),
            headers,
            struct.pack(">I", body_len),
        ]
    )


def test_request_body_length_is_capped() -> None:
    """A peer can declare a 4 GiB body in the uint32 length field."""
    with pytest.raises(ValueError, match="Body too large"):
        deserialize_request(_forged_request(headers_len=2, body_len=MAX_BODY_BYTES + 1))


def test_request_body_length_uint32_max_is_capped() -> None:
    """The worst case a uint32 allows is 4 GiB - 1."""
    with pytest.raises(ValueError, match="Body too large"):
        deserialize_request(_forged_request(headers_len=2, body_len=0xFFFFFFFF))


def test_response_body_length_is_capped() -> None:
    """The same cap applies to responses coming back over the tunnel."""
    with pytest.raises(ValueError, match="Body too large"):
        deserialize_response(_forged_response(body_len=MAX_BODY_BYTES + 1))


def test_request_headers_length_is_capped() -> None:
    """Header blocks are capped too."""
    with pytest.raises(ValueError, match="Headers too large"):
        deserialize_request(_forged_request(headers_len=MAX_HEADERS_BYTES + 1, body_len=0))


def test_frames_within_the_cap_still_round_trip() -> None:
    """The cap does not break ordinary traffic."""
    original: HTTPRequestFrame = {
        "request_id": 42,
        "method": "POST",
        "path": "/v1/services/ollama/start",
        "headers": {"Content-Type": "application/json"},
        "body": '{"ok": true}',
    }

    assert deserialize_request(serialize_request(original)) == original


def test_ws_connection_cap_is_bounded() -> None:
    """Connection IDs are peer-chosen, so the socket map must be bounded."""
    assert 0 < MAX_WS_CONNECTIONS <= 256


# ============================================================================
# End to end: the tunnel still reaches a CSRF-protected local API
# ============================================================================


@pytest.fixture
async def protected_api() -> AsyncGenerator[str, None]:
    """Run a CSRF-protected API on an ephemeral port.

    Yields:
        Base URL of the running server
    """
    api = FastAPI()
    api.add_middleware(
        LocalApiSecurityMiddleware,
        allowed_origins=ALLOWED_ORIGINS,
        require_token=False,
    )

    @api.post("/v1/tunnel/disable")
    async def disable() -> dict[str, str]:
        return {"status": "ok", "mode": "offline"}

    server = uvicorn.Server(uvicorn.Config(api, host="127.0.0.1", port=0, log_level="error"))
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.02)
    else:  # pragma: no cover - only on a broken event loop
        raise AssertionError("Test server did not start")

    port: int = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


def _peer_frame(path: str) -> bytes:
    """Build a request frame carrying hostile peer-supplied headers.

    Args:
        path: Request path chosen by the peer

    Returns:
        Serialized request frame
    """
    return serialize_request(
        {
            "request_id": 99,
            "method": "POST",
            "path": path,
            "headers": {
                "Host": "evil.example.com",
                "Origin": "https://evil.example.com",
                "Content-Length": "999999",
                "X-Lem-Client": "spoofed",
            },
            "body": "",
        }
    )


async def test_tunnel_request_reaches_protected_api(protected_api: str) -> None:
    """Remote access keeps working: the proxy presents its own credentials."""
    handler = HTTPProxyHandler(local_server_url=protected_api, router=RequestRouter(protected_api))
    await handler.start()
    try:
        response = deserialize_response(
            await handler.handle_request(_peer_frame("/v1/tunnel/disable"))
        )
    finally:
        await handler.stop()

    assert response["status_code"] == 200
    assert json.loads(response["body"]) == {"status": "ok", "mode": "offline"}


async def test_tunnel_ssrf_attempt_never_leaves_the_target(protected_api: str) -> None:
    """The exploit is answered locally with 400 instead of being forwarded."""
    handler = HTTPProxyHandler(local_server_url=protected_api, router=RequestRouter(protected_api))
    await handler.start()
    try:
        frame = _peer_frame("@evil.example.com/v1/tunnel/disable")
        response = deserialize_response(await handler.handle_request(frame))
    finally:
        await handler.stop()

    assert response["status_code"] == 400
    assert response["request_id"] == 99
    assert json.loads(response["body"]) == {"error": "Invalid request path"}
