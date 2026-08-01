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

"""The tunnel agent proves possession of its device key at /signal.

The agent sent ``auth`` and then waited for ``connected``, which never came:
the signaling server answers ``auth`` with a challenge and closes the socket
when it goes unanswered. ``_process_signaling_message`` had no ``challenge``
branch at all, so the local server could not open a signaling connection.

These tests drive the challenge frame through the agent and verify the
signature the way the signaling server does.
"""

import base64
from collections.abc import Iterator
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from cryptography.exceptions import InvalidSignature

from app import db as app_db
from app.crypto import (
    REGISTER_CONTEXT,
    SIGNAL_CONTEXT,
    generate_keypair,
    public_key_from_b64,
    signed_message,
)
from app.tunnel.peer_auth import AllowAllVerifier
from app.tunnel.webrtc_client import ConnectionState, TunnelAgent

OWN_DEVICE = "local-server-a1b2c3d4"
CHALLENGE = "Q0hBTExFTkdFLTAxMjM0NTY3ODlhYmNkZWZnaGlqa2w="


@pytest.fixture
def device_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    """A throwaway database holding one device keypair.

    Never touches ~/.lem: LEM_HOME and DB_PATH are redirected first.

    Args:
        tmp_path: Per-test temporary directory.
        monkeypatch: pytest patcher.

    Yields:
        The device's base64 public key.
    """
    monkeypatch.setattr(app_db, "LEM_HOME", tmp_path)
    monkeypatch.setattr(app_db, "DB_PATH", tmp_path / "lem.db")
    app_db.init_db()

    keypair = generate_keypair()
    app_db.register_device(
        device_id=OWN_DEVICE,
        pubkey=keypair.public_key_b64,
        privkey=keypair.private_key_b64,
    )
    yield keypair.public_key_b64


def verify(pubkey_b64: str, signature_b64: str, message: bytes) -> bool:
    """Verify a signature the way the signaling server does.

    Args:
        pubkey_b64: Base64 public key on file for the device.
        signature_b64: Base64 signature the agent produced.
        message: Expected signed payload.

    Returns:
        True if the signature is valid.
    """
    try:
        public_key_from_b64(pubkey_b64).verify(base64.b64decode(signature_b64), message)
    except InvalidSignature:
        return False
    return True


async def connected_agent() -> TunnelAgent:
    """Build an agent wired up as if it had just sent its auth message.

    Returns:
        A TunnelAgent with connection parameters set.
    """
    agent = TunnelAgent(peer_verifier=AllowAllVerifier())
    with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
        with patch.object(agent, "_connect_signaling", new=AsyncMock()):
            await agent.connect(
                signal_url="ws://localhost:8000/signal",
                device_id=OWN_DEVICE,
                token="test-token",
            )
    return agent


async def test_challenge_is_answered_with_a_verifiable_signature(device_db: str) -> None:
    """The agent signs the challenge with the key registered for this device."""
    agent = await connected_agent()

    with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
        await agent._process_signaling_message(
            {
                "type": "challenge",
                "device_id": OWN_DEVICE,
                "challenge": CHALLENGE,
                "context": SIGNAL_CONTEXT.decode("ascii"),
            }
        )

    assert send.call_count == 1, "the challenge went unanswered"
    response = send.call_args.args[0]
    assert response["type"] == "auth-response"
    assert verify(
        device_db, response["signature"], signed_message(SIGNAL_CONTEXT, OWN_DEVICE, CHALLENGE)
    )


async def test_the_signature_is_bound_to_the_signal_context(device_db: str) -> None:
    """A connect proof does not verify as a registration proof, or vice versa."""
    agent = await connected_agent()

    with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
        await agent._process_signaling_message(
            {"type": "challenge", "device_id": OWN_DEVICE, "challenge": CHALLENGE}
        )

    signature = send.call_args.args[0]["signature"]
    assert not verify(device_db, signature, signed_message(REGISTER_CONTEXT, OWN_DEVICE, CHALLENGE))


async def test_the_signature_is_bound_to_this_device(device_db: str) -> None:
    """A proof for this device does not verify for another one."""
    agent = await connected_agent()

    with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
        await agent._process_signaling_message(
            {"type": "challenge", "device_id": OWN_DEVICE, "challenge": CHALLENGE}
        )

    signature = send.call_args.args[0]["signature"]
    assert not verify(
        device_db, signature, signed_message(SIGNAL_CONTEXT, "local-server-deadbeef", CHALLENGE)
    )


async def test_a_tampered_challenge_does_not_verify(device_db: str) -> None:
    """The signature covers the challenge, so altering it invalidates the proof."""
    agent = await connected_agent()

    with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
        await agent._process_signaling_message(
            {"type": "challenge", "device_id": OWN_DEVICE, "challenge": CHALLENGE}
        )

    signature = send.call_args.args[0]["signature"]
    assert not verify(
        device_db,
        signature,
        signed_message(SIGNAL_CONTEXT, OWN_DEVICE, "dGFtcGVyZWQtY2hhbGxlbmdlLXZhbHVlLXBhZA=="),
    )


async def test_each_challenge_gets_its_own_signature(device_db: str) -> None:
    """A second connection signs the new nonce, not a cached answer."""
    agent = await connected_agent()
    second_challenge = "U0VDT05ELUNIQUxMRU5HRS0wMTIzNDU2Nzg5YWJjZGU="

    with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
        await agent._process_signaling_message(
            {"type": "challenge", "device_id": OWN_DEVICE, "challenge": CHALLENGE}
        )
        await agent._process_signaling_message(
            {"type": "challenge", "device_id": OWN_DEVICE, "challenge": second_challenge}
        )

    first, second = (call.args[0]["signature"] for call in send.call_args_list)
    assert first != second
    assert verify(device_db, second, signed_message(SIGNAL_CONTEXT, OWN_DEVICE, second_challenge))


async def test_a_device_with_no_private_key_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No key, no connection - never an unsigned "connected" state."""
    monkeypatch.setattr(app_db, "LEM_HOME", tmp_path)
    monkeypatch.setattr(app_db, "DB_PATH", tmp_path / "lem.db")
    app_db.init_db()
    app_db.register_device(device_id=OWN_DEVICE, pubkey="stale", privkey=None)

    agent = await connected_agent()
    agent.ws = None

    with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
        await agent._process_signaling_message(
            {"type": "challenge", "device_id": OWN_DEVICE, "challenge": CHALLENGE}
        )

    assert send.call_count == 0
    assert agent.state == ConnectionState.FAILED
    # Reconnecting would loop on the same missing key.
    assert agent.should_reconnect is False


async def test_a_malformed_challenge_frame_fails_closed(device_db: str) -> None:
    """A challenge frame with no challenge is refused, not signed blindly."""
    agent = await connected_agent()
    agent.ws = None

    with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
        await agent._process_signaling_message({"type": "challenge", "device_id": OWN_DEVICE})

    assert send.call_count == 0
    assert agent.state == ConnectionState.FAILED
