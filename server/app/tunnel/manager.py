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

"""
TunnelAgent Manager for FastAPI integration.

Manages the lifecycle of TunnelAgent, including:
- Auto-start on server startup (if authenticated)
- Auto-start on login
- Auto-stop on logout
- Graceful shutdown
- Status reporting
"""

import asyncio
import logging
from typing import Any

from app.db import get_auth_state
from app.tunnel.webrtc_client import ConnectionState, TunnelAgent

logger = logging.getLogger(__name__)


class TunnelManager:
    """Manages TunnelAgent lifecycle within FastAPI application."""

    def __init__(self, local_server_url: str = "http://localhost:5142") -> None:
        """Initialize the TunnelManager.

        Args:
            local_server_url: URL of local Lem server to proxy to
        """
        self.local_server_url = local_server_url
        self.agent: TunnelAgent | None = None
        self.is_enabled: bool = False
        self._status_lock = asyncio.Lock()

    async def start(self) -> None:
        """Start TunnelAgent if user is authenticated.

        This is called:
        1. On server startup (if auth state exists)
        2. After successful login

        Does nothing if already running or not authenticated.
        """
        async with self._status_lock:
            # Check if already running
            if (
                self.agent is not None
                and not self.agent.get_state() == ConnectionState.DISCONNECTED
            ):
                logger.info("TunnelAgent already running")
                return

            # Check for stored auth credentials
            auth_state = get_auth_state()
            if auth_state is None:
                logger.info("No auth state found, TunnelAgent not started")
                return

            # Create new TunnelAgent instance
            self.agent = TunnelAgent(local_server_url=self.local_server_url)
            self.is_enabled = True

            # Set up state change callback
            def on_state_change(state: ConnectionState) -> None:
                logger.info(f"TunnelAgent state changed: {state}")

            self.agent.on_state_change = on_state_change

            # Build WebSocket signaling URL
            signal_url = auth_state.signaling_url.replace("http://", "ws://").replace("https://", "wss://")
            if not signal_url.endswith("/signal"):
                signal_url = f"{signal_url}/signal"

            # Start connection
            logger.info(
                f"Starting TunnelAgent: device_id={auth_state.device_id}, "
                f"signal_url={signal_url}"
            )

            try:
                await self.agent.connect(
                    signal_url=signal_url,
                    device_id=auth_state.device_id,
                    token=auth_state.jwt_token,
                )
                logger.info("✓ TunnelAgent started successfully")
            except Exception as e:
                logger.error(f"Failed to start TunnelAgent: {e}")
                self.agent = None
                self.is_enabled = False
                raise

    async def stop(self) -> None:
        """Stop TunnelAgent gracefully.

        This is called:
        1. On server shutdown
        2. After logout
        3. When user explicitly disables tunnel
        """
        async with self._status_lock:
            if self.agent is None:
                logger.info("TunnelAgent not running")
                return

            logger.info("Stopping TunnelAgent...")
            try:
                await self.agent.disconnect()
                logger.info("✓ TunnelAgent stopped successfully")
            except Exception as e:
                logger.error(f"Error stopping TunnelAgent: {e}")
            finally:
                self.agent = None
                self.is_enabled = False

    async def enable(self) -> None:
        """Enable tunnel (start if not running).

        Raises:
            RuntimeError: If not authenticated
        """
        auth_state = get_auth_state()
        if auth_state is None:
            raise RuntimeError("Not authenticated - login required before enabling tunnel")

        await self.start()

    async def disable(self) -> None:
        """Disable tunnel (stop if running)."""
        await self.stop()

    def get_status(self) -> dict[str, Any]:
        """Get current tunnel status.

        Returns:
            Status dictionary with mode, device_id, connection state, and connection mode
        """
        auth_state = get_auth_state()

        if auth_state is None:
            return {
                "mode": "offline",
                "authenticated": False,
            }

        if self.agent is None:
            return {
                "mode": "offline",
                "authenticated": True,
                "device_id": auth_state.device_id,
            }

        # Map ConnectionState to user-friendly mode
        state = self.agent.get_state()
        mode_map = {
            ConnectionState.DISCONNECTED: "offline",
            ConnectionState.CONNECTING: "connecting",
            ConnectionState.CONNECTED: "connected",
            ConnectionState.FAILED: "failed",
            ConnectionState.CLOSED: "offline",
        }

        # Get connection mode (webrtc or relay)
        connection_mode = self.agent.get_connection_mode()

        # Build status response
        status: dict[str, Any] = {
            "mode": mode_map.get(state, "offline"),
            "authenticated": True,
            "device_id": auth_state.device_id,
            "connection_state": state.value,
            "data_channel_state": self.agent.get_data_channel_state(),
            "connection_mode": connection_mode,
        }

        # If connected via relay, update mode to show "relay-ws"
        if state == ConnectionState.CONNECTED and connection_mode == "relay":
            status["mode"] = "relay-ws"

        return status

    def is_connected(self) -> bool:
        """Check if tunnel is connected.

        Returns:
            True if connected, False otherwise
        """
        return self.agent is not None and self.agent.is_connected()
