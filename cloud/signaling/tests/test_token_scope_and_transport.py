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

"""Scope validation fails closed, and credentials never travel in a URL."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from jose import jwt

from app.core.config import settings
from app.core.errors import ErrorReason
from app.core.security import ACCOUNT_TOKEN_SCOPE, decode_access_token, decode_token
from tests.conftest import Account

DEVICE = "local-server-a1b2c3d4"


def signed(claims: dict[str, object]) -> str:
    """Sign arbitrary claims with the server's own key.

    Args:
        claims: Claims to encode.

    Returns:
        Encoded JWT.
    """
    token: str = jwt.encode(claims, settings.secret_key, algorithm=settings.algorithm)
    return token


def test_a_token_with_no_scope_is_refused() -> None:
    """Legacy unscoped tokens are not account tokens.

    Absence-checking would have accepted these. Requiring the claim means a
    token minted before scopes existed fails closed rather than open.
    """
    legacy = signed(
        {
            "sub": "alice@example.com",
            "user_id": 1,
            "exp": datetime.now(UTC) + timedelta(hours=1),
        }
    )
    with pytest.raises(Exception, match="scope"):
        decode_access_token(legacy)


def test_an_unknown_third_scope_is_refused() -> None:
    """The failure mode is structural: a scope nobody has heard of is refused.

    This is the property an absence-check cannot give. Adding a third token
    type later cannot silently make it acceptable at an account endpoint.
    """
    future = signed(
        {
            "sub": "alice@example.com",
            "user_id": 1,
            "scope": "some-future-scope",
            "exp": datetime.now(UTC) + timedelta(hours=1),
        }
    )
    with pytest.raises(Exception, match="scope"):
        decode_access_token(future)

    # ...and it does not satisfy any other scope either.
    with pytest.raises(Exception, match="scope"):
        decode_token(future, expected_scope="relay-session")


def test_an_account_token_still_works(client: TestClient) -> None:
    """The positive path is unaffected: a real account token is accepted."""
    account = Account(client, "positive@example.com")
    account.register_device(DEVICE)

    response = client.get("/devices/", headers=account.headers)
    assert response.status_code == 200
    assert decode_access_token(account.token)["scope"] == ACCOUNT_TOKEN_SCOPE


def test_signal_refuses_a_query_string_credential(client: TestClient) -> None:
    """The ?token= path is gone, and says so in an actionable way.

    It was fully accepted, and uvicorn's access log plus nginx's default log
    format both record the query string in plaintext on every documented
    deployment - which is how a grant gets captured in the first place.
    """
    account = Account(client, "querystring@example.com")
    account.register_device(DEVICE)

    with client.websocket_connect(f"/signal?token={account.token}&device_id={DEVICE}") as websocket:
        frame = websocket.receive_json()

    assert frame["type"] == "error"
    assert frame["reason"] == ErrorReason.UNSUPPORTED_CLIENT
    assert frame["retryable"] is False
    # Actionable rather than a silent hang or a generic "Authentication failed".
    assert "no longer accepts ?token=" in frame["message"]
    assert "Update your Lem client" in frame["message"]


def test_a_query_string_credential_never_authenticates(client: TestClient) -> None:
    """Query credentials are refused before the socket is registered."""
    from app.api.signal import manager

    account = Account(client, "querystring-noauth@example.com")
    account.register_device(DEVICE)

    with client.websocket_connect(f"/signal?token={account.token}&device_id={DEVICE}") as websocket:
        websocket.receive_json()

    assert DEVICE not in manager.active_connections


def test_error_frames_are_classified(client: TestClient) -> None:
    """Errors carry a machine-readable reason and an explicit retryable flag.

    A client must be able to tell "come back later" from "your credentials are
    wrong" from the frame alone, without waiting on a close code that arrives
    separately and may never arrive at all.
    """
    account = Account(client, "classified@example.com")
    account.register_device(DEVICE)

    with account.connect_signaling(DEVICE) as websocket:
        websocket.send_json({"type": "connect-request", "target_device_id": "not-a-device-of-mine"})
        frame = websocket.receive_json()

    # Offline / unknown / not-yours is retryable: the usual cause is a device
    # that is simply not connected right now.
    assert frame["type"] == "error"
    assert frame["reason"] == ErrorReason.TARGET_UNAVAILABLE
    assert frame["retryable"] is True


def test_a_bad_auth_frame_is_terminal(client: TestClient) -> None:
    """A protocol error is marked terminal, not retryable."""
    with client.websocket_connect("/signal") as websocket:
        websocket.send_json({"type": "hello"})
        frame = websocket.receive_json()

    assert frame["reason"] == ErrorReason.PROTOCOL_ERROR
    assert frame["retryable"] is False
