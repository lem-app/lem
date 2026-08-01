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

"""Authorization tests for the relay WebSocket endpoint.

The headline case is the proven cross-account exploit: a JWT belonging to
mallory@evil.com joined a session established by alice@example.com, read her
forwarded bytes and injected a response she accepted.
"""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.api import relay as relay_api
from app.api.relay import MAX_AUTH_FRAME_BYTES
from app.core.session_manager import session_manager
from tests.conftest import (
    encode,
    expect_closed,
    make_account_token,
    make_grant,
    relay_connect,
    wait_until,
)

ALICE_SESSION = "alice-session-id-that-is-unguessable"
ALICE_LAPTOP = "local-server-a1b2c3d4"
ALICE_BROWSER = "browser-alice"
ALICE_USER_ID = 1

MALLORY_USER_ID = 999


def assert_rejected(client: TestClient, session_id: str, token: str) -> None:
    """Assert the relay refuses a connection and never pairs it.

    Args:
        client: Test client.
        session_id: Session id to attempt.
        token: Token to present.
    """
    with relay_connect(client, session_id, token) as websocket:
        # The server replies with an error frame and then closes.
        expect_closed(websocket)

    assert session_manager.get_session_count() == 0


def test_account_token_is_not_a_session_grant(client: TestClient) -> None:
    """C1 regression: a valid account JWT no longer admits anyone to a session.

    This is the exact primitive the exploit relied on. validate_token() used to
    accept any correctly signed token, so mallory's own login token was enough.
    """
    mallory_token = make_account_token(MALLORY_USER_ID, "mallory@evil.com")
    assert_rejected(client, ALICE_SESSION, mallory_token)


def test_alices_own_account_token_is_also_rejected(client: TestClient) -> None:
    """Even the rightful owner must present a scoped grant, not a login token."""
    alice_token = make_account_token(ALICE_USER_ID, "alice@example.com")
    assert_rejected(client, ALICE_SESSION, alice_token)


def test_grant_for_another_session_cannot_be_replayed(client: TestClient) -> None:
    """C1 regression: a grant is bound to one session id and only that one."""
    mallory_grant = make_grant(
        "mallory-own-session",
        device_id="browser-mallory",
        peer_device_id="local-server-mallory",
        user_id=MALLORY_USER_ID,
    )
    assert_rejected(client, ALICE_SESSION, mallory_grant)


def test_grant_missing_scope_is_rejected(client: TestClient) -> None:
    """A token that names the session but is not scoped as a grant is refused."""
    forged = encode(
        {
            "sid": ALICE_SESSION,
            "device_id": "browser-mallory",
            "peer_device_id": ALICE_LAPTOP,
            "user_id": MALLORY_USER_ID,
            "jti": "forged",
            "exp": datetime.now(UTC) + timedelta(minutes=5),
        }
    )
    assert_rejected(client, ALICE_SESSION, forged)


def test_grant_without_expiry_is_rejected(client: TestClient) -> None:
    """L7 regression: a token with no exp claim is not valid forever."""
    everlasting = encode(
        {
            "scope": "relay-session",
            "sid": ALICE_SESSION,
            "device_id": ALICE_BROWSER,
            "peer_device_id": ALICE_LAPTOP,
            "user_id": ALICE_USER_ID,
            "jti": "no-exp",
        }
    )
    assert_rejected(client, ALICE_SESSION, everlasting)


def test_expired_grant_is_rejected(client: TestClient) -> None:
    """An expired grant does not admit a connection."""
    stale = make_grant(ALICE_SESSION, ALICE_BROWSER, ALICE_LAPTOP, ALICE_USER_ID, expires_in=-10)
    assert_rejected(client, ALICE_SESSION, stale)


def test_grant_naming_one_device_twice_is_rejected(client: TestClient) -> None:
    """A grant may not name the same device as both sides of the session."""
    self_pair = make_grant(ALICE_SESSION, ALICE_BROWSER, ALICE_BROWSER, ALICE_USER_ID)
    assert_rejected(client, ALICE_SESSION, self_pair)


def test_malformed_auth_message_is_rejected(client: TestClient) -> None:
    """A first frame that is not an auth message closes the connection."""
    with client.websocket_connect(f"/relay/{ALICE_SESSION}") as websocket:
        websocket.send_text("not json at all")
        expect_closed(websocket)

    assert session_manager.get_session_count() == 0


def test_auth_message_flow_accepts_a_valid_grant(client: TestClient) -> None:
    """The preferred auth-message path admits a correctly scoped grant."""
    grant = make_grant(ALICE_SESSION, ALICE_BROWSER, ALICE_LAPTOP, ALICE_USER_ID)

    with client.websocket_connect(f"/relay/{ALICE_SESSION}") as websocket:
        websocket.send_json({"type": "auth", "token": grant})
        assert wait_until(lambda: session_manager.get_session_count() == 1)


def test_auth_message_of_the_wrong_type_is_rejected(client: TestClient) -> None:
    """A first frame that is valid JSON but not an auth message is refused."""
    with client.websocket_connect(f"/relay/{ALICE_SESSION}") as websocket:
        websocket.send_json({"type": "hello"})
        frames = expect_closed(websocket)

    assert frames[0]["message"] == "First message must be auth message"


def test_auth_message_without_a_token_is_rejected(client: TestClient) -> None:
    """An auth message carrying no grant is refused."""
    with client.websocket_connect(f"/relay/{ALICE_SESSION}") as websocket:
        websocket.send_json({"type": "auth"})
        frames = expect_closed(websocket)

    assert frames[0]["message"] == "Auth message missing token"


def test_oversized_auth_frame_is_rejected(client: TestClient) -> None:
    """An oversized auth frame is refused instead of being parsed."""
    with client.websocket_connect(f"/relay/{ALICE_SESSION}") as websocket:
        websocket.send_json({"type": "auth", "token": "x" * (MAX_AUTH_FRAME_BYTES + 1)})
        frames = expect_closed(websocket)

    assert frames[0]["message"] == "Auth message too large"


def test_auth_timeout_closes_the_connection(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A client that never authenticates is disconnected rather than parked."""
    monkeypatch.setattr(relay_api, "AUTH_TIMEOUT_SECONDS", 0.2)

    with client.websocket_connect(f"/relay/{ALICE_SESSION}") as websocket:
        expect_closed(websocket)

    assert session_manager.get_session_count() == 0
