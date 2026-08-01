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

"""Grant single-use across teardown, no URL credentials, classified errors.

The adversarial review of PR #45 found that ``jti`` redemption was tracked on
the ``RelaySession`` object, so tearing a session down forgot that a grant had
been spent: the same still-unexpired grant opened a brand new session, and
bytes flowed. ``test_grant_is_single_use`` claimed to cover this in its
docstring but only asserted that the session count returned to zero.
"""

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.errors import ErrorReason
from app.core.security import decode_session_grant
from app.core.session_manager import session_manager
from tests.conftest import (
    encode,
    expect_closed,
    make_account_token,
    make_grant,
    relay_connect,
    wait_until,
)

SESSION = "session-under-test"
BROWSER = "browser-alice"
LAPTOP = "local-server-a1b2c3d4"
USER_ID = 1


def test_grant_cannot_be_replayed_after_the_session_is_torn_down(
    client: TestClient,
) -> None:
    """A spent grant stays spent for its whole TTL, not just its session's life.

    Before the fix this replay was accepted, a second session was created, and
    the reviewer observed ``b'REPLAYED-GRANT-STILL-WORKS'`` forwarded across it.
    """
    browser_grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID, jti="fixed-jti")
    laptop_grant = make_grant(SESSION, LAPTOP, BROWSER, USER_ID)

    # Pair the session once, legitimately.
    with relay_connect(client, SESSION, browser_grant):
        assert wait_until(lambda: session_manager.get_session_count() == 1)
        with relay_connect(client, SESSION, laptop_grant):
            assert wait_until(lambda: session_manager.get_session_count() == 1)

    # Tear it down completely: the RelaySession object that remembered the jti
    # is now gone, which is exactly the condition the exploit needed.
    assert wait_until(lambda: session_manager.get_session_count() == 0)

    # Replay the same, still-unexpired grant.
    with relay_connect(client, SESSION, browser_grant) as replay:
        frames = expect_closed(replay)

    assert frames[0]["message"] == "Grant has already been used"
    assert frames[0]["reason"] == ErrorReason.GRANT_ALREADY_USED
    assert frames[0]["retryable"] is False
    assert session_manager.get_session_count() == 0


def test_a_replayed_grant_cannot_open_a_different_session(client: TestClient) -> None:
    """Redemption is by jti, so a replay cannot dodge it by changing the URL.

    A grant is bound to its own ``sid``, so the only session a replay can name
    is the original one - but the check lives on the manager rather than on any
    one session, so this holds regardless.
    """
    grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID, jti="single-shot")

    with relay_connect(client, SESSION, grant):
        assert wait_until(lambda: session_manager.get_session_count() == 1)
    assert wait_until(lambda: session_manager.get_session_count() == 0)

    with relay_connect(client, SESSION, grant) as replay:
        frames = expect_closed(replay)

    assert frames[0]["reason"] == ErrorReason.GRANT_ALREADY_USED


def test_a_rejected_join_does_not_burn_the_grant(client: TestClient) -> None:
    """A grant refused for some other reason stays usable against its session.

    Redemption is recorded only after the join succeeds, so a client that
    collides with a capacity cap can still use its grant once room appears.
    """
    grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID, jti="not-burned")
    other = make_grant("someone-elses-session", "browser-b", "laptop-b", 2)

    with relay_connect(client, "someone-elses-session", other):
        assert wait_until(lambda: session_manager.get_session_count() == 1)

        # Capacity is full, so this join is refused before it ever pairs.
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(settings, "max_sessions", 1)
            with relay_connect(client, SESSION, grant) as refused:
                frames = expect_closed(refused)
            assert frames[0]["reason"] == ErrorReason.RELAY_AT_CAPACITY

    assert wait_until(lambda: session_manager.get_session_count() == 0)

    # The same grant still works now that there is room.
    with relay_connect(client, SESSION, grant):
        assert wait_until(lambda: session_manager.get_session_count() == 1)


def test_an_expired_redemption_record_is_pruned() -> None:
    """Spent jtis are forgotten once the grant they came from has expired.

    An expired grant is refused by ``decode_session_grant`` anyway, so keeping
    the record past its expiry would only grow without bound.
    """
    session_manager.reset()
    spent = decode_session_grant(
        make_grant(SESSION, BROWSER, LAPTOP, USER_ID, jti="short-lived", expires_in=120),
        SESSION,
    )
    session_manager._redeemed_jti[spent.jti] = spent.expires_at
    assert spent.jti in session_manager._redeemed_jti

    # Backdate the record to just past its expiry and prune.
    session_manager._redeemed_jti[spent.jti] = 1.0
    session_manager._prune_redeemed()
    assert spent.jti not in session_manager._redeemed_jti


def test_query_string_credentials_are_refused(client: TestClient) -> None:
    """The ?token= path is gone, and says so in an actionable way.

    It was fully accepted, and uvicorn's access log plus nginx's default log
    format both record the query string in plaintext on every documented
    deployment - which is how a grant gets captured in the first place.
    """
    grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID)

    with client.websocket_connect(f"/relay/{SESSION}?token={grant}") as websocket:
        frames = expect_closed(websocket)

    assert frames[0]["reason"] == ErrorReason.UNSUPPORTED_CLIENT
    assert frames[0]["retryable"] is False
    assert "no longer accepts ?token=" in frames[0]["message"]
    assert "Update your Lem client" in frames[0]["message"]
    assert session_manager.get_session_count() == 0


def test_a_query_string_account_token_is_refused_too(client: TestClient) -> None:
    """An un-migrated client presenting the old account token gets the same answer.

    Not a generic "Authentication failed": the cure is upgrading the client,
    and no amount of re-authenticating will help.
    """
    with client.websocket_connect(
        f"/relay/{SESSION}?token={make_account_token(USER_ID, 'alice@example.com')}"
    ) as websocket:
        frames = expect_closed(websocket)

    assert frames[0]["reason"] == ErrorReason.UNSUPPORTED_CLIENT


def test_capacity_rejection_is_marked_retryable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A full relay is a transient condition and must be reported as one.

    The merged client (``web/remote/src/lib/relay-client.ts:328-330``) treats
    every error frame as a permanent auth failure and stops reconnecting, so a
    capacity rejection sharing the auth envelope would kill relay reconnection
    for the whole session.
    """
    monkeypatch.setattr(settings, "max_sessions", 1)

    with relay_connect(client, "session-one", make_grant("session-one", BROWSER, LAPTOP, 1)):
        assert wait_until(lambda: session_manager.get_session_count() == 1)

        with relay_connect(
            client, "session-two", make_grant("session-two", "browser-b", "laptop-b", 2)
        ) as extra:
            frames = expect_closed(extra)

    assert frames[0]["message"] == "Relay is at capacity"
    assert frames[0]["reason"] == ErrorReason.RELAY_AT_CAPACITY
    assert frames[0]["retryable"] is True


def test_per_account_limit_is_marked_retryable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The per-account cap is transient too: an existing session will end."""
    monkeypatch.setattr(settings, "max_sessions_per_user", 1)

    first = make_grant("user-session-one", BROWSER, LAPTOP, 1)
    second = make_grant("user-session-two", "browser-c", "laptop-c", 1)

    with relay_connect(client, "user-session-one", first):
        assert wait_until(lambda: session_manager.get_session_count() == 1)

        with relay_connect(client, "user-session-two", second) as extra:
            frames = expect_closed(extra)

    assert frames[0]["message"] == "Too many concurrent relay sessions for this account"
    assert frames[0]["reason"] == ErrorReason.ACCOUNT_SESSION_LIMIT
    assert frames[0]["retryable"] is True


def test_auth_rejection_is_marked_terminal(client: TestClient) -> None:
    """An authentication failure is permanent and must be reported as one."""
    with relay_connect(
        client, SESSION, make_account_token(USER_ID, "alice@example.com")
    ) as websocket:
        frames = expect_closed(websocket)

    assert frames[0]["message"] == "Authentication failed"
    assert frames[0]["reason"] == ErrorReason.AUTH_FAILED
    assert frames[0]["retryable"] is False


def test_a_third_scope_is_refused_as_a_grant(client: TestClient) -> None:
    """Positive validation: only the relay-session scope is accepted here.

    A token wearing some scope invented later is refused by the same check that
    refuses an account token, rather than by an enumeration of known-bad ones.
    """
    from datetime import UTC, datetime, timedelta

    future_scope = encode(
        {
            "scope": "some-future-scope",
            "sid": SESSION,
            "device_id": BROWSER,
            "peer_device_id": LAPTOP,
            "user_id": USER_ID,
            "jti": "future",
            "exp": datetime.now(UTC) + timedelta(minutes=5),
        }
    )

    with relay_connect(client, SESSION, future_scope) as websocket:
        frames = expect_closed(websocket)

    assert frames[0]["reason"] == ErrorReason.AUTH_FAILED
    assert session_manager.get_session_count() == 0
