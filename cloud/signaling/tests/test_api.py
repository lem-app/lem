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

from fastapi.testclient import TestClient

from app.core.crypto import REGISTER_CONTEXT
from app.core.security import BCRYPT_MAX_PASSWORD_BYTES
from tests.conftest import Account, new_device_key


def test_health_check(client: TestClient) -> None:
    """Test health check endpoint."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert "timestamp" in data


def test_register_user(client: TestClient) -> None:
    """Test user registration."""
    response = client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    assert response.status_code == 201
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


def test_register_duplicate_user(client: TestClient) -> None:
    """Test registering duplicate user fails."""
    client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    response = client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    assert response.status_code == 400
    assert "already registered" in response.json()["detail"]


def test_login_success(client: TestClient) -> None:
    """Test successful login."""
    client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    response = client.post(
        "/auth/login",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


def test_login_wrong_password(client: TestClient) -> None:
    """Test login with wrong password fails."""
    client.post(
        "/auth/register",
        json={"email": "test@example.com", "password": "testpass123"},
    )
    response = client.post(
        "/auth/login",
        json={"email": "test@example.com", "password": "wrongpassword"},
    )
    assert response.status_code == 401


def test_login_unknown_account(client: TestClient) -> None:
    """Logging in as an account that does not exist fails the same way."""
    response = client.post(
        "/auth/login",
        json={"email": "nobody@example.com", "password": "testpass123"},
    )
    assert response.status_code == 401


def test_password_longer_than_bcrypt_accepts_is_rejected(client: TestClient) -> None:
    """L8 regression: over-long passwords are refused, not silently truncated.

    bcrypt hashes only the first 72 bytes, so without this two different long
    passwords would authenticate each other.
    """
    response = client.post(
        "/auth/register",
        json={
            "email": "long@example.com",
            "password": "x" * (BCRYPT_MAX_PASSWORD_BYTES + 1),
        },
    )
    assert response.status_code == 422


def test_multibyte_password_is_measured_in_bytes(client: TestClient) -> None:
    """A password within the character limit but over the byte limit is refused."""
    # 40 characters, 120 UTF-8 bytes.
    response = client.post(
        "/auth/register",
        json={"email": "utf8@example.com", "password": "é" * 40 + "é" * 32},
    )
    assert response.status_code == 422


def test_register_device(client: TestClient) -> None:
    """Test device registration with proof of possession."""
    account = Account(client, "test@example.com")
    account.register_device("device-123")

    devices = client.get("/devices/", headers=account.headers).json()
    assert [device["id"] for device in devices] == ["device-123"]


def test_register_device_unauthorized(client: TestClient) -> None:
    """Absent credentials are rejected with 401, not 403.

    401 is the correct code for a *missing* Authorization header; 403 means
    "authenticated but not permitted" (see
    `test_device_owned_by_another_user_cannot_be_claimed`, a genuine 403).

    FastAPI's `HTTPBearer` returned 403 here until 0.122.0, and this assertion
    used to pin that wart. `pyproject.toml` requires `fastapi>=0.122.0` so the
    correct code is guaranteed.
    """
    response = client.post(
        "/devices/register",
        json={
            "device_id": "device-123",
            "pubkey": "test-pubkey-xyz",
            "challenge": "x",
            "signature": "y",
        },
    )
    assert response.status_code == 401


def test_list_devices(client: TestClient) -> None:
    """Test listing user devices."""
    account = Account(client, "test@example.com")
    account.register_device("device-1")
    account.register_device("device-2")

    response = client.get("/devices/", headers=account.headers)
    assert response.status_code == 200
    devices = response.json()
    assert sorted(device["id"] for device in devices) == ["device-1", "device-2"]


def test_list_devices_is_scoped_to_the_owner(client: TestClient) -> None:
    """A user never sees another user's devices."""
    alice = Account(client, "alice@example.com")
    alice.register_device("alice-device")
    mallory = Account(client, "mallory@evil.com")
    mallory.register_device("mallory-device")

    devices = client.get("/devices/", headers=mallory.headers).json()
    assert [device["id"] for device in devices] == ["mallory-device"]


def test_device_owned_by_another_user_cannot_be_claimed(client: TestClient) -> None:
    """Registering someone else's device id is refused."""
    alice = Account(client, "alice@example.com")
    alice.register_device("alice-device")

    mallory = Account(client, "mallory@evil.com")
    challenge = client.post(
        "/devices/challenge",
        json={"device_id": "alice-device"},
        headers=mallory.headers,
    ).json()["challenge"]

    key = new_device_key()
    response = client.post(
        "/devices/register",
        json={
            "device_id": "alice-device",
            "pubkey": key.pubkey_b64,
            "challenge": challenge,
            "signature": key.sign(REGISTER_CONTEXT, "alice-device", challenge),
        },
        headers=mallory.headers,
    )
    assert response.status_code == 403


def test_websocket_connection(client: TestClient) -> None:
    """Test WebSocket signaling connection with the full handshake."""
    account = Account(client, "test@example.com")
    account.register_device("device-ws-test")

    session = account.connect_signaling("device-ws-test")
    with session:
        assert session.connected["device_id"] == "device-ws-test"
        assert "ice_servers" in session.connected
