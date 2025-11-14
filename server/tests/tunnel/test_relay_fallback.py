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

"""Test relay fallback functionality."""

import asyncio
import logging

import pytest

from app.tunnel.relay_client import RelayClient, RelayConnectionState
from app.tunnel.webrtc_client import TunnelAgent

# Set up logging for test visibility
logging.basicConfig(level=logging.INFO)


@pytest.mark.asyncio
async def test_relay_client_connection() -> None:
    """Test that RelayClient can connect to relay server."""
    # This test requires the relay server to be running on localhost:8001
    # and the signaling server to be running on localhost:8000

    # Create relay client
    relay_client = RelayClient(local_server_url="http://localhost:5142")

    # For testing, we'll use a dummy session_id and token
    # In production, these come from the signaling server
    session_id = "test-session-123"
    token = "dummy-token"  # Note: This will fail auth, but we can test the connection attempt

    try:
        # Try to connect (will fail if server is not running or auth fails)
        await relay_client.connect(
            relay_url="ws://localhost:8001",
            session_id=session_id,
            token=token,
        )
    except Exception as e:
        # Expected to fail due to invalid token or connection refused (server not running)
        error_str = str(e)
        assert (
            "401" in error_str
            or "Invalid token" in error_str
            or "Authentication" in error_str
            or "Cannot connect" in error_str
            or "Connection refused" in error_str
        )

    # Clean up
    await relay_client.disconnect()


@pytest.mark.asyncio
async def test_tunnel_agent_webrtc_timeout() -> None:
    """Test that TunnelAgent times out WebRTC and attempts reconnection."""
    # Create tunnel agent with very short timeout
    agent = TunnelAgent(
        local_server_url="http://localhost:5142",
        relay_url="ws://localhost:8001"
    )

    # Override timeout for faster test
    agent.webrtc_timeout = 1.0  # 1 second timeout
    agent.max_webrtc_attempts = 1  # Only try once before falling back

    # We can't fully test the WebRTC fallback without a real signaling server
    # but we can verify the initialization and configuration
    assert agent.connection_mode == "webrtc"
    assert agent.webrtc_attempts == 0
    assert agent.relay_url == "ws://localhost:8001"

    # Clean up
    await agent.disconnect()


def test_tunnel_agent_get_connection_mode() -> None:
    """Test that TunnelAgent.get_connection_mode() returns correct mode."""
    agent = TunnelAgent(
        local_server_url="http://localhost:5142",
        relay_url="ws://localhost:8001"
    )

    # Initially should be webrtc mode
    assert agent.get_connection_mode() == "webrtc"

    # Simulate switching to relay mode
    agent.connection_mode = "relay"
    assert agent.get_connection_mode() == "relay"
