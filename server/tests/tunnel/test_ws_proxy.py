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

"""Tests for the v3 WebSocket proxy against a real upstream socket.

The defect these close: v2 opened the upstream socket and told the browser
nothing, so ``ProxiedWebSocket`` sat in CONNECTING forever, ``onopen`` never
fired, and every ``send()`` threw. The ack has to arrive, and it has to arrive
*before* any data frame.
"""

import asyncio
from collections.abc import AsyncGenerator

import pytest
import uvicorn
from fastapi import FastAPI, WebSocket

from app.tunnel.router import RequestRouter
from app.tunnel.ws_frame import (
    MAX_WS_MESSAGE_BYTES,
    FrameType,
    WSOpcode,
    deserialize_ws_close,
    deserialize_ws_connect_ack,
    deserialize_ws_connect_error,
    deserialize_ws_data,
    serialize_ws_close,
    serialize_ws_connect,
    serialize_ws_data,
)
from app.tunnel.ws_proxy import WSProxyHandler

from .proxy_harness import FrameCollector


class WSUpstreamState:
    """What the stub upstream socket saw."""

    def __init__(self) -> None:
        """Initialize empty state."""
        self.received: list[bytes] = []
        self.received_text: list[str] = []


@pytest.fixture
async def ws_upstream() -> AsyncGenerator[tuple[str, WSUpstreamState], None]:
    """Run a stub WebSocket upstream on an ephemeral port.

    Yields:
        Base http:// URL and the state object recording what it saw
    """
    state = WSUpstreamState()
    api = FastAPI()

    @api.websocket("/echo")
    async def echo(websocket: WebSocket) -> None:
        await websocket.accept()
        try:
            while True:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    return
                if message.get("text") is not None:
                    state.received_text.append(message["text"])
                    await websocket.send_text(message["text"])
                elif message.get("bytes") is not None:
                    state.received.append(message["bytes"])
                    await websocket.send_bytes(message["bytes"])
        except Exception:
            return

    @api.websocket("/big")
    async def big(websocket: WebSocket) -> None:
        await websocket.accept()
        # One message far larger than any single frame may carry.
        await websocket.send_bytes(b"L" * (200 * 1024))
        await asyncio.sleep(0.2)

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


def build_handler(base_url: str) -> tuple[WSProxyHandler, FrameCollector]:
    """Build a WS proxy handler wired to a collector.

    Args:
        base_url: Upstream base URL

    Returns:
        The handler and its collector
    """
    collector = FrameCollector()
    handler = WSProxyHandler(RequestRouter(base_url), collector.send)
    return handler, collector


async def test_connect_is_acknowledged(ws_upstream: tuple[str, WSUpstreamState]) -> None:
    """WS_CONNECT_ACK is what lets the browser reach readyState OPEN."""
    base, _ = ws_upstream
    handler, collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/echo", "headers": []})
        )

        assert collector.frame_types()[0] == FrameType.WS_CONNECT_ACK
        ack = deserialize_ws_connect_ack(collector.frames[0])
        assert ack["connection_id"] == 1
    finally:
        await handler.stop()


async def test_ack_precedes_any_data_frame(ws_upstream: tuple[str, WSUpstreamState]) -> None:
    """The ack is sent before the relay task starts.

    Otherwise a fast first server message reaches the browser while its socket
    is still CONNECTING, and the message is dropped.
    """
    base, _ = ws_upstream
    handler, collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/big", "headers": []})
        )
        await asyncio.sleep(0.3)

        types = collector.frame_types()
        assert types[0] == FrameType.WS_CONNECT_ACK
        assert FrameType.WS_DATA in types
        assert types.index(FrameType.WS_CONNECT_ACK) < types.index(FrameType.WS_DATA)
    finally:
        await handler.stop()


async def test_failed_handshake_sends_connect_error(
    ws_upstream: tuple[str, WSUpstreamState],
) -> None:
    """A refused upstream fails fast instead of waiting out the browser timeout."""
    base, _ = ws_upstream
    handler, collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 2, "url": f"{base}/nope", "headers": []})
        )

        assert collector.frame_types() == [FrameType.WS_CONNECT_ERROR]
        error = deserialize_ws_connect_error(collector.frames[0])
        assert error["connection_id"] == 2
        # Generic reason: the cause stays in the server log.
        assert error["reason"] == "Connection failed"
    finally:
        await handler.stop()


async def test_connection_limit_is_reported_with_its_own_code(
    ws_upstream: tuple[str, WSUpstreamState],
) -> None:
    """4004 tells the browser this is a capacity problem, not a dead upstream."""
    base, _ = ws_upstream
    handler, collector = build_handler(base)
    await handler.start()
    try:
        from app.tunnel import ws_proxy

        original = ws_proxy.MAX_WS_CONNECTIONS
        ws_proxy.MAX_WS_CONNECTIONS = 1
        try:
            await handler.handle_connect(
                serialize_ws_connect({"connection_id": 1, "url": f"{base}/echo", "headers": []})
            )
            await handler.handle_connect(
                serialize_ws_connect({"connection_id": 2, "url": f"{base}/echo", "headers": []})
            )
        finally:
            ws_proxy.MAX_WS_CONNECTIONS = original

        errors = [f for f in collector.frames if f[0] == FrameType.WS_CONNECT_ERROR]
        assert len(errors) == 1
        assert deserialize_ws_connect_error(errors[0])["error_code"] == 4004
    finally:
        await handler.stop()


async def test_text_and_binary_round_trip(ws_upstream: tuple[str, WSUpstreamState]) -> None:
    """Ordinary messages still relay in both directions."""
    base, state = ws_upstream
    handler, collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/echo", "headers": []})
        )
        await handler.handle_data(
            serialize_ws_data(
                {
                    "connection_id": 1,
                    "opcode": WSOpcode.BINARY,
                    "payload": bytes([0x00, 0xFF, 0xC3, 0x28]),
                    "fin": True,
                }
            )
        )
        await asyncio.sleep(0.2)

        assert state.received == [bytes([0x00, 0xFF, 0xC3, 0x28])]
        data_frames = [f for f in collector.frames if f[0] == FrameType.WS_DATA]
        assert deserialize_ws_data(data_frames[0])["payload"] == bytes([0x00, 0xFF, 0xC3, 0x28])
    finally:
        await handler.stop()


async def test_large_upstream_message_is_fragmented(
    ws_upstream: tuple[str, WSUpstreamState],
) -> None:
    """A 200 KiB message crosses as fragments, each inside the chunk limit."""
    base, _ = ws_upstream
    handler, collector = build_handler(base)
    handler.negotiate_limits(16 * 1024)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/big", "headers": []})
        )
        await asyncio.sleep(0.3)

        fragments = [
            deserialize_ws_data(f, 16 * 1024) for f in collector.frames if f[0] == FrameType.WS_DATA
        ]

        assert len(fragments) > 1
        assert fragments[0]["opcode"] == WSOpcode.BINARY
        assert fragments[0]["fin"] is False
        assert all(f["opcode"] == WSOpcode.CONTINUATION for f in fragments[1:])
        assert all(not f["fin"] for f in fragments[:-1])
        assert fragments[-1]["fin"] is True
        assert b"".join(f["payload"] for f in fragments) == b"L" * (200 * 1024)
        assert all(len(f["payload"]) <= 16 * 1024 for f in fragments)
    finally:
        await handler.stop()


async def test_fragmented_client_message_is_reassembled(
    ws_upstream: tuple[str, WSUpstreamState],
) -> None:
    """Fragments from the browser become one upstream message."""
    base, state = ws_upstream
    handler, collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/echo", "headers": []})
        )
        await handler.handle_data(
            serialize_ws_data(
                {"connection_id": 1, "opcode": WSOpcode.BINARY, "payload": b"aaa", "fin": False}
            )
        )
        await handler.handle_data(
            serialize_ws_data(
                {
                    "connection_id": 1,
                    "opcode": WSOpcode.CONTINUATION,
                    "payload": b"bbb",
                    "fin": False,
                }
            )
        )
        await handler.handle_data(
            serialize_ws_data(
                {
                    "connection_id": 1,
                    "opcode": WSOpcode.CONTINUATION,
                    "payload": b"ccc",
                    "fin": True,
                }
            )
        )
        await asyncio.sleep(0.2)

        assert state.received == [b"aaabbbccc"]
    finally:
        await handler.stop()


async def test_reassembly_is_bounded(ws_upstream: tuple[str, WSUpstreamState]) -> None:
    """A peer cannot buffer unlimited fragments under one connection."""
    base, _ = ws_upstream
    handler, collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/echo", "headers": []})
        )
        chunk = b"x" * (48 * 1024)
        sent = 0
        while sent <= MAX_WS_MESSAGE_BYTES:
            opcode = WSOpcode.BINARY if sent == 0 else WSOpcode.CONTINUATION
            await handler.handle_data(
                serialize_ws_data(
                    {"connection_id": 1, "opcode": opcode, "payload": chunk, "fin": False}
                )
            )
            sent += len(chunk)
            if 1 not in handler.pending_messages:
                break

        await asyncio.sleep(0.1)

        assert 1 not in handler.pending_messages
        closes = [f for f in collector.frames if f[0] == FrameType.WS_CLOSE]
        assert closes, "the connection was not closed"
        assert deserialize_ws_close(closes[-1])["close_code"] == 4005
    finally:
        await handler.stop()


async def test_continuation_without_a_message_is_ignored(
    ws_upstream: tuple[str, WSUpstreamState],
) -> None:
    """A stray CONTINUATION is dropped rather than treated as a message."""
    base, state = ws_upstream
    handler, _collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/echo", "headers": []})
        )
        await handler.handle_data(
            serialize_ws_data(
                {
                    "connection_id": 1,
                    "opcode": WSOpcode.CONTINUATION,
                    "payload": b"orphan",
                    "fin": True,
                }
            )
        )
        await asyncio.sleep(0.1)

        assert state.received == []
    finally:
        await handler.stop()


async def test_fragmented_control_frame_is_refused(
    ws_upstream: tuple[str, WSUpstreamState],
) -> None:
    """RFC 6455 5.5: control frames are never fragmented."""
    base, _ = ws_upstream
    handler, _collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/echo", "headers": []})
        )
        await handler.handle_data(
            serialize_ws_data(
                {"connection_id": 1, "opcode": WSOpcode.PING, "payload": b"x", "fin": False}
            )
        )

        assert 1 not in handler.pending_messages
    finally:
        await handler.stop()


async def test_close_from_the_peer_closes_the_upstream(
    ws_upstream: tuple[str, WSUpstreamState],
) -> None:
    """WS_CLOSE tears the upstream socket down and forgets the connection."""
    base, _ = ws_upstream
    handler, _collector = build_handler(base)
    await handler.start()
    try:
        await handler.handle_connect(
            serialize_ws_connect({"connection_id": 1, "url": f"{base}/echo", "headers": []})
        )
        assert 1 in handler.connections

        await handler.handle_close(
            serialize_ws_close({"connection_id": 1, "close_code": 1000, "reason": "bye"})
        )

        assert 1 not in handler.connections
        assert 1 not in handler.pending_messages
    finally:
        await handler.stop()
