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

"""Spec section 5.5.1 layer 3 at full scale, with the intake instrumented.

The Phase 4 acceptance criterion this file exists for:

    A peer that sends ``MAX_BODY_BYTES / MAX_CHUNK_BYTES + 1`` chunks of
    ``MAX_CHUNK_BYTES`` under a single ``request_id``, each individually legal,
    is rejected with ``E_TOO_LARGE``; the server's buffered bytes for that id
    never exceed ``MAX_BODY_BYTES + MAX_CHUNK_BYTES`` (asserted by instrumenting
    the intake, not inferred); no upstream request is issued; and the id is
    tombstoned so continued streaming is dropped without reallocation and closes
    the channel past ``POST_CANCEL_DRAIN_BYTES``. **This test must fail against
    an implementation that only checks each frame against ``MAX_CHUNK_BYTES``.**

Every frame here is exactly ``MAX_CHUNK_BYTES``, so layer 2 - the per-frame
check in ``deserialize_chunk`` - passes all of them. Only the running total in
:class:`app.tunnel.http_proxy.RequestIntake` rejects the flood, which is why a
per-frame-only implementation fails these assertions rather than merely
producing a different error message.

The buffered total is read out of the intake's own chunk list as it is built,
not inferred from ``intake.received``: ``received`` is the counter the
implementation under test maintains, so trusting it would let an implementation
that increments the counter but still retains the bytes pass.
"""

import asyncio
import json
from collections.abc import AsyncGenerator, Iterator

import pytest
import uvicorn
from fastapi import FastAPI, Request, Response

from app.tunnel import http_proxy
from app.tunnel.errors import TunnelErrorCode
from app.tunnel.http_frame import (
    MAX_BODY_BYTES,
    MAX_CHUNK_BYTES,
    POST_CANCEL_DRAIN_BYTES,
    FrameType,
    HeaderList,
    serialize_request_chunk,
    serialize_request_head,
)
from app.tunnel.router import RequestRouter

from .proxy_harness import authorized_handler

# Individually legal frames whose *total* is over the cap by exactly one frame.
FLOOD_CHUNKS = MAX_BODY_BYTES // MAX_CHUNK_BYTES + 1
FLOOD_PAYLOAD = b"x" * MAX_CHUNK_BYTES


class BufferProbe:
    """Records what the handler actually retained, append by append."""

    def __init__(self) -> None:
        """Initialize an empty probe."""
        self.peak_buffered = 0
        self.appends = 0


class _ProbedChunks(list[bytes]):
    """A chunk list that reports its true byte total on every append."""

    def __init__(self, probe: BufferProbe) -> None:
        """Initialize with the probe to report to.

        Args:
            probe: Shared recorder
        """
        super().__init__()
        self._probe = probe

    def append(self, item: bytes) -> None:
        """Append one chunk and record the resulting buffered total.

        Args:
            item: Chunk payload the handler chose to retain
        """
        super().append(item)
        self._probe.appends += 1
        self._probe.peak_buffered = max(self._probe.peak_buffered, sum(len(c) for c in self))


@pytest.fixture
def probe(monkeypatch: pytest.MonkeyPatch) -> Iterator[BufferProbe]:
    """Instrument every intake the handler creates.

    Yields:
        The probe recording peak buffered bytes and append count
    """
    recorder = BufferProbe()
    real_intake = http_proxy.RequestIntake

    def _make(method: str, path: str, headers: HeaderList) -> http_proxy.RequestIntake:
        intake = real_intake(method=method, path=path, headers=headers)
        intake.chunks = _ProbedChunks(recorder)
        return intake

    monkeypatch.setattr(http_proxy, "RequestIntake", _make)
    yield recorder


class UpstreamRecorder:
    """Every request that reached the stub upstream."""

    def __init__(self) -> None:
        """Initialize empty state."""
        self.requests: list[tuple[str, str]] = []


@pytest.fixture
async def upstream() -> AsyncGenerator[tuple[str, UpstreamRecorder], None]:
    """Run a stub upstream that records anything reaching it.

    Yields:
        Base URL and the recorder
    """
    recorder = UpstreamRecorder()
    api = FastAPI()

    @api.api_route("/{path:path}", methods=["GET", "POST"])
    async def catch_all(request: Request, path: str) -> Response:
        recorder.requests.append((request.method, "/" + path))
        await request.body()
        return Response(content=b"ok", media_type="text/plain")

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
        yield f"http://127.0.0.1:{port}", recorder
    finally:
        server.should_exit = True
        await task


async def _open_request(handler: http_proxy.HTTPProxyHandler, request_id: int) -> None:
    """Announce a request with a body to follow.

    Args:
        handler: Proxy handler under test
        request_id: Exchange id
    """
    await handler.handle_request_head(
        serialize_request_head(
            {
                "request_id": request_id,
                "method": "POST",
                "path": "/upload",
                "headers": [],
                "body_follows": True,
            }
        )
    )


class TestRequestAccumulatorAtFullScale:
    """One flood, every clause of the criterion asserted against it."""

    REQUEST_ID = 7

    async def test_a_flood_of_individually_legal_chunks_is_refused(
        self, upstream: tuple[str, UpstreamRecorder], probe: BufferProbe
    ) -> None:
        """The criterion, in one exchange."""
        base, upstream_recorder = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        await handler.start()
        try:
            await _open_request(handler, self.REQUEST_ID)

            for _ in range(FLOOD_CHUNKS):
                await handler.handle_request_chunk(
                    serialize_request_chunk(self.REQUEST_ID, FLOOD_PAYLOAD, final=False)
                )

            appends_at_rejection = probe.appends

            # Continued streaming on the dead id: dropped, never re-buffered.
            for _ in range(4):
                await handler.handle_request_chunk(
                    serialize_request_chunk(self.REQUEST_ID, FLOOD_PAYLOAD, final=False)
                )
        finally:
            await handler.stop()

        response = collector.response_for(self.REQUEST_ID)

        # 1. Rejected with E_TOO_LARGE, as a real 502 the iframe can render.
        assert response.status_code == 502
        assert json.loads(response.body) == {"error": "Payload too large"}
        assert response.final is True
        assert response.cancel_reason == int(TunnelErrorCode.E_TOO_LARGE)

        # 2. Buffered bytes bounded, read from the retained chunks themselves.
        assert probe.peak_buffered <= MAX_BODY_BYTES + MAX_CHUNK_BYTES
        # Tighter, and the reason the bound holds: the breaching frame is never
        # appended, so the peak is a whole chunk below the cap-plus-one bound.
        assert probe.peak_buffered <= MAX_BODY_BYTES
        # The probe is reading real appends, not a silent zero.
        assert probe.peak_buffered == (FLOOD_CHUNKS - 1) * MAX_CHUNK_BYTES

        # 3. No upstream request was issued.
        assert upstream_recorder.requests == []

        # 4. The id is tombstoned and further chunks reallocate nothing.
        assert self.REQUEST_ID not in handler.intakes
        assert probe.appends == appends_at_rejection

    async def test_buffered_bytes_stay_bounded_during_the_flood(
        self, upstream: tuple[str, UpstreamRecorder], probe: BufferProbe
    ) -> None:
        """The memory bound alone, so a regression here fails on its own.

        The test above asserts the response first, so a regression shows up
        there as "no response at all". This one asserts nothing but the bound,
        which is the property the accumulator exists to provide: peak retained
        bytes for one ``request_id`` cannot exceed
        ``MAX_BODY_BYTES + MAX_CHUNK_BYTES``.

        The peer keeps sending past the breach rather than stopping at the
        theoretical minimum, which is what a peer trying to exhaust memory would
        do - and it is what makes the bound discriminating. At exactly
        ``FLOOD_CHUNKS`` frames the total sits between ``MAX_BODY_BYTES`` and
        ``MAX_BODY_BYTES + MAX_CHUNK_BYTES``, so an implementation with no
        accumulator at all would still satisfy the bound by arithmetic accident.
        """
        base, _ = upstream
        handler, _collector = authorized_handler(base, RequestRouter(base))
        await handler.start()
        try:
            await _open_request(handler, 11)
            for _ in range(FLOOD_CHUNKS + 64):
                await handler.handle_request_chunk(
                    serialize_request_chunk(11, FLOOD_PAYLOAD, final=False)
                )
        finally:
            await handler.stop()

        assert probe.peak_buffered <= MAX_BODY_BYTES + MAX_CHUNK_BYTES

    async def test_the_peer_is_told_to_stop_before_the_channel_is_closed(
        self, upstream: tuple[str, UpstreamRecorder], probe: BufferProbe
    ) -> None:
        """Response frames first, then CANCEL - order matters (5.5.1).

        A peer that stops reading the moment it sees CANCEL must still have been
        handed a diagnosable answer.
        """
        base, _ = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        # A small cap keeps this test fast; the mechanism is the one above.
        handler.peer_max_body_bytes = 2 * MAX_CHUNK_BYTES
        await handler.start()
        try:
            await _open_request(handler, 8)
            for _ in range(3):
                await handler.handle_request_chunk(
                    serialize_request_chunk(8, FLOOD_PAYLOAD, final=False)
                )
        finally:
            await handler.stop()

        assert collector.frame_types() == [
            FrameType.HTTP_RESPONSE_HEAD,
            FrameType.HTTP_RESPONSE_CHUNK,
            FrameType.HTTP_CANCEL,
        ]
        # One over-cap request does not kill the session.
        assert collector.closed is None

    async def test_streaming_past_the_drain_allowance_closes_the_channel(
        self, upstream: tuple[str, UpstreamRecorder], probe: BufferProbe
    ) -> None:
        """A peer that ignores the cancel is a peer problem, not a request one."""
        base, _ = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        handler.peer_max_body_bytes = MAX_CHUNK_BYTES
        await handler.start()
        try:
            await _open_request(handler, 9)
            for _ in range(2):
                await handler.handle_request_chunk(
                    serialize_request_chunk(9, FLOOD_PAYLOAD, final=False)
                )
            assert 9 in handler.tombstoned
            appends_at_rejection = probe.appends

            for _ in range(POST_CANCEL_DRAIN_BYTES // MAX_CHUNK_BYTES + 2):
                await handler.handle_request_chunk(
                    serialize_request_chunk(9, FLOOD_PAYLOAD, final=False)
                )
        finally:
            await handler.stop()

        assert collector.closed is not None
        assert collector.closed[0] == 4006
        # Nothing was buffered while draining.
        assert probe.appends == appends_at_rejection

    async def test_a_body_under_the_cap_still_reaches_the_upstream(
        self, upstream: tuple[str, UpstreamRecorder], probe: BufferProbe
    ) -> None:
        """The positive control.

        Without this, "no upstream request was issued" above could be satisfied
        by a handler that never forwards anything at all.
        """
        base, upstream_recorder = upstream
        handler, collector = authorized_handler(base, RequestRouter(base))
        await handler.start()
        try:
            await _open_request(handler, 10)
            for index in range(3):
                await handler.handle_request_chunk(
                    serialize_request_chunk(10, FLOOD_PAYLOAD, final=index == 2)
                )
            task = handler.tasks.get(10)
            if task is not None:
                await asyncio.gather(task, return_exceptions=True)
            await asyncio.sleep(0)
        finally:
            await handler.stop()

        assert upstream_recorder.requests == [("POST", "/upload")]
        assert collector.response_for(10).status_code == 200
        assert probe.appends == 3
