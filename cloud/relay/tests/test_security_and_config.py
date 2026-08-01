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

"""Unit tests for grant verification, fail-closed settings and health output."""

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.core.config import Settings
from app.core.security import InvalidGrantError, SessionGrant, decode_session_grant
from app.core.session_manager import JoinRejectedError, RelaySession
from tests.conftest import TEST_SECRET_KEY, encode, make_grant

GOOD_KEY = "a-perfectly-adequate-secret-key-0123456789"


def settings_with(**overrides: str) -> Settings:
    """Build a Settings instance from explicit values only.

    Args:
        **overrides: Field values to use.

    Returns:
        The constructed settings object.
    """
    values: dict[str, str] = {
        "secret_key": GOOD_KEY,
        "cors_origins": "https://app.lem.gg",
    }
    values.update(overrides)
    # _env_file=None keeps a developer's local .env out of the test.
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


def test_settings_reject_missing_secret_key() -> None:
    """H1 regression: the server refuses to start without a secret key."""
    with pytest.raises(ValidationError, match="SECRET_KEY is required"):
        settings_with(secret_key="")


def test_settings_reject_the_published_example_key() -> None:
    """H1 regression: the key printed in this repository is refused outright."""
    with pytest.raises(ValidationError, match="example values"):
        settings_with(secret_key="dev-secret-key-change-in-production")


def test_settings_reject_a_short_secret_key() -> None:
    """A too-short key is refused rather than silently accepted."""
    with pytest.raises(ValidationError, match="at least 32 characters"):
        settings_with(secret_key="short")


def test_settings_reject_wildcard_cors() -> None:
    """H2 regression: credentialed CORS may not be a wildcard."""
    with pytest.raises(ValidationError, match="must not contain"):
        settings_with(cors_origins="*")


def test_settings_reject_empty_cors() -> None:
    """H2 regression: an explicit origin list is mandatory."""
    with pytest.raises(ValidationError, match="CORS_ORIGINS is required"):
        settings_with(cors_origins="")


def test_settings_parse_an_origin_list() -> None:
    """Whitespace around configured origins is tolerated."""
    parsed = settings_with(cors_origins="https://a.example, https://b.example")
    assert parsed.cors_allowed_origins == ["https://a.example", "https://b.example"]


def test_decode_rejects_a_token_signed_with_another_key() -> None:
    """A grant signed with the wrong key does not verify."""
    from jose import jwt

    forged = jwt.encode(
        {
            "scope": "relay-session",
            "sid": "s",
            "device_id": "a",
            "peer_device_id": "b",
            "user_id": 1,
            "jti": "j",
            "exp": 9999999999,
        },
        "a-completely-different-key-0123456789",
        algorithm="HS256",
    )
    assert forged != TEST_SECRET_KEY
    with pytest.raises(InvalidGrantError):
        decode_session_grant(forged, "s")


@pytest.mark.parametrize(
    ("missing", "message"),
    [
        ("device_id", "device_id"),
        ("peer_device_id", "peer_device_id"),
        ("user_id", "user_id"),
        ("jti", "jti"),
    ],
)
def test_decode_requires_every_binding_claim(missing: str, message: str) -> None:
    """A grant missing any binding claim is refused.

    Args:
        missing: Claim to omit.
        message: Fragment expected in the error.
    """
    claims = {
        "scope": "relay-session",
        "sid": "s",
        "device_id": "a",
        "peer_device_id": "b",
        "user_id": 1,
        "jti": "j",
        "exp": 9999999999,
    }
    del claims[missing]
    with pytest.raises(InvalidGrantError, match=message):
        decode_session_grant(encode(claims), "s")


def test_decode_accepts_a_well_formed_grant() -> None:
    """A grant with every binding claim decodes to the expected identity."""
    grant = decode_session_grant(make_grant("s", "a", "b", user_id=7), "s")
    assert grant.device_id == "a"
    assert grant.peer_device_id == "b"
    assert grant.user_id == 7
    assert grant.device_pair == frozenset({"a", "b"})


def test_session_refuses_a_grant_from_another_user() -> None:
    """C1 regression at the session layer: identities must match the session.

    Even a validly signed grant naming this session id cannot join if it
    describes a different account or a different pair of devices.
    """
    session = RelaySession("s", user_id=1, device_pair=frozenset({"a", "b"}))
    intruder = SessionGrant(
        session_id="s",
        device_id="a",
        peer_device_id="b",
        user_id=999,
        jti="x",
        expires_at=9999999999.0,
    )
    with pytest.raises(JoinRejectedError, match="does not match"):
        session.join(intruder, websocket=None)  # type: ignore[arg-type]


def test_session_refuses_a_grant_for_another_device_pair() -> None:
    """A grant naming different devices cannot be redirected into a session."""
    session = RelaySession("s", user_id=1, device_pair=frozenset({"a", "b"}))
    wrong_pair = SessionGrant(
        session_id="s",
        device_id="a",
        peer_device_id="c",
        user_id=1,
        jti="x",
        expires_at=9999999999.0,
    )
    with pytest.raises(JoinRejectedError, match="does not match"):
        session.join(wrong_pair, websocket=None)  # type: ignore[arg-type]


def test_health_does_not_disclose_session_counts(client: TestClient) -> None:
    """L10 regression: the public health endpoint is not a usage oracle."""
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "healthy"
    assert "active_sessions" not in body
