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

"""Tests for tunnel datapath hardening (SSRF, header forwarding, frame caps).

Ported from the v2 layout to v3 frames. Every attack PR #25 established is
still here and still asserted; only the framing the attack rides in changed,
because v3's handler emits frames rather than returning a response blob. The
path validator, the header filters, the redirect policy and the generic error
bodies are all unchanged code.
"""

import asyncio
import json
import struct
from collections.abc import AsyncGenerator

import pytest
import uvicorn
from fastapi import FastAPI

from app.security import ALLOWED_ORIGINS, LocalApiSecurityMiddleware
from app.tunnel.errors import TunnelProtocolError
from app.tunnel.http_frame import (
    MAX_BODY_BYTES,
    MAX_HEADERS_BYTES,
    FrameType,
    HTTPRequestHeadFrame,
    deserialize_request_head,
    serialize_request_head,
)
from app.tunnel.http_proxy import (
    MAX_PATH_LENGTH,
    RequestIntake,
    build_target_url,
    error_body,
    filter_request_headers,
    filter_response_headers,
    validate_path,
)
from app.tunnel.router import RequestRouter
from app.tunnel.ws_proxy import MAX_WS_CONNECTIONS

from .proxy_harness import authorized_handler, send_request

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
        [
            ("Host", "evil.example.com"),
            ("Content-Length", "999999"),
            ("Transfer-Encoding", "chunked"),
            ("Connection", "keep-alive"),
            ("Upgrade", "websocket"),
            ("Proxy-Authorization", "Basic xxx"),
            ("Accept", "application/json"),
        ]
    )

    assert filtered == [("Accept", "application/json")]


def test_peer_cannot_supply_proxy_controlled_headers() -> None:
    """A peer cannot forge the CSRF header, credentials, or an Origin."""
    filtered = filter_request_headers(
        [
            ("x-lem-client", "spoofed"),
            ("Authorization", "Bearer stolen"),
            ("Origin", "https://evil.example.com"),
            ("Referer", "https://evil.example.com/"),
            ("User-Agent", "lem-remote"),
        ]
    )

    assert filtered == [("User-Agent", "lem-remote")]


def test_upstream_response_headers_are_filtered() -> None:
    """Hop-by-hop and framing headers never cross back to the peer.

    Ordinary application headers still do - the proxy fronts arbitrary client
    UIs, so this is a denylist mirroring the request side, not an allowlist.
    """
    filtered = filter_response_headers(
        [
            ("Connection", "close"),
            ("Transfer-Encoding", "chunked"),
            ("Content-Length", "12"),
            ("Content-Encoding", "gzip"),
            ("Set-Cookie2", "session=secret; Version=1"),
            ("X-Frame-Options", "DENY"),
            ("Content-Type", "application/json"),
        ]
    )

    assert filtered == [
        ("X-Frame-Options", "DENY"),
        ("Content-Type", "application/json"),
    ]


def test_set_cookie_crosses_the_tunnel_verbatim() -> None:
    """#72: blocking this header meant no framed app could ever log in.

    The server relays the cookie exactly as the upstream wrote it. Re-scoping
    it to ``/app/<deviceId>/<serviceId>/`` happens in the Service Worker, the
    only side that knows the device segment - the far side *is* the device, so
    the id is never on the wire. Rewriting here would require inventing it.
    """
    upstream = "session=secret; Path=/; Domain=app.local; HttpOnly; Secure; SameSite=Lax"

    filtered = filter_response_headers([("Set-Cookie", upstream), ("Content-Type", "text/html")])

    assert filtered == [("Set-Cookie", upstream), ("Content-Type", "text/html")]


def test_every_set_cookie_on_a_response_survives_separately() -> None:
    """Cookies are not foldable into one header; a login sets several.

    ``dict(response.headers)`` - what v2 did - would keep only ``third``.
    """
    filtered = filter_response_headers(
        [
            ("Set-Cookie", "first=1; Path=/"),
            ("Set-Cookie", "second=2; Path=/admin"),
            ("Content-Type", "text/html"),
            ("Set-Cookie", "third=3"),
        ]
    )

    assert filtered == [
        ("Set-Cookie", "first=1; Path=/"),
        ("Set-Cookie", "second=2; Path=/admin"),
        ("Content-Type", "text/html"),
        ("Set-Cookie", "third=3"),
    ]


def test_duplicate_response_headers_survive_the_filter() -> None:
    """v3 change: pairs, not a dict.

    ``dict(response.headers)`` kept only the last value of every repeated
    header. The pair list preserves order and duplicates, which is what makes
    multi-valued headers representable at all.
    """
    filtered = filter_response_headers(
        [("Link", "<a>; rel=next"), ("Link", "<b>; rel=prev"), ("Vary", "Accept")]
    )

    assert filtered == [("Link", "<a>; rel=next"), ("Link", "<b>; rel=prev"), ("Vary", "Accept")]


def test_absurdly_long_paths_are_rejected() -> None:
    """Defense in depth: the validator caps length itself."""
    with pytest.raises(ValueError, match="too long"):
        validate_path("/" + "a" * MAX_PATH_LENGTH)


# ============================================================================
# Error bodies (S5)
# ============================================================================


def test_error_body_is_valid_json_for_hostile_messages() -> None:
    """f-string bodies produced malformed JSON for messages with quotes."""
    body = error_body('boom " \\ \n end')

    assert json.loads(body) == {"error": 'boom " \\ \n end'}


@pytest.mark.parametrize(
    "attribute", ["GENERIC_PROXY_ERROR", "GENERIC_GATEWAY_ERROR", "GENERIC_TOO_LARGE"]
)
def test_generic_errors_carry_no_internals(attribute: str) -> None:
    """Peers get a fixed string; the cause goes to the server log."""
    from app.tunnel import http_proxy

    message: str = getattr(http_proxy, attribute)
    assert message in ("Proxy error", "Bad gateway", "Payload too large")


async def test_forward_rejects_hostile_path_without_network_call() -> None:
    """The handler answers 400 itself rather than issuing the request."""
    handler, collector = authorized_handler(LOCAL_SERVER)
    await handler.start()
    try:
        await handler._forward_request(
            7,
            RequestIntake(method="GET", path="@evil.example.com/v1/admin", headers=[]),
        )
    finally:
        await handler.stop()

    response = collector.response_for(7)
    assert response.status_code == 400
    assert json.loads(response.body) == {"error": "Invalid request path"}


# ============================================================================
# Frame size caps (S6)
# ============================================================================


def _forged_head(headers_len: int, path_len: int = 5) -> bytes:
    """Build a request head with attacker-chosen length fields.

    Args:
        headers_len: Value to declare for headers_len
        path_len: Value to declare for path_len

    Returns:
        Serialized request head frame
    """
    method = b"POST"
    path = b"/v1/x"
    return b"".join(
        [
            struct.pack(">B", FrameType.HTTP_REQUEST_HEAD),
            struct.pack(">I", 1),
            struct.pack(">B", 0),
            struct.pack(">H", len(method)),
            method,
            struct.pack(">H", path_len),
            path,
            struct.pack(">I", headers_len),
            b"[]",
        ]
    )


def _forged_chunk(frame_type: int, payload_len: int) -> bytes:
    """Build a chunk frame with an attacker-chosen payload length.

    Args:
        frame_type: HTTP_REQUEST_CHUNK or HTTP_RESPONSE_CHUNK
        payload_len: Value to declare for payload_len

    Returns:
        Serialized chunk frame
    """
    return b"".join(
        [
            struct.pack(">B", frame_type),
            struct.pack(">I", 1),
            struct.pack(">B", 0),
            struct.pack(">I", payload_len),
            b"0123456789",
        ]
    )


def test_request_chunk_length_is_capped() -> None:
    """A peer can declare a 4 GiB payload in the uint32 length field."""
    from app.tunnel.http_frame import MAX_CHUNK_BYTES, deserialize_chunk

    with pytest.raises(TunnelProtocolError, match="Chunk too large"):
        deserialize_chunk(_forged_chunk(FrameType.HTTP_REQUEST_CHUNK, MAX_CHUNK_BYTES + 1))


def test_chunk_length_uint32_max_is_capped() -> None:
    """The worst case a uint32 allows is 4 GiB - 1."""
    from app.tunnel.http_frame import deserialize_chunk

    with pytest.raises(TunnelProtocolError, match="Chunk too large"):
        deserialize_chunk(_forged_chunk(FrameType.HTTP_REQUEST_CHUNK, 0xFFFFFFFF))


def test_response_chunk_length_is_capped() -> None:
    """The same cap applies to responses coming back over the tunnel."""
    from app.tunnel.http_frame import deserialize_chunk

    with pytest.raises(TunnelProtocolError, match="Chunk too large"):
        deserialize_chunk(_forged_chunk(FrameType.HTTP_RESPONSE_CHUNK, 0xFFFFFFFF))


def test_request_headers_length_is_capped() -> None:
    """Header blocks are capped too."""
    with pytest.raises(TunnelProtocolError, match="Headers too large"):
        deserialize_request_head(_forged_head(headers_len=MAX_HEADERS_BYTES + 1))


def test_declared_path_length_is_capped() -> None:
    """path_len is peer-chosen; the cap is checked before the slice."""
    with pytest.raises(TunnelProtocolError, match="Path too large"):
        deserialize_request_head(_forged_head(headers_len=2, path_len=0xFFFF))


def test_frames_within_the_cap_still_round_trip() -> None:
    """The cap does not break ordinary traffic."""
    original: HTTPRequestHeadFrame = {
        "request_id": 42,
        "method": "POST",
        "path": "/v1/services/ollama/start",
        "headers": [("Content-Type", "application/json")],
        "body_follows": True,
    }

    assert deserialize_request_head(serialize_request_head(original)) == original


def test_ws_connection_cap_is_bounded() -> None:
    """Connection IDs are peer-chosen, so the socket map must be bounded."""
    assert 0 < MAX_WS_CONNECTIONS <= 256


def test_body_cap_is_unchanged() -> None:
    """PR #25's value survives; v3 changes where it is enforced, not what it is."""
    assert MAX_BODY_BYTES == 32 * 1024 * 1024


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


HOSTILE_PEER_HEADERS = [
    ("Host", "evil.example.com"),
    ("Origin", "https://evil.example.com"),
    ("Content-Length", "999999"),
    ("X-Lem-Client", "spoofed"),
]


async def test_tunnel_request_reaches_protected_api(protected_api: str) -> None:
    """Remote access keeps working for a *verified* peer.

    The proxy presents the local server's own credentials only once the peer
    has been authorized (see test_peer_auth.py for the gate itself).
    """
    handler, collector = authorized_handler(protected_api, RequestRouter(protected_api))
    await handler.start()
    try:
        await send_request(handler, 99, "POST", "/v1/tunnel/disable", headers=HOSTILE_PEER_HEADERS)
    finally:
        await handler.stop()

    response = collector.response_for(99)
    assert response.status_code == 200
    assert json.loads(response.body) == {"status": "ok", "mode": "offline"}


async def test_tunnel_ssrf_attempt_never_leaves_the_target(protected_api: str) -> None:
    """The exploit is answered locally with 400 instead of being forwarded."""
    handler, collector = authorized_handler(protected_api, RequestRouter(protected_api))
    await handler.start()
    try:
        await send_request(
            handler,
            99,
            "POST",
            "@evil.example.com/v1/tunnel/disable",
            headers=HOSTILE_PEER_HEADERS,
        )
    finally:
        await handler.stop()

    response = collector.response_for(99)
    assert response.status_code == 400
    assert json.loads(response.body) == {"error": "Invalid request path"}
    assert response.final is True


@pytest.mark.parametrize(
    "path",
    [
        "@evil.example.com/v1/admin",
        "//evil.example.com/v1/admin",
        "/\\evil.example.com/v1/admin",
        "http://169.254.169.254/latest/meta-data/",
        "https://evil.example.com/",
        "v1/health",
        "/v1/health\r\nX-Injected: 1",
        "/v1 health",
    ],
)
async def test_hostile_paths_are_refused_over_real_v3_frames(protected_api: str, path: str) -> None:
    """The whole fuzz corpus, driven through the v3 framing end to end.

    The validator is unchanged code, but v3 rebuilt everything around it. This
    re-runs the attacks against the new ingress path so the control is proven
    where it now lives, not only where it used to.
    """
    handler, collector = authorized_handler(protected_api, RequestRouter(protected_api))
    await handler.start()
    try:
        await send_request(handler, 5, "POST", path, headers=HOSTILE_PEER_HEADERS)
    finally:
        await handler.stop()

    response = collector.response_for(5)
    assert response.status_code == 400
    assert json.loads(response.body) == {"error": "Invalid request path"}


async def test_unauthorized_peer_is_refused_before_any_upstream_call(
    protected_api: str,
) -> None:
    """The peer gate still fronts everything, on the v3 ingress path."""
    from app.tunnel.http_proxy import HTTPProxyHandler

    from .proxy_harness import FrameCollector

    collector = FrameCollector()
    handler = HTTPProxyHandler(
        local_server_url=protected_api,
        router=RequestRouter(protected_api),
        send_frame=collector.send,
    )
    handler.authorized_peer = None  # no peer ever authorized

    await handler.start()
    try:
        await send_request(handler, 11, "POST", "/v1/tunnel/disable")
    finally:
        await handler.stop()

    response = collector.response_for(11)
    assert response.status_code == 403
    assert json.loads(response.body) == {"error": "Peer not authorized"}
