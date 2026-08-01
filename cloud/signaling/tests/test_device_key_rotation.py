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

"""Trust on first use, and what it takes to replace a pinned device key.

Registration was an idempotent UPSERT that wrote ``excluded.pubkey``
unconditionally. Adding proof of possession of the *offered* key did not fix
that on its own: an attacker holding the account JWT generates the offered key
themselves, so signing with it proves nothing about the device being replaced.
They could overwrite any of the account's devices with their own key and then
satisfy every downstream device check, which is the check the tunnel is being
built to rely on.

The boundary these tests pin: the first registration of a device id is trusted
and establishes the key; every later change of that key has to be signed by the
key already on file.
"""

import pytest
from fastapi.testclient import TestClient

from app.api import devices as devices_api
from app.core.crypto import REGISTER_CONTEXT, ROTATE_CONTEXT, ChallengeStore
from tests.conftest import Account, DeviceKey, new_device_key

DEVICE_ID = "local-server-a1b2c3d4"


def register_body(
    key: DeviceKey,
    device_id: str,
    challenge: str,
    previous_signature: str | None = None,
) -> dict[str, str | None]:
    """Build a /devices/register body.

    Args:
        key: Key being registered.
        device_id: Device identifier.
        challenge: Challenge issued for this device.
        previous_signature: Optional rotation proof by the key on file.

    Returns:
        The JSON body to post.
    """
    body: dict[str, str | None] = {
        "device_id": device_id,
        "pubkey": key.pubkey_b64,
        "challenge": challenge,
        "signature": key.sign(REGISTER_CONTEXT, device_id, challenge),
    }
    if previous_signature is not None:
        body["previous_signature"] = previous_signature
    return body


def stored_pubkey(account: Account, device_id: str) -> str:
    """Read back the key the server has on file for a device.

    Args:
        account: Owning account.
        device_id: Device to look up.

    Returns:
        The stored base64 public key.
    """
    response = account.client.get("/devices/", headers=account.headers)
    assert response.status_code == 200, response.text
    for device in response.json():
        if device["id"] == device_id:
            return str(device["pubkey"])
    raise AssertionError(f"{device_id} is not registered")


def test_first_registration_establishes_the_key(client: TestClient) -> None:
    """Trust on first use: an unknown device id pins whatever key it proves."""
    account = Account(client, "alice@example.com")
    key = new_device_key()
    challenge = account.challenge_for(DEVICE_ID)

    response = client.post(
        "/devices/register",
        json=register_body(key, DEVICE_ID, challenge),
        headers=account.headers,
    )
    assert response.status_code == 200, response.text
    assert stored_pubkey(account, DEVICE_ID) == key.pubkey_b64


def test_reregistering_the_same_key_still_works(client: TestClient) -> None:
    """Reconnect and re-enrol must stay idempotent for an unchanged key."""
    account = Account(client, "alice@example.com")
    key = account.register_device(DEVICE_ID)

    challenge = account.challenge_for(DEVICE_ID)
    response = client.post(
        "/devices/register",
        json=register_body(key, DEVICE_ID, challenge),
        headers=account.headers,
    )
    assert response.status_code == 200, response.text
    assert stored_pubkey(account, DEVICE_ID) == key.pubkey_b64


def test_a_different_key_cannot_silently_replace_the_stored_one(client: TestClient) -> None:
    """The headline regression: the JWT alone must not repoint a device.

    Mallory holds a valid account token - the exact situation #15 and #16 put
    an attacker in - and offers a key she genuinely owns. Before the pin, this
    returned 200 and every later device check happily authenticated her.
    """
    account = Account(client, "alice@example.com")
    original = account.register_device(DEVICE_ID)

    attacker_key = new_device_key()
    challenge = account.challenge_for(DEVICE_ID)
    response = client.post(
        "/devices/register",
        json=register_body(attacker_key, DEVICE_ID, challenge),
        headers=account.headers,
    )

    assert response.status_code == 401
    assert "previous_signature" in response.json()["detail"]
    assert stored_pubkey(account, DEVICE_ID) == original.pubkey_b64


def test_rotation_succeeds_with_proof_of_the_stored_key(client: TestClient) -> None:
    """A device that still holds its old key may replace it."""
    account = Account(client, "alice@example.com")
    old_key = account.register_device(DEVICE_ID)
    new_key = new_device_key()

    challenge = account.challenge_for(DEVICE_ID)
    response = client.post(
        "/devices/register",
        json=register_body(
            new_key,
            DEVICE_ID,
            challenge,
            previous_signature=old_key.sign(
                ROTATE_CONTEXT, DEVICE_ID, challenge, new_key.pubkey_b64
            ),
        ),
        headers=account.headers,
    )

    assert response.status_code == 200, response.text
    assert stored_pubkey(account, DEVICE_ID) == new_key.pubkey_b64


def test_rotation_proof_must_come_from_the_stored_key(client: TestClient) -> None:
    """Any key other than the one on file is not authorization to replace it."""
    account = Account(client, "alice@example.com")
    original = account.register_device(DEVICE_ID)
    attacker_key = new_device_key()

    challenge = account.challenge_for(DEVICE_ID)
    response = client.post(
        "/devices/register",
        json=register_body(
            attacker_key,
            DEVICE_ID,
            challenge,
            # Signed by the key being installed, not the one on file.
            previous_signature=attacker_key.sign(
                ROTATE_CONTEXT, DEVICE_ID, challenge, attacker_key.pubkey_b64
            ),
        ),
        headers=account.headers,
    )

    assert response.status_code == 401
    assert stored_pubkey(account, DEVICE_ID) == original.pubkey_b64


def test_rotation_proof_is_bound_to_the_replacement_key(client: TestClient) -> None:
    """The old key authorizes one specific new key, not rotation in general.

    A rotation proof lifted from a legitimate rotation cannot be re-aimed at a
    different replacement key, because the new pubkey is inside the signed
    payload.
    """
    account = Account(client, "alice@example.com")
    old_key = account.register_device(DEVICE_ID)
    intended_key = new_device_key()
    attacker_key = new_device_key()

    challenge = account.challenge_for(DEVICE_ID)
    response = client.post(
        "/devices/register",
        json=register_body(
            attacker_key,
            DEVICE_ID,
            challenge,
            # A genuine proof by the stored key - but for a different new key.
            previous_signature=old_key.sign(
                ROTATE_CONTEXT, DEVICE_ID, challenge, intended_key.pubkey_b64
            ),
        ),
        headers=account.headers,
    )

    assert response.status_code == 401
    assert stored_pubkey(account, DEVICE_ID) == old_key.pubkey_b64


def test_a_registration_proof_is_not_a_rotation_proof(client: TestClient) -> None:
    """Domain separation: REGISTER and ROTATE signatures are not interchangeable."""
    account = Account(client, "alice@example.com")
    old_key = account.register_device(DEVICE_ID)
    new_key = new_device_key()

    challenge = account.challenge_for(DEVICE_ID)
    response = client.post(
        "/devices/register",
        json=register_body(
            new_key,
            DEVICE_ID,
            challenge,
            # Signed by the right key, over the wrong context.
            previous_signature=old_key.sign(REGISTER_CONTEXT, DEVICE_ID, challenge),
        ),
        headers=account.headers,
    )

    assert response.status_code == 401
    assert stored_pubkey(account, DEVICE_ID) == old_key.pubkey_b64


def test_a_signature_for_one_device_is_rejected_for_another(client: TestClient) -> None:
    """The device id is inside the signed payload, so proofs do not travel."""
    account = Account(client, "alice@example.com")
    key = new_device_key()
    other_device = "local-server-99999999"

    challenge = account.challenge_for(DEVICE_ID)
    response = client.post(
        "/devices/register",
        json={
            "device_id": DEVICE_ID,
            "pubkey": key.pubkey_b64,
            "challenge": challenge,
            # A perfectly valid signature - for a different device.
            "signature": key.sign(REGISTER_CONTEXT, other_device, challenge),
        },
        headers=account.headers,
    )
    assert response.status_code == 401


def test_an_expired_challenge_is_rejected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A challenge past its TTL cannot be redeemed, even with a valid signature."""
    monkeypatch.setattr(devices_api, "registration_challenges", ChallengeStore(ttl_seconds=0))
    account = Account(client, "alice@example.com")
    key = new_device_key()

    challenge = account.challenge_for(DEVICE_ID)
    response = client.post(
        "/devices/register",
        json=register_body(key, DEVICE_ID, challenge),
        headers=account.headers,
    )
    assert response.status_code == 401
