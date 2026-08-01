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

"""Routing authorization tests for the signaling WebSocket.

The proven exploit: mallory@evil.com sent a connect-request naming a device
owned by victim@example.com, received an ack, and the victim received a
connect-request-received carrying an attacker-controlled relay_session_id.
The victim's local server auto-accepts, so the attacker forced a stranger's
machine to bridge its local services onto a session the attacker could join.
"""

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from starlette.testclient import WebSocketTestSession

from app.api.signal import MAX_MESSAGE_BYTES, TARGET_UNAVAILABLE, OwnedDeviceCache
from app.core.config import settings
from app.core.security import RELAY_GRANT_SCOPE
from tests.conftest import Account

VICTIM_LAPTOP = "local-server-deadbeef"
VICTIM_BROWSER = "browser-victim"
MALLORY_BROWSER = "browser-mallory"


def assert_nothing_was_injected(websocket: WebSocketTestSession) -> None:
    """Assert no unsolicited frame is queued for this device.

    Frames are delivered in order, so if the blocked message had been routed
    it would be sitting ahead of the answer to the probe sent here.

    Args:
        websocket: An authenticated signaling session.
    """
    websocket.send_json({"type": "offer", "target_device_id": "no-such-device"})
    first = websocket.receive_json()
    assert first["type"] == "error", f"unexpected injected frame: {first}"
    assert first["message"] == TARGET_UNAVAILABLE


def test_c2_cross_user_connect_request_is_refused(client: TestClient) -> None:
    """C2 regression: an account cannot target a device it does not own.

    Mallory holds a valid account and a valid device of her own. She names the
    victim's device id, which is guessable, and must be refused. Crucially the
    victim must also receive nothing at all.
    """
    victim = Account(client, "victim@example.com")
    victim.register_device(VICTIM_LAPTOP)

    mallory = Account(client, "mallory@evil.com")
    mallory.register_device(MALLORY_BROWSER)

    with victim.connect_signaling(VICTIM_LAPTOP) as victim_ws:
        with mallory.connect_signaling(MALLORY_BROWSER) as mallory_ws:
            mallory_ws.send_json(
                {
                    "type": "connect-request",
                    "target_device_id": VICTIM_LAPTOP,
                    "preferred_transport": "relay",
                    "relay_session_id": "attacker-chosen-session",
                }
            )
            response = mallory_ws.receive_json()

        assert response["type"] == "error"
        assert response["message"] == TARGET_UNAVAILABLE
        # The victim's machine was never asked to bridge anything.
        assert_nothing_was_injected(victim_ws)


def test_c2_cross_user_generic_routing_is_refused(client: TestClient) -> None:
    """C2 regression: offer/answer/ice cannot cross a user boundary either."""
    victim = Account(client, "victim@example.com")
    victim.register_device(VICTIM_LAPTOP)

    mallory = Account(client, "mallory@evil.com")
    mallory.register_device(MALLORY_BROWSER)

    with victim.connect_signaling(VICTIM_LAPTOP) as victim_ws:
        with mallory.connect_signaling(MALLORY_BROWSER) as mallory_ws:
            mallory_ws.send_json(
                {
                    "type": "offer",
                    "target_device_id": VICTIM_LAPTOP,
                    "payload": {"sdp": "malicious", "type": "offer"},
                }
            )
            response = mallory_ws.receive_json()

        assert response["type"] == "error"
        assert response["message"] == TARGET_UNAVAILABLE
        assert_nothing_was_injected(victim_ws)


def test_c2_cross_user_connect_ack_is_refused(client: TestClient) -> None:
    """C2 regression: connect-ack is routed under the same ownership rule."""
    victim = Account(client, "victim@example.com")
    victim.register_device(VICTIM_LAPTOP)

    mallory = Account(client, "mallory@evil.com")
    mallory.register_device(MALLORY_BROWSER)

    with victim.connect_signaling(VICTIM_LAPTOP) as victim_ws:
        with mallory.connect_signaling(MALLORY_BROWSER) as mallory_ws:
            mallory_ws.send_json(
                {
                    "type": "connect-ack",
                    "target_device_id": VICTIM_LAPTOP,
                    "transport": "relay",
                    "status": "connected",
                }
            )
            response = mallory_ws.receive_json()

        assert response["type"] == "error"
        assert response["message"] == TARGET_UNAVAILABLE
        assert_nothing_was_injected(victim_ws)


def test_m2_unknown_and_offline_devices_are_indistinguishable(
    client: TestClient,
) -> None:
    """M2 regression: the endpoint is not a presence oracle.

    A device that does not exist, one owned by someone else, and one of the
    caller's own that is simply offline all produce the same answer.
    """
    victim = Account(client, "victim@example.com")
    victim.register_device(VICTIM_LAPTOP)

    mallory = Account(client, "mallory@evil.com")
    mallory.register_device(MALLORY_BROWSER)
    mallory.register_device("mallory-offline-device")

    with victim.connect_signaling(VICTIM_LAPTOP):
        with mallory.connect_signaling(MALLORY_BROWSER) as mallory_ws:
            answers = []
            for target in (
                VICTIM_LAPTOP,  # exists, online, someone else's
                "local-server-00000000",  # does not exist at all
                "mallory-offline-device",  # hers, but not connected
            ):
                mallory_ws.send_json({"type": "offer", "target_device_id": target})
                answers.append(mallory_ws.receive_json())

    assert [answer["message"] for answer in answers] == [TARGET_UNAVAILABLE] * 3


def test_connect_request_between_own_devices_mints_a_session(
    client: TestClient,
) -> None:
    """The happy path: two devices of one user get a server-minted session."""
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_LAPTOP)
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_LAPTOP) as laptop_ws:
        with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
            browser_ws.send_json(
                {
                    "type": "connect-request",
                    "target_device_id": VICTIM_LAPTOP,
                    "preferred_transport": "relay",
                    # A client-supplied session id is ignored outright.
                    "relay_session_id": "client-chosen-and-guessable",
                }
            )
            sent = browser_ws.receive_json()
            received = laptop_ws.receive_json()

    assert sent["type"] == "connect-request-sent"
    assert received["type"] == "connect-request-received"
    assert received["from_device_id"] == VICTIM_BROWSER
    assert received["relay_url"] == settings.relay_url

    session_id = sent["relay_session_id"]
    assert session_id == received["relay_session_id"]
    assert session_id != "client-chosen-and-guessable"
    # Unguessable: 32 random bytes, URL-safe base64.
    assert len(session_id) >= 40

    browser_grant = jwt.decode(
        sent["relay_token"], settings.secret_key, algorithms=[settings.algorithm]
    )
    laptop_grant = jwt.decode(
        received["relay_token"], settings.secret_key, algorithms=[settings.algorithm]
    )

    assert browser_grant["scope"] == RELAY_GRANT_SCOPE
    assert browser_grant["sid"] == session_id
    assert browser_grant["device_id"] == VICTIM_BROWSER
    assert browser_grant["peer_device_id"] == VICTIM_LAPTOP
    assert laptop_grant["device_id"] == VICTIM_LAPTOP
    assert laptop_grant["peer_device_id"] == VICTIM_BROWSER
    assert browser_grant["user_id"] == laptop_grant["user_id"]
    assert browser_grant["jti"] != laptop_grant["jti"]
    assert "exp" in browser_grant


def test_no_grant_is_minted_when_the_target_is_offline(client: TestClient) -> None:
    """An undelivered request does not hand the caller a usable session."""
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_LAPTOP)
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
        browser_ws.send_json(
            {"type": "connect-request", "target_device_id": VICTIM_LAPTOP}
        )
        response = browser_ws.receive_json()

    assert response["type"] == "error"
    assert response["message"] == TARGET_UNAVAILABLE


def test_connect_request_to_self_is_refused(client: TestClient) -> None:
    """A device cannot open a relay session with itself."""
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
        browser_ws.send_json(
            {"type": "connect-request", "target_device_id": VICTIM_BROWSER}
        )
        response = browser_ws.receive_json()

    assert response["type"] == "error"
    assert "same device" in response["message"]


def test_own_device_routing_still_works(client: TestClient) -> None:
    """Ordinary WebRTC signaling between a user's own devices is unaffected."""
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_LAPTOP)
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_LAPTOP) as laptop_ws:
        with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
            browser_ws.send_json(
                {
                    "type": "offer",
                    "target_device_id": VICTIM_LAPTOP,
                    "payload": {"sdp": "v=0", "type": "offer"},
                }
            )
            ack = browser_ws.receive_json()
            forwarded = laptop_ws.receive_json()

    assert ack["type"] == "ack"
    assert forwarded["type"] == "offer"
    assert forwarded["sender_device_id"] == VICTIM_BROWSER
    assert forwarded["payload"]["sdp"] == "v=0"


def test_devices_registered_after_connecting_become_reachable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The owned-device cache refreshes, so a new device is not locked out.

    In production the refresh is rate limited to once every few seconds so a
    hostile client cannot force a database query per message; the interval is
    collapsed here rather than making the test sleep.
    """
    monkeypatch.setattr(OwnedDeviceCache, "REFRESH_INTERVAL_SECONDS", 0.0)

    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
        # Registered only after the socket was opened.
        alice.register_device(VICTIM_LAPTOP)
        with alice.connect_signaling(VICTIM_LAPTOP) as laptop_ws:
            browser_ws.send_json({"type": "offer", "target_device_id": VICTIM_LAPTOP})
            assert browser_ws.receive_json()["type"] == "ack"
            assert laptop_ws.receive_json()["type"] == "offer"


def test_owned_device_cache_is_not_requeried_per_message(
    client: TestClient,
) -> None:
    """A device added mid-session is not visible until the refresh interval.

    This is the cost control on the ownership check: a client that names
    unknown devices in a tight loop must not turn each message into a query.
    """
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
        alice.register_device(VICTIM_LAPTOP)
        with alice.connect_signaling(VICTIM_LAPTOP):
            browser_ws.send_json({"type": "offer", "target_device_id": VICTIM_LAPTOP})
            assert browser_ws.receive_json()["message"] == TARGET_UNAVAILABLE


def test_message_missing_target_is_rejected(client: TestClient) -> None:
    """A message with no target device id is answered with an error."""
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
        browser_ws.send_json({"type": "offer"})
        response = browser_ws.receive_json()

    assert response["type"] == "error"
    assert "target_device_id" in response["message"]


def test_m4_oversized_message_is_rejected_before_parsing(client: TestClient) -> None:
    """M4 regression: the 64 KB limit is enforced before json.loads runs.

    The payload below is deliberately not valid JSON, so a "message too large"
    answer proves the size check ran first.
    """
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
        browser_ws.send_text("{" + "x" * (MAX_MESSAGE_BYTES + 1))
        response = browser_ws.receive_json()

    assert response["type"] == "error"
    assert "exceeds" in response["message"]


def test_invalid_json_closes_the_connection(client: TestClient) -> None:
    """Unparseable frames end the connection instead of being answered forever."""
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
        browser_ws.send_text("not json")
        response = browser_ws.receive_json()

    assert response["type"] == "error"
    assert "Invalid JSON" in response["message"]


def test_non_object_message_is_rejected(client: TestClient) -> None:
    """A JSON array is not a signaling message."""
    alice = Account(client, "alice@example.com")
    alice.register_device(VICTIM_BROWSER)

    with alice.connect_signaling(VICTIM_BROWSER) as browser_ws:
        browser_ws.send_text("[1, 2, 3]")
        response = browser_ws.receive_json()

    assert response["type"] == "error"
    assert "JSON object" in response["message"]
