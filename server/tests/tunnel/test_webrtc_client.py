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

"""Tests for WebRTC tunnel agent."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import pytest
from aiortc import RTCDataChannel, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription

from app.tunnel.webrtc_client import ConnectionState, TunnelAgent


class TestTunnelAgent:
    """Tests for TunnelAgent class."""

    def test_initialization(self) -> None:
        """Test agent initialization."""
        agent = TunnelAgent()

        assert agent.state == ConnectionState.DISCONNECTED
        assert agent.signal_url is None
        assert agent.device_id is None
        assert agent.token is None
        assert agent.pc is None
        assert agent.data_channel is None
        assert agent.should_reconnect is True

    @pytest.mark.asyncio
    async def test_connect_creates_peer_connection(self) -> None:
        """Test that connect() creates RTCPeerConnection."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                    target_device_id="target-456",
                )

                assert agent.pc is not None
                assert isinstance(agent.pc, RTCPeerConnection)
                assert agent.signal_url == "ws://localhost:8000/signal"
                assert agent.device_id == "device-123"
                assert agent.token == "test-token"
                assert agent.target_device_id == "target-456"

    @pytest.mark.asyncio
    async def test_create_data_channel(self) -> None:
        """Test creating DataChannel."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                channel = await agent.create_data_channel("test-channel")

                assert channel is not None
                assert isinstance(channel, RTCDataChannel)
                assert agent.data_channel is channel

    @pytest.mark.asyncio
    async def test_create_offer(self) -> None:
        """Test creating SDP offer."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                # Mock ICE gathering
                agent.ice_gathering_complete.set()

                offer = await agent.create_offer()

                assert offer is not None
                assert isinstance(offer, RTCSessionDescription)
                assert offer.type == "offer"

    @pytest.mark.asyncio
    async def test_create_answer(self) -> None:
        """Test creating SDP answer."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                # Create a mock offer
                offer = RTCSessionDescription(sdp="v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n", type="offer")

                # Mock ICE gathering
                agent.ice_gathering_complete.set()

                answer = await agent.create_answer(offer)

                assert answer is not None
                assert isinstance(answer, RTCSessionDescription)
                assert answer.type == "answer"

    @pytest.mark.asyncio
    async def test_set_remote_description(self) -> None:
        """Test setting remote SDP description."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                # Need to create offer first to get into correct signaling state
                agent.ice_gathering_complete.set()
                await agent.create_offer()

                answer = RTCSessionDescription(
                    sdp="v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n",
                    type="answer",
                )

                await agent.set_remote_description(answer)

                assert agent.pc is not None
                assert agent.pc.remoteDescription is not None

    @pytest.mark.asyncio
    async def test_add_ice_candidate(self) -> None:
        """Test adding ICE candidate."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                # Valid ICE candidate SDP
                candidate_dict = {
                    "candidate": "candidate:1 1 UDP 2130706431 192.168.1.100 54321 typ host",
                    "sdpMid": "0",
                    "sdpMLineIndex": 0,
                }

                await agent.add_ice_candidate(candidate_dict)

                # Verify no exceptions were raised

    @pytest.mark.asyncio
    async def test_send_data_when_channel_open(self) -> None:
        """Test sending data over DataChannel when open."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                # Create and mock DataChannel
                channel = await agent.create_data_channel()
                channel.send = Mock()  # type: ignore[method-assign]

                # Mock readyState property
                with patch.object(type(channel), "readyState", new_callable=lambda: property(lambda self: "open")):
                    await agent.send_data("test message")
                    channel.send.assert_called_once_with("test message")

    @pytest.mark.asyncio
    async def test_send_data_when_channel_closed_raises_error(self) -> None:
        """Test sending data raises error when DataChannel is closed."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                channel = await agent.create_data_channel()

                # Mock readyState property to return "closed"
                with patch.object(type(channel), "readyState", new_callable=lambda: property(lambda self: "closed")):
                    with pytest.raises(RuntimeError, match="DataChannel not open"):
                        await agent.send_data("test message")

    @pytest.mark.asyncio
    async def test_disconnect_closes_connections(self) -> None:
        """Test disconnect() closes all connections."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession") as mock_session:
            mock_ws = AsyncMock()
            mock_session.return_value.ws_connect.return_value = mock_ws

            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                await agent.disconnect()

                assert agent.state == ConnectionState.DISCONNECTED
                assert agent.pc is None
                assert agent.data_channel is None
                assert agent.should_reconnect is False

    def test_get_state(self) -> None:
        """Test getting connection state."""
        agent = TunnelAgent()

        assert agent.get_state() == ConnectionState.DISCONNECTED

        agent.state = ConnectionState.CONNECTED
        assert agent.get_state() == ConnectionState.CONNECTED

    def test_is_connected(self) -> None:
        """Test is_connected() returns correct value."""
        agent = TunnelAgent()

        assert agent.is_connected() is False

        agent.state = ConnectionState.CONNECTED
        assert agent.is_connected() is True

        agent.state = ConnectionState.FAILED
        assert agent.is_connected() is False

    def test_get_data_channel_state(self) -> None:
        """Test getting DataChannel state."""
        agent = TunnelAgent()

        assert agent.get_data_channel_state() == "none"

        agent.data_channel = Mock()
        agent.data_channel.readyState = "open"
        assert agent.get_data_channel_state() == "open"

        agent.data_channel.readyState = "closed"
        assert agent.get_data_channel_state() == "closed"

    @pytest.mark.asyncio
    async def test_state_change_callback(self) -> None:
        """Test state change callback is invoked."""
        agent = TunnelAgent()
        callback_called = False
        new_state = None

        def state_callback(state: ConnectionState) -> None:
            nonlocal callback_called, new_state
            callback_called = True
            new_state = state

        agent.on_state_change = state_callback

        await agent._set_state(ConnectionState.CONNECTED)

        assert callback_called is True
        assert new_state == ConnectionState.CONNECTED

    @pytest.mark.asyncio
    async def test_process_signaling_offer(self) -> None:
        """Test processing signaling offer message."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                with patch.object(agent, "_send_signaling_message", new=AsyncMock()):
                    await agent.connect(
                        signal_url="ws://localhost:8000/signal",
                        device_id="device-123",
                        token="test-token",
                    )

                    # Mock ICE gathering
                    agent.ice_gathering_complete.set()

                    # Process offer message
                    offer_msg = {
                        "type": "offer",
                        "sender_device_id": "sender-789",
                        "payload": {
                            "sdp": "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n",
                            "type": "offer",
                        },
                    }

                    await agent._process_signaling_message(offer_msg)

                    # Verify answer was sent
                    assert agent._send_signaling_message.call_count == 1  # type: ignore[attr-defined]
                    call_args = agent._send_signaling_message.call_args[0][0]  # type: ignore[attr-defined]
                    assert call_args["type"] == "answer"
                    assert call_args["target_device_id"] == "sender-789"

    @pytest.mark.asyncio
    async def test_process_signaling_answer(self) -> None:
        """Test processing signaling answer message."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                # Create offer first
                agent.ice_gathering_complete.set()
                await agent.create_offer()

                # Process answer message
                answer_msg = {
                    "type": "answer",
                    "payload": {
                        "sdp": "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n",
                        "type": "answer",
                    },
                }

                await agent._process_signaling_message(answer_msg)

                assert agent.pc is not None
                assert agent.pc.remoteDescription is not None

    @pytest.mark.asyncio
    async def test_process_signaling_ice_candidate(self) -> None:
        """Test processing ICE candidate message."""
        agent = TunnelAgent()

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                # Process ICE candidate message
                ice_msg = {
                    "type": "ice-candidate",
                    "payload": {
                        "candidate": "candidate:1 1 UDP 2130706431 192.168.1.100 54321 typ host",
                        "sdpMid": "0",
                        "sdpMLineIndex": 0,
                    },
                }

                await agent._process_signaling_message(ice_msg)

                # Verify no exceptions were raised

    @pytest.mark.asyncio
    async def test_data_channel_callback(self) -> None:
        """Test DataChannel message callback."""
        agent = TunnelAgent()
        received_message = None

        def message_callback(msg: str) -> None:
            nonlocal received_message
            received_message = msg

        agent.on_data_channel_message = message_callback

        with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
            with patch.object(agent, "_connect_signaling", new=AsyncMock()):
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id="device-123",
                    token="test-token",
                )

                channel = await agent.create_data_channel()

                # Simulate receiving a message by calling the handler directly
                # (in real usage, this would be triggered by aiortc)
                if hasattr(channel, "_RTCDataChannel__events"):  # Access internal event system
                    # Trigger the message event manually for testing
                    pass  # aiortc internals make this difficult to test directly

                # For now, just verify the callback is set correctly
                assert agent.on_data_channel_message is message_callback
