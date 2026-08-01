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

"""Ed25519 proof-of-possession tests for registration and signaling connect.

C4: the README advertised "ed25519 public key authentication", but the stored
key was never used for anything. These tests pin the key to a real challenge
and response at both the points where a device asserts its identity.
"""

import base64
import contextlib

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.core.crypto import (
    REGISTER_CONTEXT,
    SIGNAL_CONTEXT,
    ChallengeStore,
    InvalidPublicKeyError,
    decode_public_key,
    new_challenge,
    signed_message,
    verify_signature,
)
from tests.conftest import Account, new_device_key

DEVICE_ID = "local-server-a1b2c3d4"


def challenge_for(account: Account, device_id: str) -> str:
    """Ask the server for a registration challenge.

    Args:
        account: Authenticated account.
        device_id: Device the challenge is for.

    Returns:
        The issued challenge string.
    """
    response = account.client.post(
        "/devices/challenge", json={"device_id": device_id}, headers=account.headers
    )
    assert response.status_code == 200
    return str(response.json()["challenge"])


def test_registration_requires_a_valid_signature(client: TestClient) -> None:
    """C4 regression: a public key cannot be registered without the private one."""
    account = Account(client, "alice@example.com")
    challenge = challenge_for(account, DEVICE_ID)

    # An attacker who knows the victim's public key still cannot register it.
    victim_key = new_device_key()
    attacker_key = new_device_key()

    response = client.post(
        "/devices/register",
        json={
            "device_id": DEVICE_ID,
            "pubkey": victim_key.pubkey_b64,
            "challenge": challenge,
            # Signed with the wrong private key.
            "signature": attacker_key.sign(REGISTER_CONTEXT, DEVICE_ID, challenge),
        },
        headers=account.headers,
    )
    assert response.status_code == 401


def test_registration_rejects_a_non_ed25519_public_key(client: TestClient) -> None:
    """The literal placeholder keys the clients used to send are refused."""
    account = Account(client, "alice@example.com")
    challenge = challenge_for(account, DEVICE_ID)

    response = client.post(
        "/devices/register",
        json={
            "device_id": DEVICE_ID,
            "pubkey": "browser-key",
            "challenge": challenge,
            "signature": "AAAA",
        },
        headers=account.headers,
    )
    assert response.status_code == 422
    assert "Invalid public key" in response.json()["detail"]


def test_a_challenge_can_only_be_redeemed_once(client: TestClient) -> None:
    """Replaying a captured challenge and signature does not work twice."""
    account = Account(client, "alice@example.com")
    challenge = challenge_for(account, DEVICE_ID)
    key = new_device_key()
    body = {
        "device_id": DEVICE_ID,
        "pubkey": key.pubkey_b64,
        "challenge": challenge,
        "signature": key.sign(REGISTER_CONTEXT, DEVICE_ID, challenge),
    }

    assert client.post("/devices/register", json=body, headers=account.headers).status_code == 200
    replay = client.post("/devices/register", json=body, headers=account.headers)
    assert replay.status_code == 401


def test_a_failed_attempt_burns_the_challenge(client: TestClient) -> None:
    """A wrong signature consumes the nonce, so it cannot be retried."""
    account = Account(client, "alice@example.com")
    challenge = challenge_for(account, DEVICE_ID)
    key = new_device_key()

    bad = client.post(
        "/devices/register",
        json={
            "device_id": DEVICE_ID,
            "pubkey": key.pubkey_b64,
            "challenge": challenge,
            "signature": base64.b64encode(b"\x00" * 64).decode("ascii"),
        },
        headers=account.headers,
    )
    assert bad.status_code == 401

    retry = client.post(
        "/devices/register",
        json={
            "device_id": DEVICE_ID,
            "pubkey": key.pubkey_b64,
            "challenge": challenge,
            "signature": key.sign(REGISTER_CONTEXT, DEVICE_ID, challenge),
        },
        headers=account.headers,
    )
    assert retry.status_code == 401


def test_another_users_challenge_cannot_be_used(client: TestClient) -> None:
    """Challenges are scoped to the account that asked for them."""
    alice = Account(client, "alice@example.com")
    mallory = Account(client, "mallory@evil.com")
    challenge = challenge_for(alice, DEVICE_ID)
    key = new_device_key()

    response = client.post(
        "/devices/register",
        json={
            "device_id": DEVICE_ID,
            "pubkey": key.pubkey_b64,
            "challenge": challenge,
            "signature": key.sign(REGISTER_CONTEXT, DEVICE_ID, challenge),
        },
        headers=mallory.headers,
    )
    assert response.status_code == 401


def test_signaling_connect_requires_the_device_key(client: TestClient) -> None:
    """C4 regression: a stolen account token alone cannot open a device socket."""
    alice = Account(client, "alice@example.com")
    alice.register_device(DEVICE_ID)

    # Mallory has stolen alice's token but not her device private key.
    impostor_key = new_device_key()

    with client.websocket_connect("/signal") as websocket:
        websocket.send_json({"type": "auth", "token": alice.token, "device_id": DEVICE_ID})
        challenge_frame = websocket.receive_json()
        assert challenge_frame["type"] == "challenge"
        assert challenge_frame["context"] == SIGNAL_CONTEXT.decode("ascii")

        websocket.send_json(
            {
                "type": "auth-response",
                "signature": impostor_key.sign(
                    SIGNAL_CONTEXT, DEVICE_ID, challenge_frame["challenge"]
                ),
            }
        )
        error = websocket.receive_json()

    assert error["type"] == "error"
    assert error["message"] == "Device key verification failed"


def test_signaling_challenge_is_not_reusable_across_connections(
    client: TestClient,
) -> None:
    """Each connection gets its own challenge, so a captured one is useless."""
    alice = Account(client, "alice@example.com")
    key = alice.register_device(DEVICE_ID)

    with client.websocket_connect("/signal") as first:
        first.send_json({"type": "auth", "token": alice.token, "device_id": DEVICE_ID})
        captured = first.receive_json()["challenge"]

    with client.websocket_connect("/signal") as second:
        second.send_json({"type": "auth", "token": alice.token, "device_id": DEVICE_ID})
        fresh = second.receive_json()["challenge"]
        assert fresh != captured

        # Signing the captured challenge does not satisfy the fresh one.
        second.send_json(
            {
                "type": "auth-response",
                "signature": key.sign(SIGNAL_CONTEXT, DEVICE_ID, captured),
            }
        )
        assert second.receive_json()["message"] == "Device key verification failed"


def test_signaling_rejects_a_device_owned_by_another_user(client: TestClient) -> None:
    """A token cannot be used to connect as somebody else's device."""
    alice = Account(client, "alice@example.com")
    alice.register_device(DEVICE_ID)
    mallory = Account(client, "mallory@evil.com")

    with client.websocket_connect("/signal") as websocket:
        websocket.send_json({"type": "auth", "token": mallory.token, "device_id": DEVICE_ID})
        error = websocket.receive_json()

    assert error["message"] == "Authentication failed"


def test_signaling_rejects_a_missing_auth_message(client: TestClient) -> None:
    """A first frame that is not an auth message closes the socket."""
    with client.websocket_connect("/signal") as websocket:
        websocket.send_json({"type": "hello"})
        error = websocket.receive_json()

    assert error["message"] == "First message must be auth message"


def test_signaling_rejects_an_auth_message_without_credentials(
    client: TestClient,
) -> None:
    """An auth message must carry both a token and a device id."""
    with client.websocket_connect("/signal") as websocket:
        websocket.send_json({"type": "auth", "token": "x"})
        error = websocket.receive_json()

    assert error["message"] == "Auth message missing token or device_id"


def test_signaling_rejects_a_wrong_challenge_response_type(client: TestClient) -> None:
    """The frame after the challenge must be an auth-response."""
    alice = Account(client, "alice@example.com")
    alice.register_device(DEVICE_ID)

    with client.websocket_connect("/signal") as websocket:
        websocket.send_json({"type": "auth", "token": alice.token, "device_id": DEVICE_ID})
        websocket.receive_json()
        websocket.send_json({"type": "offer", "target_device_id": DEVICE_ID})
        error = websocket.receive_json()

    assert error["message"] == "Expected auth-response message"


def test_reconnect_does_not_deregister_the_new_connection(client: TestClient) -> None:
    """M1 regression: the replaced handler's cleanup must not evict its successor.

    Without the identity check in ConnectionManager.disconnect, the old
    handler's finally block deleted the entry the new connection had just
    installed, and the device silently stopped receiving messages.
    """
    alice = Account(client, "alice@example.com")
    alice.register_device(DEVICE_ID)
    alice.register_device("browser-alice")

    first = alice.connect_signaling(DEVICE_ID)
    old_socket = first.__enter__()
    try:
        second = alice.connect_signaling(DEVICE_ID)
        new_socket = second.__enter__()
        try:
            # Wait for the server to actually close the replaced socket, which
            # is what triggers the old handler's cleanup.
            with pytest.raises(WebSocketDisconnect):
                while True:
                    old_socket.receive_json()

            # The surviving connection is still registered and routable.
            with alice.connect_signaling("browser-alice") as browser:
                browser.send_json({"type": "offer", "target_device_id": DEVICE_ID})
                assert browser.receive_json()["type"] == "ack"
                assert new_socket.receive_json()["type"] == "offer"
        finally:
            second.__exit__(None, None, None)
    finally:
        with contextlib.suppress(Exception):
            first.__exit__(None, None, None)


def test_decode_public_key_rejects_bad_input() -> None:
    """Malformed public keys raise rather than being stored blindly."""
    with pytest.raises(InvalidPublicKeyError):
        decode_public_key("!!!not base64!!!")
    with pytest.raises(InvalidPublicKeyError):
        decode_public_key(base64.b64encode(b"too short").decode("ascii"))


def test_verify_signature_is_domain_separated() -> None:
    """A signature made for registration does not verify for signaling."""
    key = new_device_key()
    challenge = "Y2hhbGxlbmdl"
    signature = key.sign(REGISTER_CONTEXT, DEVICE_ID, challenge)

    assert verify_signature(
        key.pubkey_b64, signature, signed_message(REGISTER_CONTEXT, DEVICE_ID, challenge)
    )
    assert not verify_signature(
        key.pubkey_b64, signature, signed_message(SIGNAL_CONTEXT, DEVICE_ID, challenge)
    )
    # Nor for a different device id or a different challenge.
    assert not verify_signature(
        key.pubkey_b64, signature, signed_message(REGISTER_CONTEXT, "other-device", challenge)
    )
    assert not verify_signature(
        key.pubkey_b64, signature, signed_message(REGISTER_CONTEXT, DEVICE_ID, "b3RoZXI=")
    )


def test_signed_message_is_unambiguous_for_fixed_length_fields() -> None:
    """Two device ids cannot produce the same payload for real challenges.

    The fields after ``device_id`` are base64 of a fixed 32 bytes, so they are
    44 characters and contain no ``:``. Equal payload lengths therefore force
    equal device id lengths, which forces the ids to be equal. This test pins
    that invariant, because it is the only thing making the separator safe.
    """
    challenge_a = new_challenge()
    challenge_b = new_challenge()
    assert len(challenge_a) == 44 and ":" not in challenge_a

    # A device id containing a colon still cannot impersonate another device,
    # because doing so would need a shorter-than-44-character challenge.
    assert signed_message(REGISTER_CONTEXT, "device:a", challenge_a) != signed_message(
        REGISTER_CONTEXT, "device", f"a:{challenge_b}"[:44]
    )


def test_verify_signature_rejects_malformed_input() -> None:
    """Garbage keys and signatures are refused without raising."""
    key = new_device_key()
    message = signed_message(REGISTER_CONTEXT, "d", "c")
    assert not verify_signature("not-base64!", "s", message)
    assert not verify_signature(key.pubkey_b64, "!!", message)
    assert not verify_signature(key.pubkey_b64, base64.b64encode(b"short").decode(), message)


def test_challenge_store_expires_entries() -> None:
    """An expired challenge cannot be redeemed."""
    store = ChallengeStore(ttl_seconds=0)
    challenge = store.issue("key")
    assert not store.redeem("key", challenge)


def test_challenge_store_rejects_unknown_keys() -> None:
    """Redeeming requires the exact subject key."""
    store = ChallengeStore(ttl_seconds=60)
    challenge = store.issue("key")
    assert not store.redeem("other-key", challenge)
    assert store.redeem("key", challenge)


def test_challenge_store_burns_the_nonce_on_a_wrong_answer() -> None:
    """A mismatched answer consumes the challenge, so it cannot be guessed at."""
    store = ChallengeStore(ttl_seconds=60)
    challenge = store.issue("key")
    assert not store.redeem("key", "wrong-challenge")
    assert not store.redeem("key", challenge)
