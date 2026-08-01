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

"""Rate limiting, fail-closed settings and token handling tests."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from jose import JWTError, jwt
from pydantic import ValidationError

from app.core import ratelimit
from app.core.config import Settings, settings
from app.core.ratelimit import RateLimiter
from app.core.security import decode_access_token

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
    """H1 regression: the key printed in this repository is refused outright.

    docker-compose.yml hardcoded it, both .env.example files shipped it, and
    the old guard only fired when ENV=production, which nothing set.
    """
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


def test_settings_fall_back_to_default_ice_servers_on_bad_json() -> None:
    """Malformed ICE configuration does not take the server down."""
    parsed = settings_with(ice_servers_json="not json")
    assert parsed.ice_servers == [{"urls": "stun:stun.l.google.com:19302"}]


def test_cors_preflight_does_not_reflect_an_arbitrary_origin(
    client: TestClient,
) -> None:
    """H2 regression: an unlisted origin is not echoed back with credentials."""
    response = client.options(
        "/auth/login",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert response.headers.get("access-control-allow-origin") != "https://evil.example"


def test_cors_allows_the_configured_origin(client: TestClient) -> None:
    """The configured origin is allowed, so the fix does not break the app."""
    allowed = settings.cors_allowed_origins[0]
    response = client.options(
        "/auth/login",
        headers={"Origin": allowed, "Access-Control-Request-Method": "POST"},
    )
    assert response.headers.get("access-control-allow-origin") == allowed


def test_token_without_expiry_is_rejected() -> None:
    """L7 regression: a token with no exp claim is not accepted forever."""
    everlasting = jwt.encode(
        {"sub": "alice@example.com", "user_id": 1},
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    with pytest.raises(JWTError):
        decode_access_token(everlasting)


def test_expired_token_is_rejected() -> None:
    """An expired token does not decode."""
    stale = jwt.encode(
        {
            "sub": "alice@example.com",
            "user_id": 1,
            "exp": datetime.now(UTC) - timedelta(hours=1),
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )
    with pytest.raises(JWTError):
        decode_access_token(stale)


def test_registration_is_rate_limited(client: TestClient) -> None:
    """H4 regression: open registration is throttled per source address."""
    limit = settings.max_registrations_per_hour
    for index in range(limit):
        response = client.post(
            "/auth/register",
            json={"email": f"user{index}@example.com", "password": "testpass123"},
        )
        assert response.status_code == 201, response.text

    blocked = client.post(
        "/auth/register",
        json={"email": "one-too-many@example.com", "password": "testpass123"},
    )
    assert blocked.status_code == 429


def test_login_is_rate_limited(client: TestClient) -> None:
    """H4 regression: password guessing is throttled."""
    client.post(
        "/auth/register",
        json={"email": "alice@example.com", "password": "testpass123"},
    )

    statuses = []
    for _ in range(settings.max_logins_per_minute + 2):
        response = client.post(
            "/auth/login",
            json={"email": "alice@example.com", "password": "wrong-password"},
        )
        statuses.append(response.status_code)

    assert 429 in statuses


def test_signal_connections_are_rate_limited(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """H4 regression: max_connections_per_second is no longer dead config."""
    monkeypatch.setattr(ratelimit.signal_connect_limiter, "limit", 1)
    ratelimit.signal_connect_limiter.reset()

    with client.websocket_connect("/signal"):
        pass

    with pytest.raises(Exception):
        with client.websocket_connect("/signal"):
            pass


def test_rate_limiter_window_slides() -> None:
    """Old events age out of the window."""
    limiter = RateLimiter(limit=2, window_seconds=0.05)
    assert limiter.check("a")
    assert limiter.check("a")
    assert not limiter.check("a")

    import time

    time.sleep(0.06)
    assert limiter.check("a")


def test_rate_limiter_buckets_are_independent() -> None:
    """One caller's usage does not affect another's."""
    limiter = RateLimiter(limit=1, window_seconds=60)
    assert limiter.check("a")
    assert not limiter.check("a")
    assert limiter.check("b")


def test_client_ip_ignores_forwarded_header_by_default(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A spoofed X-Forwarded-For does not reset the caller's own budget."""
    monkeypatch.setattr(settings, "trust_x_forwarded_for", False)

    limit = settings.max_registrations_per_hour
    for index in range(limit):
        client.post(
            "/auth/register",
            json={"email": f"user{index}@example.com", "password": "testpass123"},
        )

    blocked = client.post(
        "/auth/register",
        json={"email": "spoofed@example.com", "password": "testpass123"},
        headers={"X-Forwarded-For": "203.0.113.9"},
    )
    assert blocked.status_code == 429


def test_client_ip_uses_the_last_forwarded_entry_when_trusted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Behind a trusted proxy the address the proxy appended is the one used.

    nginx uses $proxy_add_x_forwarded_for, which appends the real peer to
    whatever the client sent, so only the last element is trustworthy.
    """
    monkeypatch.setattr(settings, "trust_x_forwarded_for", True)

    limit = settings.max_registrations_per_hour
    for index in range(limit):
        response = client.post(
            "/auth/register",
            json={"email": f"user{index}@example.com", "password": "testpass123"},
            headers={"X-Forwarded-For": "10.0.0.1"},
        )
        assert response.status_code == 201

    # Same trailing address: still limited, even with a different spoofed head.
    blocked = client.post(
        "/auth/register",
        json={"email": "same-proxy@example.com", "password": "testpass123"},
        headers={"X-Forwarded-For": "203.0.113.9, 10.0.0.1"},
    )
    assert blocked.status_code == 429

    # A genuinely different client address gets its own budget.
    allowed = client.post(
        "/auth/register",
        json={"email": "other-client@example.com", "password": "testpass123"},
        headers={"X-Forwarded-For": "10.0.0.2"},
    )
    assert allowed.status_code == 201
