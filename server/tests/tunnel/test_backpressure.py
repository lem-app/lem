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

"""Tests for DataChannel send backpressure.

A streaming response is produced far faster than SCTP drains it. Without a wait
the send buffer grows without bound and the channel is torn down mid-transfer,
which is the failure that makes a large asset "work in tests, fail in a
browser".
"""

import asyncio

import pytest

from app.tunnel.webrtc_client import SEND_HIGH_WATER, SEND_LOW_WATER, TunnelAgent


class FakeDataChannel:
    """Minimal stand-in for aiortc's RTCDataChannel send path."""

    def __init__(self, buffered: int = 0) -> None:
        """Initialize the fake.

        Args:
            buffered: Initial bufferedAmount
        """
        self.bufferedAmount = buffered
        self.bufferedAmountLowThreshold = 0
        self.readyState = "open"
        self.sent: list[bytes] = []

    def send(self, data: bytes) -> None:
        """Record a send and grow the buffer.

        Args:
            data: Frame bytes
        """
        self.sent.append(data)
        self.bufferedAmount += len(data)


@pytest.fixture
def agent() -> TunnelAgent:
    """Build a tunnel agent with no live connection.

    Returns:
        Agent under test
    """
    return TunnelAgent(local_server_url="http://localhost:5142")


async def test_send_proceeds_when_the_buffer_is_low(agent: TunnelAgent) -> None:
    """The common case takes no detour."""
    channel = FakeDataChannel(buffered=0)
    agent.data_channel = channel  # type: ignore[assignment]  # fake channel

    await asyncio.wait_for(agent._send_frame(b"hello"), timeout=1)

    assert channel.sent == [b"hello"]


async def test_send_waits_when_the_buffer_is_above_the_high_water_mark(
    agent: TunnelAgent,
) -> None:
    """A full buffer parks the producer instead of piling on more bytes."""
    channel = FakeDataChannel(buffered=SEND_HIGH_WATER + 1)
    agent.data_channel = channel  # type: ignore[assignment]  # fake channel

    send = asyncio.create_task(agent._send_frame(b"payload"))
    await asyncio.sleep(0.05)

    assert channel.sent == [], "the frame was sent without waiting for capacity"

    # The transport drains and fires bufferedamountlow.
    channel.bufferedAmount = 0
    agent._drain_event.set()
    await asyncio.wait_for(send, timeout=1)

    assert channel.sent == [b"payload"]


class DrainingDataChannel(FakeDataChannel):
    """A channel that drains between the high-water check and the wait.

    The event that would have released the wait fired before it was cleared, so
    only the re-check after clearing can save the sender.
    """

    def __init__(self) -> None:
        """Initialize with a full buffer that empties on the second read."""
        super().__init__(buffered=SEND_HIGH_WATER + 1)
        self.reads = 0

    @property  # type: ignore[override]  # deliberately dynamic for the race
    def bufferedAmount(self) -> int:
        """Report a full buffer once, then an empty one.

        Returns:
            Bytes currently buffered
        """
        self.reads += 1
        return SEND_HIGH_WATER + 1 if self.reads == 1 else 0

    @bufferedAmount.setter
    def bufferedAmount(self, value: int) -> None:
        """Ignore writes; the value is computed.

        Args:
            value: Ignored
        """


async def test_a_drain_between_check_and_wait_does_not_deadlock(
    agent: TunnelAgent,
) -> None:
    """The re-check after clearing the event closes the obvious race."""
    channel = DrainingDataChannel()
    agent.data_channel = channel  # type: ignore[assignment]  # fake channel
    agent._drain_event.clear()  # the releasing event already fired and was consumed

    await asyncio.wait_for(agent._send_frame(b"payload"), timeout=1)

    assert channel.sent == [b"payload"]


async def test_a_stalled_peer_does_not_park_the_producer_forever(
    agent: TunnelAgent,
) -> None:
    """A peer that stops reading must not wedge the sender permanently."""
    from app.tunnel import webrtc_client

    channel = FakeDataChannel(buffered=SEND_HIGH_WATER + 1)
    agent.data_channel = channel  # type: ignore[assignment]  # fake channel

    original = webrtc_client.SEND_DRAIN_TIMEOUT
    webrtc_client.SEND_DRAIN_TIMEOUT = 0.05
    try:
        await asyncio.wait_for(agent._send_frame(b"payload"), timeout=2)
    finally:
        webrtc_client.SEND_DRAIN_TIMEOUT = original

    assert channel.sent == [b"payload"]


def test_thresholds_are_ordered() -> None:
    """Low water below high water, or the wait can never be released."""
    assert 0 < SEND_LOW_WATER < SEND_HIGH_WATER
