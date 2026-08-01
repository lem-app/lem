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

"""Test harness for driving the v3 streaming proxy.

v3's handler emits frames instead of returning a response blob, so tests need
somewhere for those frames to land. :class:`FrameCollector` is that place, and
it decodes what it caught back into a whole response so a test can assert on
status, headers and body without re-implementing the codec.
"""

import asyncio
from dataclasses import dataclass, field

from app.tunnel.http_frame import (
    FrameType,
    HeaderList,
    deserialize_cancel,
    deserialize_chunk,
    deserialize_response_head,
    serialize_request_chunk,
    serialize_request_head,
)
from app.tunnel.http_proxy import HTTPProxyHandler
from app.tunnel.router import RequestRouter

# Stand-in for a peer that passed app.tunnel.peer_auth.
VERIFIED_PEER = "device-verified"


@dataclass
class CollectedResponse:
    """A response reassembled from the frames the handler emitted."""

    status_code: int | None = None
    headers: HeaderList = field(default_factory=list)
    body: bytes = b""
    final: bool = False
    cancel_reason: int | None = None
    chunk_count: int = 0


class FrameCollector:
    """Captures frames the proxy sends, with per-frame timestamps.

    Timestamps are what let a test prove a response *streamed* rather than
    arriving in one piece after the upstream finished.
    """

    def __init__(self) -> None:
        """Initialize an empty collector."""
        self.frames: list[bytes] = []
        self.timestamps: list[float] = []
        self.closed: tuple[int, str] | None = None
        self.first_frame = asyncio.Event()

    async def send(self, data: bytes) -> None:
        """Record one frame.

        Args:
            data: Binary frame the handler emitted
        """
        self.frames.append(data)
        self.timestamps.append(asyncio.get_running_loop().time())
        self.first_frame.set()

    async def close_channel(self, code: int, reason: str) -> None:
        """Record a channel-level close.

        Args:
            code: Close code
            reason: Generic reason
        """
        self.closed = (code, reason)

    def frame_types(self) -> list[int]:
        """List the type byte of every captured frame.

        Returns:
            Frame type codes in send order
        """
        return [frame[0] for frame in self.frames]

    def response_for(self, request_id: int) -> CollectedResponse:
        """Reassemble the response for one request_id.

        Args:
            request_id: Exchange to collect

        Returns:
            The reassembled response
        """
        collected = CollectedResponse()
        for frame in self.frames:
            frame_type = frame[0]
            if frame_type == FrameType.HTTP_RESPONSE_HEAD:
                head = deserialize_response_head(frame)
                if head["request_id"] != request_id:
                    continue
                collected.status_code = head["status_code"]
                collected.headers = head["headers"]
            elif frame_type == FrameType.HTTP_RESPONSE_CHUNK:
                chunk = deserialize_chunk(frame)
                if chunk["request_id"] != request_id:
                    continue
                collected.body += chunk["payload"]
                collected.chunk_count += 1
                collected.final = collected.final or chunk["final"]
            elif frame_type == FrameType.HTTP_CANCEL:
                cancel = deserialize_cancel(frame)
                if cancel["request_id"] != request_id:
                    continue
                collected.cancel_reason = cancel["reason_code"]
        return collected

    def chunk_payloads(self, request_id: int) -> list[bytes]:
        """List the payload of every chunk for one request_id.

        Args:
            request_id: Exchange to collect

        Returns:
            Payloads in send order
        """
        payloads = []
        for frame in self.frames:
            if frame[0] != FrameType.HTTP_RESPONSE_CHUNK:
                continue
            chunk = deserialize_chunk(frame)
            if chunk["request_id"] == request_id:
                payloads.append(chunk["payload"])
        return payloads


def authorized_handler(
    local_server_url: str,
    router: RequestRouter | None = None,
    collector: FrameCollector | None = None,
) -> tuple[HTTPProxyHandler, FrameCollector]:
    """Build a proxy handler acting for an already-authorized peer.

    Args:
        local_server_url: Base URL of the local server
        router: Optional router override
        collector: Optional collector to reuse

    Returns:
        The handler and the collector its frames land in
    """
    sink = collector or FrameCollector()
    handler = HTTPProxyHandler(
        local_server_url=local_server_url,
        router=router,
        send_frame=sink.send,
        close_channel=sink.close_channel,
    )
    handler.authorize_peer(VERIFIED_PEER)
    return handler, sink


async def send_request(
    handler: HTTPProxyHandler,
    request_id: int,
    method: str,
    path: str,
    headers: HeaderList | None = None,
    body: bytes = b"",
) -> None:
    """Drive one complete request through the handler and wait for it.

    Args:
        handler: Proxy handler under test
        request_id: Exchange id
        method: HTTP method
        path: Peer-supplied path
        headers: Peer-supplied headers
        body: Request body, sent as chunks when non-empty
    """
    await handler.handle_request_head(
        serialize_request_head(
            {
                "request_id": request_id,
                "method": method,
                "path": path,
                "headers": headers or [],
                "body_follows": bool(body),
            }
        )
    )
    if body:
        await handler.handle_request_chunk(serialize_request_chunk(request_id, body, final=True))

    await drain(handler, request_id)


async def drain(handler: HTTPProxyHandler, request_id: int) -> None:
    """Wait for the handler's task for one request to finish.

    Args:
        handler: Proxy handler under test
        request_id: Exchange id
    """
    task = handler.tasks.get(request_id)
    if task is not None:
        await asyncio.gather(task, return_exceptions=True)
    # Let any follow-up frames the task scheduled land.
    await asyncio.sleep(0)
