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

"""Shared fixtures for the signaling test suite.

Settings are read at import time and now fail closed, so the environment has
to be populated before ``app`` is imported anywhere. conftest is imported
before any test module, which makes this the right place for it.
"""

import os

# Deliberately a test-only key, and long enough to satisfy the minimum length
# check. Set before importing anything from ``app``.
TEST_SECRET_KEY = "test-secret-key-for-the-signaling-suite-0123456789"

os.environ.setdefault("SECRET_KEY", TEST_SECRET_KEY)
os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")

import base64  # noqa: E402
from collections.abc import Iterator  # noqa: E402
from dataclasses import dataclass  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from starlette.testclient import WebSocketTestSession  # noqa: E402

from app.api.devices import registration_challenges  # noqa: E402
from app.api.signal import manager  # noqa: E402
from app.core import ratelimit  # noqa: E402
from app.core.crypto import (  # noqa: E402
    REGISTER_CONTEXT,
    ROTATE_CONTEXT,
    SIGNAL_CONTEXT,
    signed_message,
)
from app.db import database  # noqa: E402
from app.main import app  # noqa: E402


@dataclass(frozen=True)
class DeviceKey:
    """An ed25519 keypair standing in for a real device's identity."""

    private_key: Ed25519PrivateKey

    @property
    def pubkey_b64(self) -> str:
        """Base64 of the raw public key, as sent to /devices/register.

        Returns:
            Base64-encoded 32-byte public key.
        """
        from cryptography.hazmat.primitives import serialization

        raw = self.private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        return base64.b64encode(raw).decode("ascii")

    def sign(self, context: bytes, *fields: str) -> str:
        """Sign a server challenge the way a real client must.

        Args:
            context: Domain separation constant.
            *fields: Payload fields, normally ``(device_id, challenge)``.

        Returns:
            Base64-encoded signature.
        """
        signature = self.private_key.sign(signed_message(context, *fields))
        return base64.b64encode(signature).decode("ascii")


def new_device_key() -> DeviceKey:
    """Generate a fresh device keypair.

    Returns:
        A DeviceKey wrapping a new ed25519 private key.
    """
    return DeviceKey(private_key=Ed25519PrivateKey.generate())


@pytest.fixture(autouse=True)
def isolated_state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Give every test a fresh database, empty registries and fresh limiters.

    tmp_path is unique per test, so the suite is hermetic and idempotent: it
    never touches the developer's signaling.db and leaves no state behind.

    Args:
        tmp_path: Per-test temporary directory.
        monkeypatch: pytest patcher.

    Yields:
        None, for the duration of the test.
    """
    monkeypatch.setattr(database, "DATABASE_FILE", str(tmp_path / "signaling.db"))
    for limiter in (
        ratelimit.register_limiter,
        ratelimit.login_ip_limiter,
        ratelimit.login_account_limiter,
        ratelimit.signal_connect_limiter,
    ):
        limiter.reset()
    registration_challenges.clear()
    manager.active_connections.clear()
    yield
    manager.active_connections.clear()


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Provide an in-process ASGI test client with the schema created.

    Yields:
        A TestClient bound to the signaling app.
    """
    with TestClient(app) as test_client:
        yield test_client


class Account:
    """A registered user with a helper for enrolling devices."""

    def __init__(self, client: TestClient, email: str, password: str = "testpass123") -> None:
        """Register the account and keep its token.

        Args:
            client: Test client to register through.
            email: Account email.
            password: Account password.
        """
        self.client = client
        self.email = email
        response = client.post("/auth/register", json={"email": email, "password": password})
        assert response.status_code == 201, response.text
        self.token: str = response.json()["access_token"]
        self.keys: dict[str, DeviceKey] = {}

    @property
    def headers(self) -> dict[str, str]:
        """Authorization headers for this account.

        Returns:
            Bearer token headers.
        """
        return {"Authorization": f"Bearer {self.token}"}

    def challenge_for(self, device_id: str) -> str:
        """Ask the server for a registration challenge.

        Args:
            device_id: Device the challenge is for.

        Returns:
            The issued challenge string.
        """
        response = self.client.post(
            "/devices/challenge", json={"device_id": device_id}, headers=self.headers
        )
        assert response.status_code == 200, response.text
        return str(response.json()["challenge"])

    def register_device(self, device_id: str, key: DeviceKey | None = None) -> DeviceKey:
        """Enrol a device, completing the ed25519 proof of possession.

        Re-registering a device reuses the key already enrolled for it unless
        one is passed explicitly, because replacing a device's key now needs a
        rotation proof - see :meth:`rotate_device_key`.

        Args:
            device_id: Device identifier to register.
            key: Key to enrol; defaults to the enrolled key, else a fresh one.

        Returns:
            The enrolled device key.
        """
        key = key or self.keys.get(device_id) or new_device_key()
        challenge = self.challenge_for(device_id)

        response = self.client.post(
            "/devices/register",
            json={
                "device_id": device_id,
                "pubkey": key.pubkey_b64,
                "challenge": challenge,
                "signature": key.sign(REGISTER_CONTEXT, device_id, challenge),
            },
            headers=self.headers,
        )
        assert response.status_code == 200, response.text
        self.keys[device_id] = key
        return key

    def rotate_device_key(self, device_id: str, new_key: DeviceKey | None = None) -> DeviceKey:
        """Replace a device's key, authorized by the key currently on file.

        Args:
            device_id: Device whose key is being replaced.
            new_key: Replacement key; a fresh one by default.

        Returns:
            The newly enrolled device key.
        """
        old_key = self.keys[device_id]
        new_key = new_key or new_device_key()
        challenge = self.challenge_for(device_id)

        response = self.client.post(
            "/devices/register",
            json={
                "device_id": device_id,
                "pubkey": new_key.pubkey_b64,
                "challenge": challenge,
                "signature": new_key.sign(REGISTER_CONTEXT, device_id, challenge),
                "previous_signature": old_key.sign(
                    ROTATE_CONTEXT, device_id, challenge, new_key.pubkey_b64
                ),
            },
            headers=self.headers,
        )
        assert response.status_code == 200, response.text
        self.keys[device_id] = new_key
        return new_key

    def connect_signaling(self, device_id: str) -> "SignalingSession":
        """Open an authenticated signaling WebSocket for a device.

        Args:
            device_id: Device to connect as.

        Returns:
            A context manager yielding the connected session.
        """
        return SignalingSession(self, device_id)


class SignalingSession:
    """Context manager that performs the full signaling handshake."""

    def __init__(self, account: Account, device_id: str) -> None:
        """Prepare a session for a device.

        Args:
            account: Owning account.
            device_id: Device to connect as.
        """
        self.account = account
        self.device_id = device_id
        self._cm = account.client.websocket_connect("/signal")
        # The "connected" frame, kept so tests can assert on its contents.
        self.connected: dict[str, object] = {}

    def __enter__(self) -> WebSocketTestSession:
        """Open the socket and complete auth plus proof of possession.

        Returns:
            The connected WebSocket test session.
        """
        websocket = self._cm.__enter__()
        websocket.send_json(
            {
                "type": "auth",
                "token": self.account.token,
                "device_id": self.device_id,
            }
        )
        challenge_frame = websocket.receive_json()
        assert challenge_frame["type"] == "challenge", challenge_frame
        key = self.account.keys[self.device_id]
        websocket.send_json(
            {
                "type": "auth-response",
                "signature": key.sign(SIGNAL_CONTEXT, self.device_id, challenge_frame["challenge"]),
            }
        )
        self.connected = websocket.receive_json()
        assert self.connected["type"] == "connected", self.connected
        return websocket

    def __exit__(self, *exc_info: object) -> None:
        """Close the socket.

        Args:
            *exc_info: Exception details, ignored.
        """
        self._cm.__exit__(*exc_info)
