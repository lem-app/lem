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

"""The local server proves possession of its device key when it enrols.

Before this, ``/auth/login`` and ``/auth/register`` posted a bare
``{device_id, pubkey}`` to the signaling server, which stored the key and never
asked anyone to prove they held the matching private half.
``load_keypair_from_b64`` had zero call sites; nothing was ever signed.

These tests drive :func:`enrol_device_with_signaling` against a fake signaling
server and verify the signature it produces the way the real server does -
against the public key being registered, over the pinned payload.
"""

import base64
from collections.abc import Iterator
from pathlib import Path
from types import TracebackType
from typing import Self

import pytest
from cryptography.exceptions import InvalidSignature
from fastapi import HTTPException

from app import db as app_db
from app.api.v1.auth import enrol_device_with_signaling, local_device_identity
from app.crypto import REGISTER_CONTEXT, public_key_from_b64, signed_message

SIGNALING_URL = "https://signaling.example.test"
JWT = "test-jwt-token"
CHALLENGE = "Q0hBTExFTkdFLTAxMjM0NTY3ODlhYmNkZWZnaGlqa2w="


@pytest.fixture
def device_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A throwaway SQLite database, so the suite never touches ~/.lem.

    Args:
        tmp_path: Per-test temporary directory.
        monkeypatch: pytest patcher.

    Yields:
        Path to the temporary database.
    """
    db_path = tmp_path / "lem.db"
    monkeypatch.setattr(app_db, "LEM_HOME", tmp_path)
    monkeypatch.setattr(app_db, "DB_PATH", db_path)
    app_db.init_db()
    yield db_path


class FakeResponse:
    """Minimal stand-in for an aiohttp response used as a context manager."""

    def __init__(self, status: int, payload: dict[str, str], text: str = "") -> None:
        """
        Args:
            status: HTTP status to report.
            payload: JSON body to return.
            text: Raw body text, for error paths.
        """
        self.status = status
        self._payload = payload
        self._text = text

    async def __aenter__(self) -> Self:
        """Enter the context.

        Returns:
            This response.
        """
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        """Exit the context.

        Args:
            exc_type: Exception type, if any.
            exc: Exception instance, if any.
            tb: Traceback, if any.
        """

    async def json(self) -> dict[str, str]:
        """Return the JSON body.

        Returns:
            The payload.
        """
        return self._payload

    async def text(self) -> str:
        """Return the raw body.

        Returns:
            The body text.
        """
        return self._text


class FakeSignalingSession:
    """A fake signaling server that records what the client posted to it."""

    def __init__(self, register_status: int = 200, register_body: str = "") -> None:
        """
        Args:
            register_status: Status to answer /devices/register with.
            register_body: Raw body to answer /devices/register with.
        """
        self.register_status = register_status
        self.register_body = register_body
        self.challenge_requests: list[dict[str, str]] = []
        self.registrations: list[dict[str, str]] = []

    def post(self, url: str, headers: dict[str, str], json: dict[str, str]) -> FakeResponse:
        """Handle a POST the way the signaling server would.

        Args:
            url: Target URL.
            headers: Request headers.
            json: Request body.

        Returns:
            The canned response.
        """
        assert headers["Authorization"] == f"Bearer {JWT}"
        if url.endswith("/devices/challenge"):
            self.challenge_requests.append(json)
            return FakeResponse(200, {"challenge": CHALLENGE})
        if url.endswith("/devices/register"):
            self.registrations.append(json)
            return FakeResponse(self.register_status, {}, self.register_body)
        raise AssertionError(f"unexpected POST to {url}")


def verify_registration(registration: dict[str, str]) -> bool:
    """Verify a registration the way the signaling server does.

    Args:
        registration: The body posted to /devices/register.

    Returns:
        True if the signature is valid for the registered key and payload.
    """
    public_key = public_key_from_b64(registration["pubkey"])
    message = signed_message(REGISTER_CONTEXT, registration["device_id"], registration["challenge"])
    try:
        public_key.verify(base64.b64decode(registration["signature"]), message)
    except InvalidSignature:
        return False
    return True


@pytest.mark.asyncio
async def test_enrolment_signs_the_challenge_with_the_device_key(device_db: Path) -> None:
    """The posted signature verifies against the posted public key."""
    session = FakeSignalingSession()

    device_id = await enrol_device_with_signaling(session, SIGNALING_URL, JWT)  # type: ignore[arg-type]

    assert session.challenge_requests == [{"device_id": device_id}]
    assert len(session.registrations) == 1
    registration = session.registrations[0]
    assert registration["device_id"] == device_id
    assert registration["challenge"] == CHALLENGE
    assert registration["pubkey"] != "browser-key"
    assert len(base64.b64decode(registration["pubkey"])) == 32
    assert verify_registration(registration)


@pytest.mark.asyncio
async def test_the_signature_is_bound_to_this_device_id(device_db: Path) -> None:
    """The same signature presented for another device does not verify."""
    session = FakeSignalingSession()
    await enrol_device_with_signaling(session, SIGNALING_URL, JWT)  # type: ignore[arg-type]

    registration = dict(session.registrations[0])
    registration["device_id"] = "local-server-deadbeef"
    assert not verify_registration(registration)


@pytest.mark.asyncio
async def test_the_signature_is_bound_to_this_challenge(device_db: Path) -> None:
    """Tampering with the challenge invalidates the signature."""
    session = FakeSignalingSession()
    await enrol_device_with_signaling(session, SIGNALING_URL, JWT)  # type: ignore[arg-type]

    registration = dict(session.registrations[0])
    registration["challenge"] = "dGFtcGVyZWQtY2hhbGxlbmdlLXZhbHVlLXBhZGRpbmc="
    assert not verify_registration(registration)


@pytest.mark.asyncio
async def test_enrolment_reuses_the_stored_keypair(device_db: Path) -> None:
    """A second enrolment presents the same device id and key, not a new one."""
    first = FakeSignalingSession()
    device_id = await enrol_device_with_signaling(first, SIGNALING_URL, JWT)  # type: ignore[arg-type]

    second = FakeSignalingSession()
    again = await enrol_device_with_signaling(second, SIGNALING_URL, JWT)  # type: ignore[arg-type]

    assert again == device_id
    assert second.registrations[0]["pubkey"] == first.registrations[0]["pubkey"]
    # Fresh challenge each time, so the second proof is not a replay.
    assert verify_registration(second.registrations[0])


@pytest.mark.asyncio
async def test_a_rejected_key_fails_loudly(device_db: Path) -> None:
    """A 401 from signaling surfaces as an actionable error, not a silent pass.

    This is the path a device hits when the signaling server has a different
    key on file for its id and it cannot prove possession of that key.
    """
    session = FakeSignalingSession(register_status=401, register_body="previous_signature required")

    with pytest.raises(HTTPException) as excinfo:
        await enrol_device_with_signaling(session, SIGNALING_URL, JWT)  # type: ignore[arg-type]

    assert excinfo.value.status_code == 401
    assert "different key" in excinfo.value.detail


def test_a_device_without_a_private_key_gets_a_new_identity(device_db: Path) -> None:
    """An unprovable identity is replaced rather than reused.

    A stored device with no private key cannot sign a challenge and cannot
    authorize replacing the key on file, so there is nothing to recover.
    """
    app_db.register_device(device_id="local-server-orphan", pubkey="stale", privkey=None)

    device_id, pubkey, privkey = local_device_identity()

    assert device_id != "local-server-orphan"
    assert len(base64.b64decode(pubkey)) == 32
    assert len(base64.b64decode(privkey)) == 32
