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

"""API endpoint tests."""

import os
from typing import AsyncIterator

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from app.db import init_db
from app.main import app


@pytest.fixture(autouse=True)
def setup_test_db() -> AsyncIterator[None]:
    """Set up test database before each test."""
    # Use a separate test database
    test_db = "test_signaling.db"
    if os.path.exists(test_db):
        os.remove(test_db)

    # Override database file for tests
    import app.db.database as db_module

    db_module.DATABASE_FILE = test_db

    yield

    # Cleanup
    if os.path.exists(test_db):
        os.remove(test_db)


@pytest.fixture
async def client() -> AsyncIterator[AsyncClient]:
    """Create test client.

    Yields:
        Test client.
    """
    await init_db()
    transport = ASGITransport(app=app)  # type: ignore[arg-type]
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.mark.asyncio
async def test_health_check(client: AsyncClient) -> None:
    """Test health check endpoint."""
    response = await client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "timestamp" in data


@pytest.mark.asyncio
async def test_register_user(client: AsyncClient) -> None:
    """Test user registration."""
    response = await client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    assert response.status_code == 201
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


@pytest.mark.asyncio
async def test_register_duplicate_user(client: AsyncClient) -> None:
    """Test registering duplicate user fails."""
    # Register first user
    await client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )

    # Try to register again
    response = await client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    assert response.status_code == 400
    assert "already registered" in response.json()["detail"]


@pytest.mark.asyncio
async def test_login_success(client: AsyncClient) -> None:
    """Test successful login."""
    # Register user
    await client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )

    # Login
    response = await client.post(
        "/auth/login",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


@pytest.mark.asyncio
async def test_login_wrong_password(client: AsyncClient) -> None:
    """Test login with wrong password fails."""
    # Register user
    await client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )

    # Try to login with wrong password
    response = await client.post(
        "/auth/login",
        json={"email": "test@example.com", "password": "wrongpassword"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_register_device(client: AsyncClient) -> None:
    """Test device registration."""
    # Register and login user
    register_response = await client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    token = register_response.json()["access_token"]

    # Register device
    response = await client.post(
        "/devices/register",
        json={"device_id": "device-123", "pubkey": "test-pubkey-xyz"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["id"] == "device-123"
    assert data["pubkey"] == "test-pubkey-xyz"


@pytest.mark.asyncio
async def test_register_device_unauthorized(client: AsyncClient) -> None:
    """Test device registration without auth fails."""
    response = await client.post(
        "/devices/register",
        json={"device_id": "device-123", "pubkey": "test-pubkey-xyz"},
    )
    assert response.status_code == 403  # No authorization header


@pytest.mark.asyncio
async def test_list_devices(client: AsyncClient) -> None:
    """Test listing user devices."""
    # Register and login user
    register_response = await client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    token = register_response.json()["access_token"]

    # Register two devices
    await client.post(
        "/devices/register",
        json={"device_id": "device-1", "pubkey": "pubkey-1"},
        headers={"Authorization": f"Bearer {token}"},
    )
    await client.post(
        "/devices/register",
        json={"device_id": "device-2", "pubkey": "pubkey-2"},
        headers={"Authorization": f"Bearer {token}"},
    )

    # List devices
    response = await client.get(
        "/devices/",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    devices = response.json()
    assert len(devices) == 2
    assert devices[0]["id"] in ["device-1", "device-2"]
    assert devices[1]["id"] in ["device-1", "device-2"]


def test_websocket_connection() -> None:
    """Test WebSocket signaling connection."""
    # First, register a user and device
    sync_client = TestClient(app)

    # Initialize database synchronously for test
    import asyncio

    asyncio.run(init_db())

    # Register user
    register_response = sync_client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    token = register_response.json()["access_token"]

    # Register device
    sync_client.post(
        "/devices/register",
        json={"device_id": "device-ws-test", "pubkey": "pubkey-ws"},
        headers={"Authorization": f"Bearer {token}"},
    )

    # Test WebSocket connection
    with sync_client.websocket_connect(
        f"/signal?token={token}&device_id=device-ws-test"
    ) as websocket:
        # Should receive connection confirmation
        data = websocket.receive_json()
        assert data["type"] == "connected"
        assert data["device_id"] == "device-ws-test"
