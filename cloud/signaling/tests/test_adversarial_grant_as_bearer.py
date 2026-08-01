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

"""Token-scope confusion: a relay grant must never work as an account token.

The adversarial review of PR #45 found that the session grant introduced to
fix C1/#15 was itself accepted as a full account bearer credential. A grant is
signed with the same HS256 key as an account token and carries the same
``user_id`` and ``exp``, and ``get_current_user_id`` checked nothing else. So a
single captured 120-second grant could:

1. ``POST /devices/challenge`` for an attacker-chosen device id  -> 200
2. ``POST /devices/register`` with the attacker's *own* ed25519 key -> 200

...permanently planting an attacker-controlled device on the victim's account.
The rogue device then passes ``OwnedDeviceCache.owns()`` forever, which reopens
the whole C1+C2 chain and outlives the grant's TTL entirely.

The precondition is capture, not forgery: before this branch the ``?token=``
query path wrote grants straight into uvicorn and nginx access logs.

The fix is positive scope validation - every consumer asserts the scope it
requires rather than checking that a wrong one is absent.
"""

import base64

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from app.core.crypto import REGISTER_CONTEXT, signed_message
from app.core.security import (
    ACCOUNT_TOKEN_SCOPE,
    create_relay_grant,
    decode_access_token,
    new_relay_session_id,
)
from tests.conftest import Account

VICTIM_LAPTOP = "local-server-victim-real"
VICTIM_BROWSER = "local-server-victim-secondary"
ROGUE_DEVICE = "attacker-planted-device"


def captured_grant(victim: Account) -> str:
    """Mint a grant exactly as the signaling server would, for the victim's devices.

    This stands in for a grant the attacker captured off the wire or out of an
    access log. It is a genuine grant, not a forgery: nothing here needs the
    signing key to be misused.

    Args:
        victim: The account whose devices the grant names.

    Returns:
        A real relay session grant for two of the victim's own devices.
    """
    user_id: int = decode_access_token(victim.token)["user_id"]
    return create_relay_grant(
        new_relay_session_id(), VICTIM_LAPTOP, VICTIM_BROWSER, user_id
    )


def test_relay_grant_cannot_be_used_as_an_account_bearer_token(
    client: TestClient,
) -> None:
    """The reviewer's exploit: plant a rogue device using only a captured grant.

    Before the fix both calls returned 200 and ``GET /devices/`` listed
    ``attacker-planted-device`` among the victim's own devices.
    """
    victim = Account(client, "victim@example.com")
    victim.register_device(VICTIM_LAPTOP)
    victim.register_device(VICTIM_BROWSER)

    grant = captured_grant(victim)
    grant_headers = {"Authorization": f"Bearer {grant}"}

    # Step 1 of the exploit: obtain a registration challenge as the victim.
    challenge_response = client.post(
        "/devices/challenge", json={"device_id": ROGUE_DEVICE}, headers=grant_headers
    )
    assert challenge_response.status_code == 401, challenge_response.text

    # Step 2: register the attacker's own key against the victim's account.
    # The attacker legitimately holds this private key, so proof-of-possession
    # would succeed - proving possession of a key says nothing about being the
    # account holder, which is exactly why the scope check has to do that job.
    attacker_key = Ed25519PrivateKey.generate()
    attacker_pubkey = base64.b64encode(
        attacker_key.public_key().public_bytes_raw()
    ).decode("ascii")
    forged_challenge = base64.b64encode(b"a" * 32).decode("ascii")
    signature = base64.b64encode(
        attacker_key.sign(
            signed_message(REGISTER_CONTEXT, ROGUE_DEVICE, forged_challenge)
        )
    ).decode("ascii")

    register_response = client.post(
        "/devices/register",
        json={
            "device_id": ROGUE_DEVICE,
            "pubkey": attacker_pubkey,
            "challenge": forged_challenge,
            "signature": signature,
        },
        headers=grant_headers,
    )
    assert register_response.status_code == 401, register_response.text

    # The payoff the exploit was after: the victim's device list is untouched.
    listed = client.get("/devices/", headers=victim.headers)
    assert listed.status_code == 200, listed.text
    device_ids = {device["id"] for device in listed.json()}
    assert device_ids == {VICTIM_LAPTOP, VICTIM_BROWSER}
    assert ROGUE_DEVICE not in device_ids


def test_relay_grant_cannot_list_the_victims_devices(client: TestClient) -> None:
    """A grant is not a read credential for the account either."""
    victim = Account(client, "victim-list@example.com")
    victim.register_device(VICTIM_LAPTOP)
    victim.register_device(VICTIM_BROWSER)

    response = client.get(
        "/devices/", headers={"Authorization": f"Bearer {captured_grant(victim)}"}
    )
    assert response.status_code == 401


def test_relay_grant_cannot_open_a_signaling_socket(client: TestClient) -> None:
    """A grant cannot stand in for the account token on the /signal handshake.

    ``verify_token_and_device`` shares ``decode_access_token`` with the HTTP
    dependency, so this pins the second call site the review named.
    """
    victim = Account(client, "victim-signal@example.com")
    victim.register_device(VICTIM_LAPTOP)
    victim.register_device(VICTIM_BROWSER)
    grant = captured_grant(victim)

    with client.websocket_connect("/signal") as websocket:
        websocket.send_json(
            {"type": "auth", "token": grant, "device_id": VICTIM_LAPTOP}
        )
        frame = websocket.receive_json()

    # Never a challenge frame: the socket is refused before proof of possession.
    assert frame["type"] == "error"
    assert frame["message"] == "Authentication failed"
    assert frame["reason"] == "auth-failed"


def test_account_tokens_are_stamped_with_the_account_scope(client: TestClient) -> None:
    """Both mint paths produce account-scoped tokens.

    Positive validation only works if the tokens that are supposed to pass
    actually carry the claim, so this pins the minting side of the contract.
    """
    account = Account(client, "scope-check@example.com")
    assert decode_access_token(account.token)["scope"] == ACCOUNT_TOKEN_SCOPE

    login = client.post(
        "/auth/login",
        json={"email": "scope-check@example.com", "password": "testpass123"},
    )
    assert login.status_code == 200, login.text
    assert decode_access_token(login.json()["access_token"])["scope"] == ACCOUNT_TOKEN_SCOPE
