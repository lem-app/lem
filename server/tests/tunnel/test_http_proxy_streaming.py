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

"""Tests for the v3 streaming proxy against a real upstream.

These are the product-outcome tests, not just codec tests:

* a binary asset survives byte for byte (v2 mangled every PNG through UTF-8),
* a response far larger than the DataChannel's ~64 KiB message limit crosses in
  chunks (v2 sent one message and killed the channel),
* a slow upstream is forwarded *incrementally* rather than buffered, which is
  what makes token-by-token model output work,
* the cumulative body accumulator bounds a multi-frame body, which a per-frame
  check cannot do.
"""

import asyncio
import hashlib
import json
import random
from collections.abc import AsyncGenerator, AsyncIterator

import pytest
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

from app.tunnel.errors import TunnelErrorCode
from app.tunnel.http_frame import (
    MAX_CHUNK_BYTES,
    POST_CANCEL_DRAIN_BYTES,
    FrameType,
    serialize_cancel,
    serialize_request_chunk,
    serialize_request_head,
)
from app.tunnel.router import RequestRouter

from .proxy_harness import authorized_handler, drain, send_request

# Deterministic 5 MB of incompressible bytes: the asset under test.
_RNG = random.Random(1234)
BINARY_ASSET = bytes(_RNG.getrandbits(8) for _ in range(5 * 1024 * 1024))
BINARY_SHA256 = hashlib.sha256(BINARY_ASSET).hexdigest()

# One PNG header plus bytes that are not valid UTF-8 anywhere.
SMALL_BINARY = b"\x89PNG\r\n\x1a\n" + bytes([0xC3, 0x28, 0x00, 0xFF, 0xFE, 0x80])


class UpstreamState:
    """What the stub upstream saw, for assertions the frames cannot make."""

    def __init__(self) -> None:
        """Initialize empty state."""
        self.requests: list[tuple[str, str]] = []
        self.received_bodies: list[bytes] = []
        self.stream_disconnected = asyncio.Event()
        self.stream_chunks_sent = 0


@pytest.fixture
async def upstream() -> AsyncGenerator[tuple[str, UpstreamState], None]:
    """Run a stub upstream service on an ephemeral port.

    Yields:
        Base URL and the state object recording what it saw
    """
    state = UpstreamState()
    api = FastAPI()

    @api.middleware("http")
    async def record(request: Request, call_next):  # type: ignore[no-untyped-def]  # FastAPI hook
        state.requests.append((request.method, request.url.path))
        return await call_next(request)

    @api.get("/asset.bin")
    async def asset() -> Response:
        return Response(content=BINARY_ASSET, media_type="application/octet-stream")

    @api.get("/small.png")
    async def small() -> Response:
        return Response(content=SMALL_BINARY, media_type="image/png")

    @api.get("/duplicate-headers")
    async def duplicate_headers() -> Response:
        response = Response(content=b"ok", media_type="text/plain")
        response.headers.append("Link", "<a>; rel=next")
        response.headers.append("Link", "<b>; rel=prev")
        return response

    @api.get("/slow-stream")
    async def slow_stream() -> StreamingResponse:
        async def generate() -> AsyncIterator[bytes]:
            try:
                for index in range(10):
                    state.stream_chunks_sent += 1
                    yield f"token-{index}\n".encode()
                    await asyncio.sleep(0.1)
            except asyncio.CancelledError:
                state.stream_disconnected.set()
                raise

        return StreamingResponse(generate(), media_type="application/x-ndjson")

    @api.get("/endless")
    async def endless() -> StreamingResponse:
        async def generate() -> AsyncIterator[bytes]:
            try:
                while True:
                    state.stream_chunks_sent += 1
                    yield b"x" * 8192
                    await asyncio.sleep(0)
            except asyncio.CancelledError:
                state.stream_disconnected.set()
                raise

        return StreamingResponse(generate(), media_type="application/octet-stream")

    @api.post("/echo")
    async def echo(request: Request) -> Response:
        body = await request.body()
        state.received_bodies.append(body)
        return Response(content=body, media_type="application/octet-stream")

    @api.get("/redirect")
    async def redirect() -> Response:
        return Response(status_code=302, headers={"Location": "/auth/callback"})

    @api.post("/login")
    async def login() -> Response:
        # Shaped like a real app's login: several cookies, different flags,
        # one of them deliberately readable by the app's own JavaScript.
        response = Response(content=b"ok", media_type="text/plain")
        response.headers.append(
            "Set-Cookie",
            "session=s3cret; Path=/; Domain=app.local; HttpOnly; Secure; SameSite=Lax",
        )
        response.headers.append("Set-Cookie", "csrftoken=abc123; Path=/api; SameSite=Strict")
        response.headers.append("Set-Cookie", "theme=dark")
        return response

    server = uvicorn.Server(uvicorn.Config(api, host="127.0.0.1", port=0, log_level="error"))
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.02)
    else:  # pragma: no cover - only on a broken event loop
        raise AssertionError("Stub upstream did not start")

    port: int = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}", state
    finally:
        server.should_exit = True
        await task


async def test_binary_asset_survives_byte_for_byte(
    upstream: tuple[str, UpstreamState],
) -> None:
    """A 5 MB binary asset arrives with an identical SHA-256.

    v2 read the body with ``response.text()`` and typed the frame field ``str``,
    so this either corrupted the bytes or raised on invalid UTF-8 and became a
    500.
    """
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 1, "GET", "/asset.bin")
    finally:
        await handler.stop()

    response = collector.response_for(1)

    assert response.status_code == 200
    assert hashlib.sha256(response.body).hexdigest() == BINARY_SHA256
    assert response.body == BINARY_ASSET
    assert response.final is True


async def test_small_binary_with_invalid_utf8_survives(
    upstream: tuple[str, UpstreamState],
) -> None:
    """The exact byte sequences UTF-8 round-tripping destroyed."""
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 2, "GET", "/small.png")
    finally:
        await handler.stop()

    assert collector.response_for(2).body == SMALL_BINARY


async def test_large_response_is_chunked_under_the_message_limit(
    upstream: tuple[str, UpstreamState],
) -> None:
    """No single frame exceeds the negotiated chunk size.

    The DataChannel's interoperable ``maxMessageSize`` is 64 KiB. v2 put a whole
    response in one message, so any JS bundle tore the channel down.
    """
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 3, "GET", "/asset.bin")
    finally:
        await handler.stop()

    assert max(len(frame) for frame in collector.frames) <= MAX_CHUNK_BYTES + 64
    assert collector.response_for(3).chunk_count > 100


async def test_response_larger_than_64_kib_crosses_intact(
    upstream: tuple[str, UpstreamState],
) -> None:
    """The specific size that killed v2's channel."""
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 4, "GET", "/asset.bin")
    finally:
        await handler.stop()

    body = collector.response_for(4).body

    assert len(body) > 64 * 1024
    assert body == BINARY_ASSET


async def test_slow_upstream_is_forwarded_incrementally(
    upstream: tuple[str, UpstreamState],
) -> None:
    """Chunks arrive as the upstream produces them, not after it finishes.

    The stub emits a line every 100 ms for a second. If the proxy buffered, the
    first chunk would land only at the end; instead it lands almost immediately
    and the chunks are spread across the whole second. This is what makes
    token-by-token model output work, and it is the requirement no size-based
    workaround satisfies.
    """
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()

    started = asyncio.get_running_loop().time()
    try:
        await send_request(handler, 5, "GET", "/slow-stream")
    finally:
        await handler.stop()

    response = collector.response_for(5)
    assert response.status_code == 200
    assert b"token-0" in response.body
    assert b"token-9" in response.body

    # The head, then the first body chunk, both well before the upstream is done.
    body_chunk_times = [
        timestamp
        for frame, timestamp in zip(collector.frames, collector.timestamps, strict=True)
        if frame[0] == FrameType.HTTP_RESPONSE_CHUNK and len(frame) > 10
    ]
    assert body_chunk_times, "no body chunks were sent"

    first_chunk_delay = body_chunk_times[0] - started
    total_duration = collector.timestamps[-1] - started

    assert first_chunk_delay < 0.3, f"first chunk took {first_chunk_delay:.3f}s"
    # The whole exchange really did span the upstream's emission window, so the
    # early first chunk is not just a fast small response.
    assert total_duration > 0.5, f"exchange finished in {total_duration:.3f}s"
    # And the chunks are spread out rather than flushed together at the end.
    assert body_chunk_times[-1] - body_chunk_times[0] > 0.5


async def test_streamed_chunks_are_not_all_sent_at_the_end(
    upstream: tuple[str, UpstreamState],
) -> None:
    """At least half the chunks land before the upstream finishes."""
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()

    try:
        await send_request(handler, 6, "GET", "/slow-stream")
    finally:
        await handler.stop()

    body_chunk_times = [
        timestamp
        for frame, timestamp in zip(collector.frames, collector.timestamps, strict=True)
        if frame[0] == FrameType.HTTP_RESPONSE_CHUNK and len(frame) > 10
    ]
    finished = collector.timestamps[-1]
    early = [t for t in body_chunk_times if t < finished - 0.2]

    assert len(early) >= len(body_chunk_times) // 2


async def test_duplicate_response_headers_reach_the_peer(
    upstream: tuple[str, UpstreamState],
) -> None:
    """Repeated headers survive; ``dict(response.headers)`` lost all but one."""
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 7, "GET", "/duplicate-headers")
    finally:
        await handler.stop()

    links = [value for name, value in collector.response_for(7).headers if name.lower() == "link"]

    assert links == ["<a>; rel=next", "<b>; rel=prev"]


async def test_login_cookies_reach_the_peer(
    upstream: tuple[str, UpstreamState],
) -> None:
    """#72: every ``Set-Cookie`` a real login sets crosses, unmodified.

    While this header was blocked, the frames carried no cookie at all. It
    crosses now. Reverting the ``RESPONSE_BLOCKED_HEADERS`` change fails this
    on the empty list.

    The values are asserted byte-for-byte because the server must not rewrite
    them, and because the browser-side consumer does not exist yet: the Service
    Worker rewrite #72 specified is undeliverable (spec section 5.6.2), and the
    cookie jar that replaces it will parse exactly these bytes.
    """
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 20, "POST", "/login", body=b"user=a&pass=b")
    finally:
        await handler.stop()

    cookies = [
        value for name, value in collector.response_for(20).headers if name.lower() == "set-cookie"
    ]

    assert cookies == [
        "session=s3cret; Path=/; Domain=app.local; HttpOnly; Secure; SameSite=Lax",
        "csrftoken=abc123; Path=/api; SameSite=Strict",
        "theme=dark",
    ]


async def test_framing_headers_are_not_forwarded(
    upstream: tuple[str, UpstreamState],
) -> None:
    """Content-Length and Content-Encoding describe the upstream hop, not ours."""
    base, _ = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 8, "GET", "/asset.bin")
    finally:
        await handler.stop()

    names = {name.lower() for name, _ in collector.response_for(8).headers}

    assert "content-length" not in names
    assert "content-encoding" not in names
    assert "transfer-encoding" not in names
    assert "content-type" in names


async def test_redirects_are_relayed_not_followed(
    upstream: tuple[str, UpstreamState],
) -> None:
    """PR #25's allow_redirects=False survives the rewrite."""
    base, state = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 9, "GET", "/redirect")
    finally:
        await handler.stop()

    response = collector.response_for(9)

    assert response.status_code == 302
    assert ("location", "/auth/callback") in [
        (name.lower(), value) for name, value in response.headers
    ]
    assert ("GET", "/auth/callback") not in state.requests


async def test_request_body_reaches_upstream_as_bytes(
    upstream: tuple[str, UpstreamState],
) -> None:
    """A binary request body survives chunking in both directions."""
    base, state = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await send_request(handler, 10, "POST", "/echo", body=SMALL_BINARY)
    finally:
        await handler.stop()

    assert state.received_bodies == [SMALL_BINARY]
    assert collector.response_for(10).body == SMALL_BINARY


async def test_multi_chunk_request_body_is_reassembled(
    upstream: tuple[str, UpstreamState],
) -> None:
    """A body split across chunks arrives whole and in order."""
    base, state = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await handler.handle_request_head(
            serialize_request_head(
                {
                    "request_id": 11,
                    "method": "POST",
                    "path": "/echo",
                    "headers": [],
                    "body_follows": True,
                }
            )
        )
        await handler.handle_request_chunk(serialize_request_chunk(11, b"part-one:", final=False))
        await handler.handle_request_chunk(serialize_request_chunk(11, SMALL_BINARY, final=False))
        await handler.handle_request_chunk(serialize_request_chunk(11, b":end", final=True))
        await drain(handler, 11)
    finally:
        await handler.stop()

    assert state.received_bodies == [b"part-one:" + SMALL_BINARY + b":end"]


async def test_cancel_mid_stream_disconnects_the_upstream(
    upstream: tuple[str, UpstreamState],
) -> None:
    """A cancelled exchange stops producing and drops the upstream response."""
    base, state = upstream
    handler, collector = authorized_handler(base, RequestRouter(base))
    await handler.start()
    try:
        await handler.handle_request_head(
            serialize_request_head(
                {
                    "request_id": 12,
                    "method": "GET",
                    "path": "/slow-stream",
                    "headers": [],
                    "body_follows": False,
                }
            )
        )
        # Let the stream start, then cancel it.
        await asyncio.sleep(0.15)
        frames_at_cancel = len(collector.frames)
        await handler.handle_cancel(serialize_cancel(12, TunnelErrorCode.E_INTERNAL))
        await asyncio.sleep(0.3)

        assert 12 not in handler.tasks
        # Nothing further is produced for a cancelled id.
        assert len(collector.frames) <= frames_at_cancel + 1
        assert collector.response_for(12).final is False
    finally:
        await handler.stop()


async def test_upstream_error_becomes_a_correlated_502(
    upstream: tuple[str, UpstreamState],
) -> None:
    """A dead upstream is a 502 addressed to the right request."""
    handler, collector = authorized_handler(
        "http://127.0.0.1:1", RequestRouter("http://127.0.0.1:1")
    )
    await handler.start()
    try:
        await send_request(handler, 13, "GET", "/nope")
    finally:
        await handler.stop()

    response = collector.response_for(13)

    assert response.status_code == 502
    assert json.loads(response.body) == {"error": "Bad gateway"}
    assert response.final is True


class TestBodyAccumulator:
    """Spec section 5.5.1 layer 3: the cumulative per-request_id total.

    Each frame below is individually legal at exactly MAX_CHUNK_BYTES. Only the
    running total rejects them, which is the whole point: an implementation that
    checks each frame against MAX_CHUNK_BYTES and nothing else passes every
    per-frame test and still accepts an unbounded body.
    """

    @staticmethod
    async def _flood(handler: object, request_id: int, chunk_count: int, chunk: bytes) -> None:
        """Send many individually-legal chunks under one request_id.

        Args:
            handler: Proxy handler under test
            request_id: Exchange id
            chunk_count: Number of chunks to send
            chunk: Payload for each chunk
        """
        for _ in range(chunk_count):
            await handler.handle_request_chunk(  # type: ignore[attr-defined]  # harness
                serialize_request_chunk(request_id, chunk, final=False)
            )

    async def test_cumulative_body_cap_rejects_a_multi_frame_flood(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """MAX_BODY_BYTES / MAX_CHUNK_BYTES + 1 legal chunks are refused."""
        base, state = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        # Lower the cap so the test is fast; the mechanism is identical.
        handler.peer_max_body_bytes = 4 * MAX_CHUNK_BYTES
        await handler.start()
        try:
            await handler.handle_request_head(
                serialize_request_head(
                    {
                        "request_id": 20,
                        "method": "POST",
                        "path": "/echo",
                        "headers": [],
                        "body_follows": True,
                    }
                )
            )
            chunk = b"x" * MAX_CHUNK_BYTES
            peak = 0
            for _ in range(5):
                await handler.handle_request_chunk(serialize_request_chunk(20, chunk, final=False))
                intake = handler.intakes.get(20)
                if intake is not None:
                    peak = max(peak, intake.received)
        finally:
            await handler.stop()

        response = collector.response_for(20)

        assert response.status_code == 502
        assert json.loads(response.body) == {"error": "Payload too large"}
        assert response.cancel_reason == int(TunnelErrorCode.E_TOO_LARGE)
        # Buffered bytes never exceed the cap plus one in-flight chunk.
        assert peak <= handler.peer_max_body_bytes
        # The upstream never saw a byte of it.
        assert state.requests == []

    async def test_partial_state_is_reclaimed_at_rejection(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """The buffered chunks are dropped when the cap is breached."""
        base, _ = upstream
        handler, _collector = authorized_handler(base, RequestRouter(base))
        handler.peer_max_body_bytes = 2 * MAX_CHUNK_BYTES
        await handler.start()
        try:
            await handler.handle_request_head(
                serialize_request_head(
                    {
                        "request_id": 21,
                        "method": "POST",
                        "path": "/echo",
                        "headers": [],
                        "body_follows": True,
                    }
                )
            )
            chunk = b"x" * MAX_CHUNK_BYTES
            for _ in range(3):
                await handler.handle_request_chunk(serialize_request_chunk(21, chunk, final=False))

            assert 21 not in handler.intakes
            assert 21 in handler.tombstoned
        finally:
            await handler.stop()

    async def test_tombstoned_id_drops_further_chunks_without_buffering(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """Continued streaming on a dead id allocates nothing."""
        base, _ = upstream
        handler, _collector = authorized_handler(base, RequestRouter(base))
        handler.peer_max_body_bytes = MAX_CHUNK_BYTES
        await handler.start()
        try:
            await handler.handle_request_head(
                serialize_request_head(
                    {
                        "request_id": 22,
                        "method": "POST",
                        "path": "/echo",
                        "headers": [],
                        "body_follows": True,
                    }
                )
            )
            chunk = b"x" * MAX_CHUNK_BYTES
            await handler.handle_request_chunk(serialize_request_chunk(22, chunk, final=False))
            await handler.handle_request_chunk(serialize_request_chunk(22, chunk, final=False))

            assert 22 in handler.tombstoned
            await handler.handle_request_chunk(serialize_request_chunk(22, chunk, final=False))

            assert 22 not in handler.intakes
            assert handler.tombstoned[22] == MAX_CHUNK_BYTES
        finally:
            await handler.stop()

    async def test_channel_closes_when_the_peer_ignores_cancellation(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """Past POST_CANCEL_DRAIN_BYTES the peer is misbehaving, not merely late."""
        base, _ = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        handler.peer_max_body_bytes = MAX_CHUNK_BYTES
        await handler.start()
        try:
            await handler.handle_request_head(
                serialize_request_head(
                    {
                        "request_id": 23,
                        "method": "POST",
                        "path": "/echo",
                        "headers": [],
                        "body_follows": True,
                    }
                )
            )
            chunk = b"x" * MAX_CHUNK_BYTES
            # Two chunks breach the cap and tombstone the id.
            for _ in range(2):
                await handler.handle_request_chunk(serialize_request_chunk(23, chunk, final=False))
            # Keep streaming well past the drain allowance.
            for _ in range(POST_CANCEL_DRAIN_BYTES // MAX_CHUNK_BYTES + 2):
                await handler.handle_request_chunk(serialize_request_chunk(23, chunk, final=False))
        finally:
            await handler.stop()

        assert collector.closed is not None
        assert collector.closed[0] == 4006

    async def test_a_chunk_with_no_head_is_malformed(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """A body for a request that was never announced is refused."""
        base, _ = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        await handler.start()
        try:
            await handler.handle_request_chunk(serialize_request_chunk(30, b"data", final=True))
        finally:
            await handler.stop()

        assert collector.response_for(30).status_code == 502


class TestResponseSizeCap:
    """The send side of the cap, so the browser's accumulator is a backstop."""

    async def test_declared_over_cap_length_is_refused_before_streaming(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """The clean case: refused before a byte of the body is sent."""
        base, _ = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        handler.peer_max_body_bytes = 1024  # asset.bin is 5 MB with a length
        await handler.start()
        try:
            await send_request(handler, 40, "GET", "/asset.bin")
        finally:
            await handler.stop()

        response = collector.response_for(40)

        assert response.status_code == 502
        assert json.loads(response.body) == {"error": "Payload too large"}
        assert response.cancel_reason == int(TunnelErrorCode.E_TOO_LARGE)
        # "Before streaming" as a fact, not an implication: the only chunk on
        # the wire is the problem body, so not one byte of the 5 MB asset was
        # framed before the refusal.
        assert response.chunk_count == 1
        assert BINARY_ASSET[:64] not in response.body

    async def test_unknown_length_over_cap_cancels_without_a_final_chunk(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """A FINAL chunk here would tell the browser a truncated body was whole.

        The status was already committed, so the only honest ending is a
        cancel: the browser turns that into ``controller.error()`` and the
        iframe's fetch rejects, exactly as an interrupted download does.
        """
        base, _ = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        handler.peer_max_body_bytes = 64 * 1024
        await handler.start()
        try:
            await send_request(handler, 41, "GET", "/endless")
        finally:
            await handler.stop()

        response = collector.response_for(41)

        assert response.status_code == 200  # already committed
        assert response.final is False  # the load-bearing assertion
        assert response.cancel_reason == int(TunnelErrorCode.E_TOO_LARGE)


class TestInFlightCap:
    """Peer-chosen request ids must not be an unbounded memory commitment."""

    async def test_too_many_in_flight_requests_closes_the_channel(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """MAX_INFLIGHT_REQUESTS is peer behaviour, so it closes the channel."""
        base, _ = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        await handler.start()
        try:
            for request_id in range(1, 200):
                await handler.handle_request_head(
                    serialize_request_head(
                        {
                            "request_id": request_id,
                            "method": "POST",
                            "path": "/echo",
                            "headers": [],
                            "body_follows": True,
                        }
                    )
                )
                if collector.closed is not None:
                    break
        finally:
            await handler.stop()

        assert collector.closed is not None
        assert collector.closed[0] == 4006

    async def test_duplicate_request_id_is_refused(
        self, upstream: tuple[str, UpstreamState]
    ) -> None:
        """Reusing an in-flight id would let a peer overwrite another exchange."""
        base, _ = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        await handler.start()
        try:
            head = serialize_request_head(
                {
                    "request_id": 50,
                    "method": "POST",
                    "path": "/echo",
                    "headers": [],
                    "body_follows": True,
                }
            )
            await handler.handle_request_head(head)
            await handler.handle_request_head(head)
        finally:
            await handler.stop()

        assert collector.response_for(50).status_code == 502
