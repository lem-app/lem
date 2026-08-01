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

"""Shared fixtures for the relay test suite.

Settings are read at import time and now fail closed, so the environment has
to be populated before ``app`` is imported anywhere. conftest is imported
before any test module, which makes this the right place for it.
"""

import os

# Deliberately a test-only key, and long enough to satisfy the minimum length
# check. Set before importing anything from ``app``.
TEST_SECRET_KEY = "test-secret-key-for-the-relay-suite-0123456789"

os.environ.setdefault("SECRET_KEY", TEST_SECRET_KEY)
os.environ.setdefault("CORS_ORIGINS", "http://localhost:5173")

import time  # noqa: E402
from collections.abc import Callable, Iterator  # noqa: E402
from contextlib import contextmanager  # noqa: E402
from datetime import UTC, datetime, timedelta  # noqa: E402
from typing import Any  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from jose import jwt  # noqa: E402
from starlette.testclient import WebSocketTestSession  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.security import RELAY_GRANT_SCOPE  # noqa: E402
from app.core.session_manager import session_manager  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(autouse=True)
def clean_sessions(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Give every test an empty session registry and short waits.

    The production pair timeout is 30 seconds. Tests that deliberately leave a
    connection unpaired would otherwise hold the suite open for that long, so
    it is shortened here; tests asserting on the timeout set their own value.

    Args:
        monkeypatch: pytest patcher.

    Yields:
        None, for the duration of the test.
    """
    monkeypatch.setattr(settings, "pair_timeout", 3)
    session_manager.reset()
    yield
    session_manager.reset()


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Provide an in-process ASGI test client.

    Yields:
        A TestClient bound to the relay app.
    """
    with TestClient(app) as test_client:
        yield test_client


@contextmanager
def relay_connect(
    client: TestClient, session_id: str, grant: str
) -> Iterator[WebSocketTestSession]:
    """Open a relay socket and present a grant in the auth message.

    The ``?token=`` query path is gone, so every test drives the same
    first-message handshake a real client now has to use.

    Args:
        client: Test client.
        session_id: Session to connect to.
        grant: Grant to present.

    Yields:
        The connected WebSocket test session.
    """
    with client.websocket_connect(f"/relay/{session_id}") as websocket:
        websocket.send_json({"type": "auth", "token": grant})
        yield websocket


def expect_closed(websocket: WebSocketTestSession) -> list[Any]:
    """Consume frames until the server closes the socket.

    Args:
        websocket: An open test session.

    Returns:
        Any frames received before the close.

    Raises:
        AssertionError: If the server never closes the connection.
    """
    received: list[Any] = []
    try:
        for _ in range(10):
            received.append(websocket.receive_json())
    except WebSocketDisconnect:
        return received
    raise AssertionError("Expected the server to close the connection")


def wait_until(predicate: Callable[[], bool], timeout: float = 5.0) -> bool:
    """Poll a predicate until it holds or the timeout elapses.

    The ASGI app runs in the test client's own event loop thread, so tests
    have to yield the GIL to let the server make progress.

    Args:
        predicate: Condition to wait for.
        timeout: Maximum seconds to wait.

    Returns:
        True if the predicate became true within the timeout.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return predicate()


def encode(claims: dict[str, Any]) -> str:
    """Sign arbitrary claims with the server's key.

    Args:
        claims: Claims to encode.

    Returns:
        Encoded JWT.
    """
    token: str = jwt.encode(claims, settings.secret_key, algorithm=settings.algorithm)
    return token


def make_grant(
    session_id: str,
    device_id: str,
    peer_device_id: str,
    user_id: int = 1,
    jti: str | None = None,
    expires_in: int = 120,
) -> str:
    """Mint a relay session grant exactly as the signaling server would.

    Args:
        session_id: Session the grant is valid for.
        device_id: Device permitted to present the grant.
        peer_device_id: The only permitted peer.
        user_id: Owner of both devices.
        jti: Optional fixed token id, to test replay.
        expires_in: Seconds until expiry; negative for an expired grant.

    Returns:
        Encoded grant.
    """
    return encode(
        {
            "scope": RELAY_GRANT_SCOPE,
            "sid": session_id,
            "device_id": device_id,
            "peer_device_id": peer_device_id,
            "user_id": user_id,
            "jti": jti or f"{session_id}:{device_id}",
            "exp": datetime.now(UTC) + timedelta(seconds=expires_in),
        }
    )


def make_account_token(user_id: int, email: str) -> str:
    """Mint an ordinary account access token.

    This is exactly what the proven exploit used: a perfectly valid login
    token for an unrelated account.

    Args:
        user_id: Account id to encode.
        email: Account email to encode.

    Returns:
        Encoded access token.
    """
    return encode(
        {
            "sub": email,
            "user_id": user_id,
            "exp": datetime.now(UTC) + timedelta(hours=1),
        }
    )
