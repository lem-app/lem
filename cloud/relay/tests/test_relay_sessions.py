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

"""Session lifecycle tests: pairing, timeouts, caps and forwarding."""

import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.session_manager import session_manager
from tests.conftest import expect_closed, make_grant, relay_connect, wait_until

SESSION = "session-under-test"
BROWSER = "browser-alice"
LAPTOP = "local-server-a1b2c3d4"
USER_ID = 1


def test_paired_devices_forward_frames_both_ways(client: TestClient) -> None:
    """A legitimately granted pair relays bytes in both directions."""
    browser_grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID)
    laptop_grant = make_grant(SESSION, LAPTOP, BROWSER, USER_ID)

    with relay_connect(client, SESSION, browser_grant) as browser:
        assert wait_until(lambda: session_manager.get_session_count() == 1)

        with relay_connect(client, SESSION, laptop_grant) as laptop:
            browser.send_bytes(b"HTTP-REQUEST-FROM-ALICE")
            assert laptop.receive_bytes() == b"HTTP-REQUEST-FROM-ALICE"

            laptop.send_bytes(b"HTTP-RESPONSE-FROM-ALICES-LAPTOP")
            assert browser.receive_bytes() == b"HTTP-RESPONSE-FROM-ALICES-LAPTOP"


def test_frames_sent_before_pairing_are_delivered(client: TestClient) -> None:
    """Early frames are buffered rather than dropped, then flushed on pairing."""
    browser_grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID)
    laptop_grant = make_grant(SESSION, LAPTOP, BROWSER, USER_ID)

    with relay_connect(client, SESSION, browser_grant) as browser:
        assert wait_until(lambda: session_manager.get_session_count() == 1)
        browser.send_bytes(b"SENT-BEFORE-PEER-ARRIVED")

        with relay_connect(client, SESSION, laptop_grant) as laptop:
            assert laptop.receive_bytes() == b"SENT-BEFORE-PEER-ARRIVED"


def test_third_connection_is_refused(client: TestClient) -> None:
    """M3 regression: a third socket is closed, not parked in a sleep loop."""
    browser_grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID)
    laptop_grant = make_grant(SESSION, LAPTOP, BROWSER, USER_ID)
    # A third grant for the same session can only exist if it names the same
    # pair, so it necessarily collides with a device that is already connected.
    third_grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID, jti="third-attempt")

    with relay_connect(client, SESSION, browser_grant):
        with relay_connect(client, SESSION, laptop_grant):
            with relay_connect(client, SESSION, third_grant) as third:
                expect_closed(third)


def test_grant_is_single_use(client: TestClient) -> None:
    """Replaying the same grant after disconnecting does not rejoin the session.

    The replay itself is asserted here rather than only inferred from the
    session count, and single use across a full teardown is pinned separately
    by ``test_grant_replay_and_transport.py``.
    """
    browser_grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID, jti="fixed-jti")
    laptop_grant = make_grant(SESSION, LAPTOP, BROWSER, USER_ID)

    with relay_connect(client, SESSION, laptop_grant):
        assert wait_until(lambda: session_manager.get_session_count() == 1)

        with relay_connect(client, SESSION, browser_grant):
            assert wait_until(lambda: session_manager.get_session_count() == 1)

        # The browser's departure tears the session down; the same grant must
        # not be able to resurrect it.
        assert wait_until(lambda: session_manager.get_session_count() == 0)

        with relay_connect(client, SESSION, browser_grant) as replay:
            frames = expect_closed(replay)

    assert frames[0]["message"] == "Grant has already been used"
    assert session_manager.get_session_count() == 0


def test_lone_connection_is_released_after_pair_timeout(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """H3 regression: an unpaired session no longer leaks forever.

    Five lone connections used to pin active_sessions at 5 indefinitely,
    because the handler slept in a loop with no timeout.
    """
    monkeypatch.setattr(settings, "pair_timeout", 1)
    grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID)

    with relay_connect(client, SESSION, grant) as websocket:
        assert wait_until(lambda: session_manager.get_session_count() == 1)
        expect_closed(websocket)

    assert wait_until(lambda: session_manager.get_session_count() == 0)


def test_disconnect_while_waiting_releases_the_session(client: TestClient) -> None:
    """A lone client hanging up is noticed immediately, not after a timeout."""
    grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID)

    with relay_connect(client, SESSION, grant):
        assert wait_until(lambda: session_manager.get_session_count() == 1)

    # Well inside the 3s pair timeout: the release is caused by the hangup.
    assert wait_until(lambda: session_manager.get_session_count() == 0, timeout=1.5)


def test_total_session_cap_is_enforced(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The relay refuses new sessions once it is at capacity."""
    monkeypatch.setattr(settings, "max_sessions", 1)

    first = make_grant("session-one", BROWSER, LAPTOP, USER_ID)
    second = make_grant("session-two", BROWSER, LAPTOP, USER_ID)

    with relay_connect(client, "session-one", first):
        assert wait_until(lambda: session_manager.get_session_count() == 1)

        with relay_connect(client, "session-two", second) as extra:
            expect_closed(extra)

        assert session_manager.get_session_count() == 1


def test_per_user_session_cap_is_enforced(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One account cannot occupy the whole relay."""
    monkeypatch.setattr(settings, "max_sessions_per_user", 1)

    first = make_grant("user-session-one", BROWSER, LAPTOP, USER_ID)
    second = make_grant("user-session-two", BROWSER, LAPTOP, USER_ID)
    other_user = make_grant("other-user-session", "browser-bob", "laptop-bob", 2)

    with relay_connect(client, "user-session-one", first):
        assert wait_until(lambda: session_manager.get_session_count() == 1)

        with relay_connect(client, "user-session-two", second) as extra:
            expect_closed(extra)

        # A different account is unaffected by the first account's usage.
        with relay_connect(client, "other-user-session", other_user):
            assert wait_until(lambda: session_manager.get_session_count() == 2)


def test_session_stats_go_to_the_metering_logger(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    """L6 regression: accounting is logged, not printed to stdout."""
    browser_grant = make_grant(SESSION, BROWSER, LAPTOP, USER_ID)
    laptop_grant = make_grant(SESSION, LAPTOP, BROWSER, USER_ID)

    with caplog.at_level("INFO", logger="lem.relay.metering"):
        with relay_connect(client, SESSION, browser_grant) as browser:
            with relay_connect(client, SESSION, laptop_grant) as laptop:
                browser.send_bytes(b"0123456789")
                assert laptop.receive_bytes() == b"0123456789"

        # The session is dropped from the registry slightly before the closing
        # session finishes emitting its accounting, so wait for the record.
        assert wait_until(
            lambda: any(r.name == "lem.relay.metering" for r in caplog.records)
        )

    records = [r for r in caplog.records if r.name == "lem.relay.metering"]
    assert records, "expected a metering record"
    stats = json.loads(records[-1].getMessage())
    assert stats["event"] == "session_closed"
    assert stats["session_id"] == SESSION
    assert stats["user_id"] == USER_ID
    assert stats["total_bytes"] == 10
    assert sorted(stats["devices"]) == sorted([BROWSER, LAPTOP])
