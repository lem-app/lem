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

"""Example usage of TunnelAgent for WebRTC connection.

This demonstrates how to use the TunnelAgent to establish a WebRTC connection
to the signaling server and set up a DataChannel.
"""

import asyncio
import logging

from app.tunnel.webrtc_client import ConnectionState, TunnelAgent

# Configure logging
logging.basicConfig(level=logging.INFO)


async def main() -> None:
    """Run example TunnelAgent connection."""
    # Create tunnel agent
    agent = TunnelAgent()

    # Set up callbacks
    def on_state_change(state: ConnectionState) -> None:
        """Handle connection state changes."""
        print(f"Connection state changed to: {state}")

    def on_message(message: str) -> None:
        """Handle DataChannel messages."""
        print(f"Received message: {message}")

    agent.on_state_change = on_state_change
    agent.on_data_channel_message = on_message

    try:
        # Connect to signaling server
        print("Connecting to signaling server...")
        await agent.connect(
            signal_url="ws://localhost:8000/signal",
            device_id="local-device-1",
            token="<JWT_from_signaling_server>",
        )

        print(f"Connection state: {agent.get_state()}")

        # Create DataChannel (for offering peer)
        print("Creating DataChannel...")
        channel = await agent.create_data_channel("http-proxy")

        # Create and send offer (example for offering peer)
        print("Creating SDP offer...")
        offer = await agent.create_offer()
        print(f"SDP offer created: {offer.type}")

        # Wait for connection to establish
        while not agent.is_connected():
            await asyncio.sleep(1)
            print(f"Waiting for connection... State: {agent.get_state()}")

        print("WebRTC connection established!")
        print(f"DataChannel state: {agent.get_data_channel_state()}")

        # Send data over DataChannel (when open)
        if agent.get_data_channel_state() == "open":
            print("Sending data over DataChannel...")
            await agent.send_data("Hello from TunnelAgent!")

        # Keep connection alive for demo
        await asyncio.sleep(10)

    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        # Clean up
        print("Disconnecting...")
        await agent.disconnect()
        print("Disconnected.")


if __name__ == "__main__":
    asyncio.run(main())
