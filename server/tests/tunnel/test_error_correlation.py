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

"""Regression tests for error-frame correlation.

The proxy's error path read the request_id from ``data[:4]``, but byte 0 is the
frame type. A 500 for request 1 was therefore addressed to request 0x01000000,
the browser dropped it as unknown, and the real request hung until its 30s
timeout. These tests pin the id to the offset the wire format actually uses.
"""

import struct

import pytest

from app.tunnel.http_frame import (
    FrameType,
    HTTPRequestFrame,
    deserialize_response,
    peek_request_id,
    serialize_request,
)
from app.tunnel.http_proxy import GENERIC_PROXY_ERROR, HTTPProxyHandler
from app.tunnel.router import RequestRouter


class BoomRouter(RequestRouter):
    """Router whose routing decision always raises.

    Reproduces the "upstream blew up before a response existed" case without
    needing a network: the failure lands in ``handle_request``'s except block,
    which is the path that has to correlate the error frame itself.
    """

    def route(self, path: str) -> str:
        """Fail every routing attempt.

        Args:
            path: Request path (ignored)

        Raises:
            RuntimeError: Always
        """
        raise RuntimeError("upstream exploded")


def _request(request_id: int) -> bytes:
    """Serialize a minimal request frame.

    Args:
        request_id: Correlation id to put on the frame

    Returns:
        Serialized request frame
    """
    frame: HTTPRequestFrame = {
        "request_id": request_id,
        "method": "GET",
        "path": "/v1/health",
        "headers": {},
        "body": "",
    }
    return serialize_request(frame)


@pytest.mark.parametrize("request_id", [1, 42, 0x01020304, 0xFFFFFFFF])
def test_peek_request_id_reads_past_the_frame_type(request_id: int) -> None:
    """The id is at bytes 1..4, never 0..3."""
    data = _request(request_id)

    assert peek_request_id(data) == request_id
    # The bug, stated as an assertion: the old offset returns something else
    # for every id whose top octet differs from the frame type byte.
    (wrong,) = struct.unpack(">I", data[:4])
    assert wrong != request_id
    assert wrong >> 24 == FrameType.HTTP_REQUEST


def test_peek_request_id_returns_none_when_too_short() -> None:
    """A 4-byte frame cannot carry an id; guessing one would be worse."""
    assert peek_request_id(b"\x01\x00\x00\x00") is None
    assert peek_request_id(b"") is None


async def test_proxy_error_frame_carries_the_requests_id() -> None:
    """A proxy-level 500 is addressed to the request that caused it.

    Fails on main: the error frame came back with request_id 0x01000000
    (16777216) instead of 1, so the browser had no pending entry to resolve and
    the caller waited out the full 30s timeout.
    """
    handler = HTTPProxyHandler(local_server_url="http://localhost:5142", router=BoomRouter())
    handler.authorize_peer("device-verified")
    await handler.start()
    try:
        response = deserialize_response(await handler.handle_request(_request(1)))
    finally:
        await handler.stop()

    assert response["request_id"] == 1
    assert response["status_code"] == 500
    assert GENERIC_PROXY_ERROR in response["body"]


async def test_proxy_error_frame_id_survives_a_high_request_id() -> None:
    """Ids near the uint32 ceiling correlate too."""
    handler = HTTPProxyHandler(local_server_url="http://localhost:5142", router=BoomRouter())
    handler.authorize_peer("device-verified")
    await handler.start()
    try:
        response = deserialize_response(await handler.handle_request(_request(0xFFFFFFFF)))
    finally:
        await handler.stop()

    assert response["request_id"] == 0xFFFFFFFF
