#!/usr/bin/env python3
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

"""Test script for relay server using WebSocket clients."""

import asyncio
import sys

import websockets


async def client1(token: str, session_id: str) -> None:
    """First client - sends messages.

    Args:
        token: JWT token for authentication.
        session_id: Session ID to connect to.
    """
    uri = f"ws://localhost:8001/relay/{session_id}?token={token}"
    print(f"Client 1: Connecting to {uri}")

    async with websockets.connect(uri) as websocket:
        print("Client 1: Connected!")

        # Send messages
        for i in range(3):
            message = f"Hello from client 1, message {i + 1}"
            print(f"Client 1: Sending: {message}")
            await websocket.send(message.encode())
            await asyncio.sleep(1)

        print("Client 1: Waiting for messages from client 2...")

        # Receive messages
        try:
            for _ in range(3):
                response = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                if isinstance(response, bytes):
                    response = response.decode()
                print(f"Client 1: Received: {response}")
        except asyncio.TimeoutError:
            print("Client 1: Timeout waiting for messages")


async def client2(token: str, session_id: str) -> None:
    """Second client - receives then sends messages.

    Args:
        token: JWT token for authentication.
        session_id: Session ID to connect to.
    """
    # Wait a bit to ensure client 1 connects first
    await asyncio.sleep(1)

    uri = f"ws://localhost:8001/relay/{session_id}?token={token}"
    print(f"Client 2: Connecting to {uri}")

    async with websockets.connect(uri) as websocket:
        print("Client 2: Connected!")

        # Receive messages first
        try:
            for _ in range(3):
                message = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                if isinstance(message, bytes):
                    message = message.decode()
                print(f"Client 2: Received: {message}")
        except asyncio.TimeoutError:
            print("Client 2: Timeout waiting for messages")

        # Send messages back
        for i in range(3):
            message = f"Hello from client 2, message {i + 1}"
            print(f"Client 2: Sending: {message}")
            await websocket.send(message.encode())
            await asyncio.sleep(1)


async def main() -> None:
    """Run the test."""
    if len(sys.argv) != 2:
        print("Usage: python test_relay.py <jwt_token>")
        print("\nGet a token from the signaling server:")
        print('  curl -X POST http://localhost:8000/auth/register \\')
        print('    -H "Content-Type: application/json" \\')
        print('    -d \'{"email":"test@example.com","password":"testpass123"}\'')
        sys.exit(1)

    token = sys.argv[1]
    session_id = "test-session-123"

    print("=" * 60)
    print("Testing Relay Server")
    print("=" * 60)

    # Run both clients concurrently
    try:
        await asyncio.gather(client1(token, session_id), client2(token, session_id))
        print("\n" + "=" * 60)
        print("✓ Test completed successfully!")
        print("=" * 60)
    except Exception as e:
        print(f"\n✗ Test failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
