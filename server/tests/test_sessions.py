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

"""
Tests for the browser session credential (issue #48).

Three things are being defended here:

1. The browser never holds ``~/.lem/api_token``. It holds a memory-only session
   token with a fixed 12-hour life.
2. A session token cannot mint another session token, so the TTL is real rather
   than decorative.
3. ``$LEM_REQUIRE_TOKEN`` can force the bearer requirement on over a *verified
   loopback* bind - the one exposure shape the process cannot observe, because
   the proxy republishing it sits outside the socket.

Nothing here touches the real ``~/.lem``: the token path is redirected to a
per-test tmp directory.
"""

import logging
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import security, sessions
from app.api.v1.session import router as session_router
from app.security import (
    ALLOWED_ORIGINS,
    BindPosture,
    LocalApiSecurityMiddleware,
    extract_bearer,
    token_required,
    token_required_override,
    tokens_match,
)
from app.sessions import (
    SESSION_TTL,
    clear_sessions,
    mint_session,
    reap_expired,
    revoke_session,
    session_count,
    verify_session,
)

ROOT_TOKEN = "root-token-for-tests"
CLIENT_HEADERS = {"X-Lem-Client": "lem-dashboard"}


@pytest.fixture(autouse=True)
def clean_session_store() -> Generator[None, None, None]:
    """Keep the module-level session store from leaking between tests."""
    clear_sessions()
    yield
    clear_sessions()


@pytest.fixture
def root_token(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[str, None, None]:
    """Write a throwaway root token and point the security module at it.

    Args:
        tmp_path: Per-test scratch directory
        monkeypatch: Fixture used to redirect the module-level token path

    Returns:
        The root token value
    """
    path = tmp_path / "lem-home" / "api_token"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(ROOT_TOKEN, encoding="utf-8")
    monkeypatch.setattr(security, "TOKEN_PATH", path)
    security.reset_token_cache()
    yield ROOT_TOKEN
    security.reset_token_cache()


@pytest.fixture
def loopback_bind() -> Generator[None, None, None]:
    """Pretend startup verified a loopback-only bind."""
    security.set_bind_posture(
        BindPosture(
            verified=True,
            loopback_only=True,
            addresses=("127.0.0.1:5142",),
            reason="read from the bound socket",
        )
    )
    yield
    security.reset_bind_posture()


def build_app() -> FastAPI:
    """Mount the session router behind the real security middleware.

    ``require_token`` is left at its default so the app answers to the live bind
    posture and to ``$LEM_REQUIRE_TOKEN``, exactly like the shipped one.

    Returns:
        Configured FastAPI app with the session router and a protected route
    """
    app = FastAPI()
    app.add_middleware(LocalApiSecurityMiddleware, allowed_origins=ALLOWED_ORIGINS)
    app.include_router(session_router, prefix="/v1")

    @app.get("/v1/ping")
    async def ping() -> dict[str, str]:
        return {"status": "ok"}

    return app


@pytest.fixture
def client(root_token: str) -> TestClient:
    """Client for an app whose bind posture is unverified (token required)."""
    security.reset_bind_posture()
    return TestClient(build_app())


def exchange(client: TestClient, token: str) -> dict[str, str]:
    """Trade a token for a session and return the decoded body.

    Args:
        client: Test client
        token: Credential to present

    Returns:
        Parsed JSON response body
    """
    response = client.post(
        "/v1/auth/session",
        headers={**CLIENT_HEADERS, "Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 201, response.text
    body: dict[str, str] = response.json()
    return body


# ============================================================================
# Session store: mint / verify / expire / revoke
# ============================================================================


def test_mint_and_verify_round_trip() -> None:
    """A freshly minted token is accepted."""
    session = mint_session()

    assert len(session.token) >= 32
    assert verify_session(session.token) is True


def test_mint_sets_a_twelve_hour_expiry() -> None:
    """The TTL is fixed, not sliding, and not configurable."""
    before = datetime.now(UTC)
    session = mint_session()

    assert session.expires_at.tzinfo is not None
    assert before + SESSION_TTL - timedelta(minutes=1) <= session.expires_at
    assert session.expires_at <= datetime.now(UTC) + SESSION_TTL


def test_each_session_is_distinct() -> None:
    """Two mints never collide."""
    assert mint_session().token != mint_session().token


def test_unknown_token_is_rejected() -> None:
    """A guess does not get in."""
    mint_session()
    assert verify_session("not-a-real-session-token") is False


def test_non_ascii_token_is_rejected_not_crashed() -> None:
    """compare_digest raises TypeError on non-ASCII str; hostile input must not 500."""
    mint_session()
    assert verify_session("sesión-tökén") is False


def test_empty_token_is_rejected() -> None:
    """An empty bearer is not a match for anything."""
    mint_session()
    assert verify_session("") is False


def test_expired_session_is_rejected_and_reaped() -> None:
    """Expiry must delete the entry, not just refuse it - the dict is unbounded otherwise."""
    expired = mint_session(ttl=timedelta(seconds=-1))
    assert session_count() == 1

    assert verify_session(expired.token) is False
    assert session_count() == 0


def test_reaping_spares_live_sessions() -> None:
    """Only the dead entries go."""
    live = mint_session()
    mint_session(ttl=timedelta(seconds=-1))

    assert reap_expired() == 1
    assert session_count() == 1
    assert verify_session(live.token) is True


def test_minting_reaps_too() -> None:
    """The store cannot grow through mints alone."""
    mint_session(ttl=timedelta(seconds=-1))
    assert session_count() == 1

    live = mint_session()

    assert session_count() == 1
    assert verify_session(live.token) is True


def test_revoke_kills_the_session() -> None:
    """Revocation is immediate."""
    session = mint_session()

    assert revoke_session(session.token) is True
    assert verify_session(session.token) is False


def test_revoking_an_unknown_token_reports_no_match() -> None:
    """Revoking something that was never minted is a no-op, not an error."""
    assert revoke_session("never-minted") is False


def test_revoke_leaves_other_sessions_alone() -> None:
    """One tab logging out does not sign the others out."""
    keep = mint_session()
    drop = mint_session()

    revoke_session(drop.token)

    assert verify_session(keep.token) is True


def test_clear_sessions_empties_the_store() -> None:
    """A restart invalidates everything; this is the in-process equivalent."""
    mint_session()
    clear_sessions()

    assert session_count() == 0


# ============================================================================
# Credential helpers
# ============================================================================


@pytest.mark.parametrize(
    "header,expected",
    [
        ("Bearer abc123", "abc123"),
        ("bearer abc123", "abc123"),
        ("Bearer   abc123  ", "abc123"),
        ("Basic abc123", None),
        ("Bearer", None),
        ("Bearer   ", None),
        ("", None),
        (None, None),
    ],
)
def test_extract_bearer(header: str | None, expected: str | None) -> None:
    """Only a non-empty Bearer credential is extracted."""
    assert extract_bearer(header) == expected


def test_tokens_match_tolerates_non_ascii() -> None:
    """A non-ASCII Authorization header is a mismatch, not a TypeError."""
    assert tokens_match("tökén", ROOT_TOKEN) is False
    assert tokens_match(ROOT_TOKEN, ROOT_TOKEN) is True


# ============================================================================
# POST /v1/auth/session - the exchange
# ============================================================================


def test_root_token_mints_a_session(client: TestClient, root_token: str) -> None:
    """The documented flow: paste ~/.lem/api_token, get a session token back."""
    body = exchange(client, root_token)

    assert body["token"] != root_token
    assert len(body["token"]) >= 32
    expires_at = datetime.fromisoformat(body["expires_at"])
    assert expires_at.tzinfo is not None
    assert expires_at > datetime.now(UTC)


def test_minted_session_authenticates_protected_routes(client: TestClient, root_token: str) -> None:
    """What the browser stores actually works as a bearer."""
    assert client.get("/v1/ping").status_code == 401

    session_token = exchange(client, root_token)["token"]
    response = client.get("/v1/ping", headers={"Authorization": f"Bearer {session_token}"})

    assert response.status_code == 200


def test_session_token_cannot_mint_another_session(client: TestClient, root_token: str) -> None:
    """The whole point of the fixed TTL.

    The security middleware accepts a session token on /v1/* - so if this
    endpoint deferred to the middleware, a stolen session could renew itself
    forever and expiry would protect nothing.
    """
    session_token = exchange(client, root_token)["token"]

    response = client.post(
        "/v1/auth/session",
        headers={**CLIENT_HEADERS, "Authorization": f"Bearer {session_token}"},
    )

    assert response.status_code == 401
    # ...and the session it presented is still alive; the refusal is about
    # privilege, not about the token having gone bad.
    still_live = client.get("/v1/ping", headers={"Authorization": f"Bearer {session_token}"})
    assert still_live.status_code == 200
    assert session_count() == 1


def test_exchange_without_a_token_is_refused(client: TestClient) -> None:
    """No credential, no session."""
    response = client.post("/v1/auth/session", headers=CLIENT_HEADERS)

    assert response.status_code == 401
    assert session_count() == 0


def test_exchange_with_a_wrong_token_is_refused(client: TestClient) -> None:
    """A guessed root token does not mint anything."""
    response = client.post(
        "/v1/auth/session",
        headers={**CLIENT_HEADERS, "Authorization": "Bearer wrong-root-token"},
    )

    assert response.status_code == 401
    assert session_count() == 0


def test_exchange_requires_the_root_token_even_on_loopback(
    root_token: str, loopback_bind: None
) -> None:
    """On loopback the middleware asks for nothing; this endpoint still does.

    That is what makes the proxy-in-front-of-loopback shape closable.
    """
    client = TestClient(build_app())

    assert client.get("/v1/ping").status_code == 200
    assert client.post("/v1/auth/session", headers=CLIENT_HEADERS).status_code == 401
    assert exchange(client, root_token)["token"]


def test_exchange_still_needs_the_csrf_header(client: TestClient, root_token: str) -> None:
    """Holding the root token does not exempt a POST from the CSRF layer."""
    response = client.post("/v1/auth/session", headers={"Authorization": f"Bearer {root_token}"})

    assert response.status_code == 403
    assert session_count() == 0


def test_exchange_fails_closed_without_a_server_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the server cannot load its own token, it refuses rather than minting."""
    monkeypatch.setattr(security, "TOKEN_PATH", tmp_path / "missing" / "api_token")
    security.reset_token_cache()
    security.reset_bind_posture()
    client = TestClient(build_app())

    response = client.post(
        "/v1/auth/session",
        headers={**CLIENT_HEADERS, "Authorization": f"Bearer {ROOT_TOKEN}"},
    )

    assert response.status_code == 503
    assert session_count() == 0
    security.reset_token_cache()


# ============================================================================
# DELETE /v1/auth/session - revocation
# ============================================================================


def test_delete_revokes_the_presented_session(client: TestClient, root_token: str) -> None:
    """Sign-out actually invalidates the credential server-side."""
    session_token = exchange(client, root_token)["token"]
    auth = {"Authorization": f"Bearer {session_token}"}

    response = client.delete("/v1/auth/session", headers={**CLIENT_HEADERS, **auth})

    assert response.status_code == 204
    assert response.content == b""
    assert client.get("/v1/ping", headers=auth).status_code == 401


def test_delete_of_an_unknown_session_is_not_an_oracle(
    root_token: str, loopback_bind: None
) -> None:
    """An unknown token gets the same 204 as a real one, so it cannot be probed.

    Run against a loopback bind, where the middleware demands no credential of
    its own: that is the only posture in which an unknown token reaches the
    handler at all.
    """
    client = TestClient(build_app())
    live = exchange(client, root_token)["token"]

    unknown = client.delete(
        "/v1/auth/session",
        headers={**CLIENT_HEADERS, "Authorization": "Bearer never-minted-token"},
    )
    known = client.delete(
        "/v1/auth/session",
        headers={**CLIENT_HEADERS, "Authorization": f"Bearer {live}"},
    )

    assert unknown.status_code == known.status_code == 204
    assert session_count() == 0


# ============================================================================
# LEM_REQUIRE_TOKEN
# ============================================================================


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on", " true "])
def test_require_token_override_accepts_truthy_values(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The documented spellings all turn it on."""
    monkeypatch.setenv("LEM_REQUIRE_TOKEN", value)
    assert token_required_override() is True


@pytest.mark.parametrize("value", ["0", "false", "no", "off", "", "  ", "maybe"])
def test_require_token_override_rejects_everything_else(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A typo must not be read as 'protected'."""
    monkeypatch.setenv("LEM_REQUIRE_TOKEN", value)
    assert token_required_override() is False


def test_require_token_override_defaults_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unset means today's behaviour."""
    monkeypatch.delenv("LEM_REQUIRE_TOKEN", raising=False)
    assert token_required_override() is False


def test_override_forces_the_token_on_a_loopback_bind(
    loopback_bind: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The posture says 'no token needed'; the operator overrules it."""
    monkeypatch.delenv("LEM_REQUIRE_TOKEN", raising=False)
    assert token_required() is False

    monkeypatch.setenv("LEM_REQUIRE_TOKEN", "true")
    assert token_required() is True


def test_override_cannot_switch_the_token_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """It only ever adds the requirement. An unverified bind stays closed."""
    security.reset_bind_posture()
    monkeypatch.setenv("LEM_REQUIRE_TOKEN", "false")

    assert token_required() is True


def test_loopback_request_is_401_when_the_override_is_set(
    root_token: str, loopback_bind: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """End to end: `vite --host` in front of a loopback API is now closable."""
    monkeypatch.setenv("LEM_REQUIRE_TOKEN", "1")
    client = TestClient(build_app())

    assert client.get("/v1/ping").status_code == 401

    session_token = exchange(client, root_token)["token"]
    assert (
        client.get("/v1/ping", headers={"Authorization": f"Bearer {session_token}"}).status_code
        == 200
    )


def test_loopback_request_is_open_without_the_override(
    root_token: str, loopback_bind: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression guard: the default posture is exactly what it was before #48."""
    monkeypatch.delenv("LEM_REQUIRE_TOKEN", raising=False)
    client = TestClient(build_app())

    assert client.get("/v1/ping").status_code == 200


# ============================================================================
# Tokens must never reach the logs
# ============================================================================


def test_no_token_material_is_ever_logged(
    client: TestClient, root_token: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Not the root token, not a session token, not a prefix of either.

    Logs are not 0600, ship to journald/Docker, and get pasted into bug
    reports. Truncated tokens are still credential material for a search.
    """
    with caplog.at_level(logging.DEBUG):
        session_token = exchange(client, root_token)["token"]
        client.get("/v1/ping", headers={"Authorization": f"Bearer {session_token}"})
        client.get("/v1/ping", headers={"Authorization": "Bearer wrong-token-guess"})
        client.post(
            "/v1/auth/session",
            headers={**CLIENT_HEADERS, "Authorization": f"Bearer {session_token}"},
        )
        client.delete(
            "/v1/auth/session",
            headers={**CLIENT_HEADERS, "Authorization": f"Bearer {session_token}"},
        )

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert logged, "expected the requests above to log something"

    for secret in (root_token, session_token):
        assert secret not in logged
        # A prefix long enough to be a useful search key must not appear either.
        assert secret[:8] not in logged


def test_the_mint_log_line_reports_the_lifetime_only(
    client: TestClient, root_token: str, caplog: pytest.LogCaptureFixture
) -> None:
    """Positive control for the test above: the exchange really does log.

    Without this, "no token appears in the logs" would also pass if the logs
    were empty for some unrelated reason.
    """
    with caplog.at_level(logging.DEBUG):
        session_token = exchange(client, root_token)["token"]

    minted = [r.getMessage() for r in caplog.records if "Minted a local API session" in r.message]

    assert len(minted) == 1
    assert str(sessions.SESSION_TTL) in minted[0]
    assert session_token not in minted[0]
