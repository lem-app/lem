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

"""Tests for frame routing and HELLO negotiation.

The important asymmetry, which the spec calls out and which the tests pin: a v2
peer does not send a *wrong* HELLO, it sends **no HELLO at all**, because v2 has
no such frame. The timeout is therefore the mechanism that detects the realistic
mismatch; the version check only catches a future v4.
"""

import asyncio
import struct

import pytest

from app.tunnel import message_dispatcher as md
from app.tunnel.http_frame import (
    MAX_BODY_BYTES,
    MAX_CHUNK_BYTES,
    PROTOCOL_VERSION,
    FrameType,
    HelloFrame,
    deserialize_hello,
    serialize_cancel,
    serialize_hello,
    serialize_request_head,
)
from app.tunnel.http_proxy import HTTPProxyHandler
from app.tunnel.router import RequestRouter
from app.tunnel.ws_proxy import WSProxyHandler

from .proxy_harness import FrameCollector

LOCAL_SERVER = "http://localhost:5142"


def build_dispatcher() -> tuple[md.MessageDispatcher, FrameCollector, HTTPProxyHandler]:
    """Build a dispatcher wired to a frame collector.

    Returns:
        The dispatcher, its collector, and the HTTP handler behind it
    """
    collector = FrameCollector()
    router = RequestRouter(LOCAL_SERVER)
    http_handler = HTTPProxyHandler(LOCAL_SERVER, router=router)
    ws_handler = WSProxyHandler(router, collector.send)
    dispatcher = md.MessageDispatcher(http_handler, ws_handler)
    dispatcher.attach_transport(collector.send, collector.close_channel)
    return dispatcher, collector, http_handler


def peer_hello(
    version: int = PROTOCOL_VERSION,
    max_chunk: int = MAX_CHUNK_BYTES,
    max_body: int = MAX_BODY_BYTES,
) -> bytes:
    """Serialize a HELLO as a peer would send it.

    Args:
        version: Protocol version to advertise
        max_chunk: Chunk limit to advertise
        max_body: Body limit to advertise

    Returns:
        Serialized HELLO frame
    """
    frame: HelloFrame = {
        "protocol_version": version,
        "flags": 0,
        "max_chunk_bytes": max_chunk,
        "max_body_bytes": max_body,
        "impl": "lem-web/0.1.0",
    }
    return serialize_hello(frame)


async def test_hello_is_the_first_frame_on_the_channel() -> None:
    """Negotiation opens with our own HELLO, before any other traffic."""
    dispatcher, collector, _ = build_dispatcher()

    await dispatcher.begin_negotiation()

    assert collector.frame_types()[0] == FrameType.HELLO
    sent = deserialize_hello(collector.frames[0])
    assert sent["protocol_version"] == PROTOCOL_VERSION
    assert sent["max_chunk_bytes"] == MAX_CHUNK_BYTES
    assert sent["impl"] == md.IMPL_NAME

    dispatcher.reset()


async def test_peer_hello_negotiates_the_minimum_limits() -> None:
    """Effective limits are min(local, peer): a peer may lower, never raise."""
    dispatcher, _collector, http_handler = build_dispatcher()

    await dispatcher.dispatch(peer_hello(max_chunk=8192, max_body=1024))

    assert dispatcher.negotiated is True
    assert http_handler.effective_max_chunk == 8192
    assert http_handler.peer_max_body_bytes == 1024


async def test_a_peer_cannot_raise_our_limits() -> None:
    """An advertised value larger than ours is clamped down, not adopted."""
    dispatcher, _collector, http_handler = build_dispatcher()

    await dispatcher.dispatch(peer_hello(max_chunk=10_000_000, max_body=1 << 30))

    assert http_handler.effective_max_chunk == MAX_CHUNK_BYTES
    assert http_handler.peer_max_body_bytes == MAX_BODY_BYTES


async def test_version_mismatch_closes_the_channel() -> None:
    """A v4 peer is refused rather than half-understood."""
    dispatcher, collector, _ = build_dispatcher()

    await dispatcher.dispatch(peer_hello(version=4))

    assert dispatcher.negotiated is False
    assert dispatcher.negotiation_failed is True
    assert collector.closed == (md.WS_CODE_PROTOCOL_VERSION, "protocol version mismatch")


async def test_missing_hello_times_out_and_closes_the_channel() -> None:
    """The realistic v2 case: the peer sends no HELLO at all."""
    dispatcher, collector, _ = build_dispatcher()
    original = md.HELLO_TIMEOUT_SECONDS
    md.HELLO_TIMEOUT_SECONDS = 0.05
    try:
        await dispatcher.begin_negotiation()
        await asyncio.sleep(0.15)
    finally:
        md.HELLO_TIMEOUT_SECONDS = original

    assert dispatcher.negotiated is False
    assert dispatcher.negotiation_failed is True
    assert collector.closed == (md.WS_CODE_PROTOCOL_VERSION, "protocol version mismatch")


async def test_a_timely_hello_cancels_the_timeout() -> None:
    """A peer that answers in time is not closed by the timer."""
    dispatcher, collector, _ = build_dispatcher()
    original = md.HELLO_TIMEOUT_SECONDS
    md.HELLO_TIMEOUT_SECONDS = 0.1
    try:
        await dispatcher.begin_negotiation()
        await dispatcher.dispatch(peer_hello())
        await asyncio.sleep(0.2)
    finally:
        md.HELLO_TIMEOUT_SECONDS = original

    assert dispatcher.negotiated is True
    assert collector.closed is None


async def test_frames_before_hello_are_queued_then_replayed() -> None:
    """A peer MUST NOT be acted on before its HELLO is validated."""
    dispatcher, collector, http_handler = build_dispatcher()
    http_handler.authorize_peer("device-verified")
    http_handler.set_send_frame(collector.send)
    await http_handler.start()
    try:
        head = serialize_request_head(
            {
                "request_id": 1,
                "method": "GET",
                "path": "/v1/health",
                "headers": [],
                "body_follows": False,
            }
        )
        await dispatcher.dispatch(head)

        # Nothing has been acted on yet.
        assert http_handler.tasks == {}
        assert collector.frames == []

        await dispatcher.dispatch(peer_hello())
        await asyncio.sleep(0)

        # The queued request was replayed once negotiation completed.
        assert 1 in http_handler.tasks or collector.frames
    finally:
        for task in list(http_handler.tasks.values()):
            task.cancel()
        await http_handler.stop()


async def test_flooding_before_hello_closes_the_channel() -> None:
    """A bounded queue: an early peer is tolerated, a flooding one is not."""
    dispatcher, collector, _ = build_dispatcher()

    cancel = serialize_cancel(1, 1000)
    for _ in range(md.MAX_PRE_HELLO_QUEUE + 1):
        await dispatcher.dispatch(cancel)

    assert collector.closed == (md.WS_CODE_PROTOCOL_VERSION, "no HELLO")


async def test_reserved_v2_response_frame_closes_the_channel() -> None:
    """0x02 is diagnosable precisely because it was reserved, not reused."""
    dispatcher, collector, _ = build_dispatcher()
    await dispatcher.dispatch(peer_hello())

    v2_response = bytes([0x02]) + struct.pack(">I", 1) + struct.pack(">H", 200)
    await dispatcher.dispatch(v2_response)

    assert dispatcher.negotiation_failed is True
    assert collector.closed == (md.WS_CODE_PROTOCOL_VERSION, "peer speaks protocol v2")


async def test_unknown_frame_type_raises() -> None:
    """An unknown type is not silently dropped."""
    dispatcher, _collector, _ = build_dispatcher()
    await dispatcher.dispatch(peer_hello())

    with pytest.raises(ValueError, match="Unknown frame type"):
        await dispatcher.dispatch(bytes([0x7F, 0, 0, 0, 1]))


async def test_empty_frame_raises() -> None:
    """A zero-length message carries no type byte."""
    dispatcher, _collector, _ = build_dispatcher()

    with pytest.raises(ValueError, match="Frame too short"):
        await dispatcher.dispatch(b"")


async def test_malformed_hello_closes_the_channel() -> None:
    """A truncated HELLO is not a partially-trusted HELLO."""
    dispatcher, collector, _ = build_dispatcher()

    await dispatcher.dispatch(bytes([FrameType.HELLO, 3]))

    assert dispatcher.negotiation_failed is True
    assert collector.closed == (md.WS_CODE_PROTOCOL_VERSION, "malformed HELLO")


async def test_reset_clears_negotiation_for_a_reopened_channel() -> None:
    """A new channel renegotiates from scratch."""
    dispatcher, _collector, _ = build_dispatcher()
    await dispatcher.dispatch(peer_hello())
    assert dispatcher.negotiated is True

    dispatcher.reset()

    assert dispatcher.negotiated is False
    assert dispatcher.hello_sent is False
