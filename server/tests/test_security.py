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

"""Tests for local API access control (CSRF middleware + bearer token)."""

import stat
from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import security
from app.security import (
    ALLOWED_ORIGINS,
    BindPosture,
    LocalApiSecurityMiddleware,
    ensure_api_token,
    get_allowed_origins,
    get_api_token,
    get_bind_host,
    is_loopback_host,
)

TOKEN = "test-token-value"
ALLOWED_ORIGIN = "http://localhost:5174"


@pytest.fixture
def verified_loopback() -> Generator[None, None, None]:
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


def build_app(*, require_token: bool = False, token: str | None = TOKEN) -> FastAPI:
    """Build a minimal app wrapped in the security middleware.

    Args:
        require_token: Whether bearer auth is enforced (non-loopback bind)
        token: Token the middleware expects (None = no token available)

    Returns:
        Configured FastAPI app
    """
    app = FastAPI()
    app.add_middleware(
        LocalApiSecurityMiddleware,
        allowed_origins=ALLOWED_ORIGINS,
        require_token=require_token,
        token_provider=lambda: token,
    )

    @app.get("/v1/ping")
    async def read_ping() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/ping")
    async def write_ping() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"status": "ok"}

    return app


@pytest.fixture
def loopback_client() -> TestClient:
    """Client for a loopback bind (CSRF on, token optional)."""
    return TestClient(build_app(require_token=False))


@pytest.fixture
def exposed_client() -> TestClient:
    """Client for a non-loopback bind (CSRF on, token required)."""
    return TestClient(build_app(require_token=True))


# ============================================================================
# CSRF middleware (S2)
# ============================================================================


def test_safe_method_needs_no_client_header(loopback_client: TestClient) -> None:
    """GET cannot change state, so it passes without the custom header."""
    response = loopback_client.get("/v1/ping")
    assert response.status_code == 200


def test_post_without_client_header_is_forbidden(loopback_client: TestClient) -> None:
    """The CSRF exploit: a simple cross-origin POST with no custom header."""
    response = loopback_client.post("/v1/ping")

    assert response.status_code == 403
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "https://lem.gg/errors/csrf-blocked"


def test_post_with_client_header_passes(loopback_client: TestClient) -> None:
    """A real Lem client sends X-Lem-Client and is allowed through."""
    response = loopback_client.post("/v1/ping", headers={"X-Lem-Client": "lem-dashboard"})

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_client_header_is_case_insensitive(loopback_client: TestClient) -> None:
    """HTTP header names are case-insensitive."""
    response = loopback_client.post("/v1/ping", headers={"x-LEM-client": "lem-dashboard"})
    assert response.status_code == 200


def test_post_from_disallowed_origin_is_forbidden(loopback_client: TestClient) -> None:
    """An allowlisted Origin is required whenever one is sent."""
    response = loopback_client.post(
        "/v1/ping",
        headers={"X-Lem-Client": "lem-dashboard", "Origin": "https://evil.example.com"},
    )

    assert response.status_code == 403
    assert response.json()["type"] == "https://lem.gg/errors/origin-not-allowed"


def test_post_from_allowed_origin_passes(loopback_client: TestClient) -> None:
    """The dashboard origin is on the allowlist."""
    response = loopback_client.post(
        "/v1/ping",
        headers={"X-Lem-Client": "lem-dashboard", "Origin": ALLOWED_ORIGIN},
    )
    assert response.status_code == 200


def test_csrf_applies_outside_v1(loopback_client: TestClient) -> None:
    """CSRF protection is not scoped to /v1 - it covers every unsafe request."""
    response = loopback_client.request("DELETE", "/")
    assert response.status_code == 403


# ============================================================================
# Bearer token enforcement (S1)
# ============================================================================


def test_token_not_required_on_loopback(loopback_client: TestClient) -> None:
    """On a loopback bind, reaching the socket already requires local access."""
    assert loopback_client.get("/v1/ping").status_code == 200


def test_valid_token_accepted_on_loopback(loopback_client: TestClient) -> None:
    """A client that sends a token still works on loopback."""
    response = loopback_client.get("/v1/ping", headers={"Authorization": f"Bearer {TOKEN}"})
    assert response.status_code == 200


def test_token_required_when_exposed(exposed_client: TestClient) -> None:
    """The LAN exploit: read /v1/* from another machine with no credentials."""
    response = exposed_client.get("/v1/ping")

    assert response.status_code == 401
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["type"] == "https://lem.gg/errors/unauthorized"


def test_wrong_token_rejected_when_exposed(exposed_client: TestClient) -> None:
    """A guessed token does not get in."""
    response = exposed_client.get("/v1/ping", headers={"Authorization": "Bearer wrong"})
    assert response.status_code == 401


def test_non_bearer_scheme_rejected_when_exposed(exposed_client: TestClient) -> None:
    """Only the Bearer scheme is accepted."""
    response = exposed_client.get("/v1/ping", headers={"Authorization": f"Basic {TOKEN}"})
    assert response.status_code == 401


def test_valid_token_accepted_when_exposed(exposed_client: TestClient) -> None:
    """The local user, holding ~/.lem/api_token, is allowed through."""
    response = exposed_client.get("/v1/ping", headers={"Authorization": f"Bearer {TOKEN}"})
    assert response.status_code == 200


def test_token_and_csrf_both_required_when_exposed(exposed_client: TestClient) -> None:
    """A valid token does not exempt a request from the CSRF check."""
    with_token = exposed_client.post("/v1/ping", headers={"Authorization": f"Bearer {TOKEN}"})
    assert with_token.status_code == 403

    with_both = exposed_client.post(
        "/v1/ping",
        headers={"Authorization": f"Bearer {TOKEN}", "X-Lem-Client": "lem-dashboard"},
    )
    assert with_both.status_code == 200


def test_token_only_guards_protected_prefix(exposed_client: TestClient) -> None:
    """Non-/v1 paths (root, docs) stay reachable without a token."""
    assert exposed_client.get("/").status_code == 200


def test_preflight_passes_without_token(exposed_client: TestClient) -> None:
    """A CORS preflight cannot carry Authorization, so OPTIONS is exempt."""
    response = exposed_client.options("/v1/ping")
    assert response.status_code != 401


def test_missing_token_fails_closed() -> None:
    """If the token cannot be loaded, requests are refused rather than allowed."""
    client = TestClient(build_app(require_token=True, token=None))
    response = client.get("/v1/ping")

    assert response.status_code == 503
    assert response.json()["type"] == "https://lem.gg/errors/token-unavailable"


# ============================================================================
# Bind host resolution
# ============================================================================


@pytest.mark.parametrize(
    "host,expected",
    [
        ("127.0.0.1", True),
        ("localhost", True),
        ("::1", True),
        ("[::1]", True),
        ("127.0.0.53", True),
        ("0.0.0.0", False),
        ("::", False),
        ("192.168.1.10", False),
        ("lem.example.com", False),
        ("", False),
    ],
)
def test_is_loopback_host(host: str, expected: bool) -> None:
    """Only addresses that stay on this machine count as loopback."""
    assert is_loopback_host(host) is expected


def test_bind_host_defaults_to_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    """LEM_HOST is the documented opt-in; the default is 127.0.0.1."""
    monkeypatch.delenv("LEM_HOST", raising=False)
    assert get_bind_host() == "127.0.0.1"
    assert is_loopback_host(get_bind_host()) is True


def test_bind_host_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """LEM_HOST opts in to LAN exposure."""
    monkeypatch.setenv("LEM_HOST", "0.0.0.0")
    assert get_bind_host() == "0.0.0.0"
    assert is_loopback_host(get_bind_host()) is False


def test_blank_bind_host_defaults_to_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty LEM_HOST is treated as unset, not as 'all interfaces'."""
    monkeypatch.setenv("LEM_HOST", "   ")
    assert get_bind_host() == "127.0.0.1"


# ============================================================================
# Token file (S4)
# ============================================================================


@pytest.fixture
def token_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[Path, None, None]:
    """Point the token helpers at a temporary file."""
    path = tmp_path / "lem-home" / "api_token"
    monkeypatch.setattr(security, "TOKEN_PATH", path)
    security.reset_token_cache()
    yield path
    security.reset_token_cache()


def test_ensure_api_token_creates_owner_only_file(token_file: Path) -> None:
    """The token is generated with mode 0600 inside an owner-only directory."""
    token = ensure_api_token()

    assert len(token) >= 32
    assert token_file.read_text(encoding="utf-8") == token
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600
    assert stat.S_IMODE(token_file.parent.stat().st_mode) == 0o700


def test_ensure_api_token_is_stable(token_file: Path) -> None:
    """A restart reuses the existing token instead of invalidating clients."""
    first = ensure_api_token()
    security.reset_token_cache()

    assert ensure_api_token() == first


def test_ensure_api_token_restricts_existing_file(token_file: Path) -> None:
    """A token left world-readable by an older build is tightened on load."""
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text("preexisting-token", encoding="utf-8")
    token_file.chmod(0o644)

    assert ensure_api_token() == "preexisting-token"
    assert stat.S_IMODE(token_file.stat().st_mode) == 0o600


def test_get_api_token_returns_none_when_absent(token_file: Path) -> None:
    """get_api_token never creates the token file."""
    assert get_api_token() is None
    assert not token_file.exists()


def test_get_api_token_reads_from_disk(token_file: Path) -> None:
    """A token written by the startup hook is visible to the middleware."""
    expected = ensure_api_token()
    security.reset_token_cache()

    assert get_api_token() == expected


# ============================================================================
# Wiring: the real application is protected
# ============================================================================


def test_real_app_blocks_unauthenticated_state_change(
    verified_loopback: None,
) -> None:
    """The middleware is actually installed on the shipped app.

    /v1/tunnel/disable takes no request body, which is exactly what made it
    reachable by a cross-origin fetch(..., {method: 'POST', mode: 'no-cors'}).
    """
    from app.main import app as lem_app

    client = TestClient(lem_app)

    assert client.get("/v1/health").status_code == 200
    assert client.post("/v1/tunnel/disable").status_code == 403
    assert (
        client.post("/v1/tunnel/disable", headers={"X-Lem-Client": "lem-dashboard"}).status_code
        == 200
    )


def test_real_app_fails_closed_when_the_bind_is_unverified() -> None:
    """No verified loopback bind means the shipped app demands a token."""
    from app.main import app as lem_app

    security.reset_bind_posture()
    client = TestClient(lem_app)

    assert client.get("/v1/health").status_code in (401, 503)


# ============================================================================
# Browser origin allowlist (LEM_ALLOWED_ORIGINS)
# ============================================================================


def test_allowed_origins_defaults_to_localhost(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without the opt-in, only the built-in localhost origins are accepted."""
    monkeypatch.delenv("LEM_ALLOWED_ORIGINS", raising=False)

    assert get_allowed_origins() == ALLOWED_ORIGINS


def test_allowed_origins_extends_for_lan_dashboards(monkeypatch: pytest.MonkeyPatch) -> None:
    """LEM_HOST ships a LAN opt-in; this is what makes the dashboard usable."""
    monkeypatch.setenv("LEM_ALLOWED_ORIGINS", "http://192.168.1.10:5174, http://lem.local:5174/")

    origins = get_allowed_origins()

    assert origins[: len(ALLOWED_ORIGINS)] == ALLOWED_ORIGINS
    assert "http://192.168.1.10:5174" in origins
    assert "http://lem.local:5174" in origins


@pytest.mark.parametrize("value", ["*", "192.168.1.10:5174", "  ", "not-a-url"])
def test_allowed_origins_refuses_junk_and_wildcards(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A wildcard would turn the Origin half of the CSRF check off."""
    monkeypatch.setenv("LEM_ALLOWED_ORIGINS", value)

    assert get_allowed_origins() == ALLOWED_ORIGINS


def test_lan_origin_is_accepted_by_the_middleware() -> None:
    """End to end: a LAN dashboard POST is no longer a silent 403."""
    lan_origin = "http://192.168.1.10:5174"
    app = FastAPI()
    app.add_middleware(
        LocalApiSecurityMiddleware,
        allowed_origins=(*ALLOWED_ORIGINS, lan_origin),
        require_token=False,
    )

    @app.post("/v1/ping")
    async def write_ping() -> dict[str, str]:
        return {"status": "ok"}

    client = TestClient(app)
    response = client.post(
        "/v1/ping", headers={"X-Lem-Client": "lem-dashboard", "Origin": lan_origin}
    )

    assert response.status_code == 200
