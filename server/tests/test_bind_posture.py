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

"""Regression tests for the bind/posture divergence (issue #29).

``LOOPBACK_ONLY`` used to be computed from ``$LEM_HOST`` alone, which has no
relationship to the address uvicorn is told to bind. Starting the app on
``0.0.0.0`` with ``LEM_HOST`` unset produced an unauthenticated 200 on
``POST /v1/tunnel/disable`` over the LAN while the log claimed
``✓ Listening on 127.0.0.1 (loopback only)``.

These tests drive the real socket: they bind it the way ``app.serve`` does and
assert the enforcement decision and the startup log follow ``getsockname()``.
"""

import asyncio
import logging
import socket
from collections.abc import AsyncGenerator, Generator
from pathlib import Path

import httpx
import pytest
import uvicorn

from app import db, security
from app.security import BindPosture, verify_bind_posture
from app.serve import bind_and_verify, build_config

TOKEN = "bind-posture-token"


@pytest.fixture(autouse=True)
def isolated_lem_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Generator[Path, None, None]:
    """Keep the real ~/.lem out of these tests.

    Yields:
        The temporary Lem home
    """
    home = tmp_path / "lem-home"
    monkeypatch.setattr(db, "LEM_HOME", home)
    monkeypatch.setattr(db, "DB_PATH", home / "lem.db")
    monkeypatch.setattr(security, "TOKEN_PATH", home / "api_token")
    security.reset_token_cache()
    yield home
    security.reset_token_cache()
    security.reset_bind_posture()


@pytest.fixture(autouse=True)
def restore_posture() -> Generator[None, None, None]:
    """Never leak a posture into another test."""
    security.reset_bind_posture()
    yield
    security.reset_bind_posture()


# ============================================================================
# The posture is read off the socket, and fails closed
# ============================================================================


def test_default_posture_requires_a_token() -> None:
    """Nothing verified yet means the token is enforced."""
    posture = security.get_bind_posture()

    assert posture.verified is False
    assert posture.require_token is True
    assert security.token_required() is True
    assert "NOT verified" in posture.describe()


@pytest.mark.parametrize("host", ["127.0.0.1", "::1"])
def test_loopback_socket_is_verified_as_loopback(host: str) -> None:
    """A real loopback socket lifts the token requirement."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        posture = verify_bind_posture([sock])

    assert posture.verified is True
    assert posture.loopback_only is True
    assert posture.require_token is False
    assert security.token_required() is False


@pytest.mark.parametrize("host", ["0.0.0.0", "::"])
def test_wildcard_socket_requires_a_token(host: str) -> None:
    """The exploit's bind: 0.0.0.0 is every interface, so the token applies."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    with socket.socket(family, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        posture = verify_bind_posture([sock])

    assert posture.verified is True
    assert posture.loopback_only is False
    assert posture.require_token is True
    assert "loopback only" not in posture.describe()


def test_entrypoint_binds_what_lem_host_and_lem_port_ask_for(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """app.serve is the single place the bind address is chosen."""
    monkeypatch.setenv("LEM_HOST", "0.0.0.0")
    monkeypatch.setenv("LEM_PORT", "6001")

    config = build_config(security.get_bind_host(), security.get_bind_port())

    assert config.host == "0.0.0.0"
    assert config.port == 6001


def test_no_socket_at_all_fails_closed() -> None:
    """An empty socket list is undeterminable, not safe."""
    posture = verify_bind_posture([])

    assert posture.verified is False
    assert posture.require_token is True


def test_lem_host_alone_cannot_claim_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    """The core regression: the env var no longer decides anything.

    LEM_HOST is unset (so the old code computed BIND_HOST=127.0.0.1 and turned
    auth off) while the socket is bound to every interface.
    """
    monkeypatch.delenv("LEM_HOST", raising=False)
    assert security.get_bind_host() == "127.0.0.1"

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("0.0.0.0", 0))
        posture = verify_bind_posture([sock])

    assert posture.loopback_only is False
    assert security.token_required() is True


# ============================================================================
# End to end: the real app on a real non-loopback socket
# ============================================================================


@pytest.fixture
async def exposed_server(monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[str, None]:
    """Serve the real app on 0.0.0.0 exactly as app.serve would.

    Yields:
        Base URL of the running server
    """
    monkeypatch.setenv("LEM_HOST", "0.0.0.0")
    monkeypatch.setenv("LEM_PORT", "0")
    monkeypatch.setattr(security, "_cached_token", TOKEN)

    from app.main import app as lem_app

    # Same shape as build_config(), but against the imported app object and with
    # the lifespan off: this fixture is about the wire behaviour of a
    # non-loopback bind; the startup log is asserted separately below.
    config = uvicorn.Config(lem_app, host="0.0.0.0", port=0, lifespan="off", log_level="error")
    sock = bind_and_verify(config)

    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve(sockets=[sock]))
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.02)
    else:  # pragma: no cover - only on a broken event loop
        raise AssertionError("Test server did not start")

    port: int = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task
        sock.close()


async def test_unauthenticated_request_is_refused_on_a_wildcard_bind(
    exposed_server: str,
) -> None:
    """The proven exploit: 200 OK on an unauthenticated POST over the LAN.

    The attacker's ``X-Lem-Client`` is public knowledge, so the token is the
    only thing standing between them and Docker.
    """
    async with httpx.AsyncClient(base_url=exposed_server) as client:
        response = await client.post("/v1/tunnel/disable", headers={"X-Lem-Client": "attacker"})

    assert response.status_code == 401
    assert response.json()["type"] == "https://lem.gg/errors/unauthorized"


async def test_local_user_with_the_token_still_gets_through(exposed_server: str) -> None:
    """The opt-in stays usable for whoever can read ~/.lem/api_token."""
    async with httpx.AsyncClient(base_url=exposed_server) as client:
        response = await client.post(
            "/v1/tunnel/disable",
            headers={"X-Lem-Client": "lem-dashboard", "Authorization": f"Bearer {TOKEN}"},
        )

    assert response.status_code == 200


# ============================================================================
# The startup log states what was verified, never what it assumed
# ============================================================================


async def test_startup_log_never_claims_loopback_on_a_wildcard_bind(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The log used to say '✓ Listening on 127.0.0.1 (loopback only)'."""
    from app.main import app as lem_app
    from app.main import lifespan

    security.set_bind_posture(
        BindPosture(
            verified=True,
            loopback_only=False,
            addresses=("0.0.0.0:5142",),
            reason="read from the bound socket",
        )
    )

    with caplog.at_level(logging.INFO, logger="app.main"):
        async with lifespan(lem_app):
            pass

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "loopback only" not in logged
    assert "0.0.0.0:5142" in logged
    assert "bearer token REQUIRED on /v1/*" in logged


async def test_startup_log_reports_an_unverified_bind_as_unverified(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Started outside app.serve: say so, and enforce the token."""
    from app.main import app as lem_app
    from app.main import lifespan

    with caplog.at_level(logging.INFO, logger="app.main"):
        async with lifespan(lem_app):
            pass

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "loopback only" not in logged
    assert "NOT verified" in logged
    assert "bearer token REQUIRED on /v1/*" in logged


async def test_startup_log_confirms_a_verified_loopback_bind(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The happy path still reports loopback - because it checked."""
    from app.main import app as lem_app
    from app.main import lifespan

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        verify_bind_posture([sock])

        with caplog.at_level(logging.INFO, logger="app.main"):
            async with lifespan(lem_app):
                pass

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert "verified listening on 127.0.0.1:" in logged
    assert "loopback only" in logged
    assert "bearer token accepted but not required" in logged
