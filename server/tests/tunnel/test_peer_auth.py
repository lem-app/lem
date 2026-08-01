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

"""Regression tests for the tunnel peer authorization gate (issue #29).

Before this gate the tunnel answered a WebRTC offer from *any*
``sender_device_id`` and then stamped the local server's own ``X-Lem-Client``
header and bearer token onto every request it proxied. Any peer that opened a
DataChannel got authenticated Docker control.
"""

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
import uvicorn
from fastapi import FastAPI, Response

from app.db import AuthState
from app.security import ALLOWED_ORIGINS, LocalApiSecurityMiddleware
from app.tunnel.http_frame import serialize_request_head
from app.tunnel.http_proxy import GENERIC_PEER_UNAUTHORIZED, HTTPProxyHandler
from app.tunnel.peer_auth import (
    ALLOW_UNVERIFIED_ENV_VAR,
    AllowAllVerifier,
    PeerDecision,
    PeerIdentity,
    RegisteredDeviceVerifier,
    build_peer_verifier,
    unverified_peers_allowed,
)
from app.tunnel.router import RequestRouter
from app.tunnel.webrtc_client import TunnelAgent

from .proxy_harness import FrameCollector, drain

REGISTERED_PEER = "browser-abc123"
UNKNOWN_PEER = "attacker-device"
OWN_DEVICE = "local-server-deadbeef"


def _auth_state() -> AuthState:
    """Build a logged-in auth state.

    Returns:
        AuthState pointing at a fake signaling server
    """
    return AuthState(
        email="user@example.com",
        jwt_token="jwt-token",
        device_id=OWN_DEVICE,
        signaling_url="https://signal.example.com",
    )


class _DenyingVerifier:
    """Verifier that refuses everything (stands in for an unknown peer)."""

    async def verify(self, peer: PeerIdentity) -> PeerDecision:
        """Deny.

        Args:
            peer: Claimed peer identity

        Returns:
            An unauthorized decision
        """
        return PeerDecision(False, "device is not registered to this account")


# ============================================================================
# RegisteredDeviceVerifier: membership in the account's device list
# ============================================================================


def _patch_device_list(devices: list[dict[str, Any]]) -> Any:
    """Patch the signaling device-list lookup with a canned answer.

    Args:
        devices: Device records the signaling server should return

    Returns:
        A patch context manager for RegisteredDeviceVerifier's HTTP call
    """

    async def fake_ids(self: RegisteredDeviceVerifier, auth_state: AuthState) -> frozenset[str]:
        return frozenset({str(d["id"]) for d in devices} | {auth_state.device_id})

    return patch.object(RegisteredDeviceVerifier, "_registered_device_ids", fake_ids)


async def test_registered_peer_is_authorized() -> None:
    """A device on the account's list may use the tunnel."""
    with patch("app.tunnel.peer_auth.get_auth_state", return_value=_auth_state()):
        with _patch_device_list([{"id": REGISTERED_PEER}]):
            decision = await RegisteredDeviceVerifier().verify(PeerIdentity(REGISTERED_PEER))

    assert decision.authorized is True


async def test_unregistered_peer_is_denied() -> None:
    """A device belonging to some other account is refused."""
    with patch("app.tunnel.peer_auth.get_auth_state", return_value=_auth_state()):
        with _patch_device_list([{"id": REGISTERED_PEER}]):
            decision = await RegisteredDeviceVerifier().verify(PeerIdentity(UNKNOWN_PEER))

    assert decision.authorized is False
    assert "not registered" in decision.reason


async def test_missing_sender_device_id_is_denied() -> None:
    """An offer with no sender identity at all is refused."""
    decision = await RegisteredDeviceVerifier().verify(PeerIdentity(""))

    assert decision.authorized is False


async def test_logged_out_machine_denies_every_peer() -> None:
    """Without an account there is no device list, so nothing is authorized."""
    with patch("app.tunnel.peer_auth.get_auth_state", return_value=None):
        decision = await RegisteredDeviceVerifier().verify(PeerIdentity(REGISTERED_PEER))

    assert decision.authorized is False


async def test_unreachable_device_registry_fails_closed() -> None:
    """An unreachable registry is not permission."""

    async def boom(self: RegisteredDeviceVerifier, auth_state: AuthState) -> frozenset[str]:
        raise TimeoutError("signaling server unreachable")

    with patch("app.tunnel.peer_auth.get_auth_state", return_value=_auth_state()):
        with patch.object(RegisteredDeviceVerifier, "_registered_device_ids", boom):
            decision = await RegisteredDeviceVerifier().verify(PeerIdentity(REGISTERED_PEER))

    assert decision.authorized is False
    assert "could not load" in decision.reason


# ============================================================================
# The device list actually comes from the signaling server
# ============================================================================


@pytest.fixture
async def fake_signaling() -> AsyncGenerator[tuple[str, dict[str, Any]], None]:
    """Serve a stand-in signaling /devices/ endpoint.

    Yields:
        Base URL and a mutable control dict (``status``, ``devices``, ``calls``)
    """
    control: dict[str, Any] = {"status": 200, "devices": [{"id": REGISTERED_PEER}], "calls": 0}
    api = FastAPI()

    @api.get("/devices/")
    async def devices(response: Response) -> list[dict[str, str]]:
        control["calls"] += 1
        response.status_code = int(control["status"])
        return list(control["devices"])

    server = uvicorn.Server(uvicorn.Config(api, host="127.0.0.1", port=0, log_level="error"))
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.02)
    else:  # pragma: no cover - only on a broken event loop
        raise AssertionError("Fake signaling server did not start")

    port: int = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}", control
    finally:
        server.should_exit = True
        await task


async def test_device_list_is_fetched_from_signaling(
    fake_signaling: tuple[str, dict[str, Any]],
) -> None:
    """The account's devices come over the wire, and strangers are cached off it."""
    base, control = fake_signaling
    auth = AuthState("user@example.com", "jwt-token", OWN_DEVICE, base)
    verifier = RegisteredDeviceVerifier()

    with patch("app.tunnel.peer_auth.get_auth_state", return_value=auth):
        first = await verifier.verify(PeerIdentity(REGISTERED_PEER))
        stranger = await verifier.verify(PeerIdentity(UNKNOWN_PEER))
        own = await verifier.verify(PeerIdentity(OWN_DEVICE))

    assert first.authorized is True
    assert stranger.authorized is False
    assert own.authorized is True, "this machine's own device belongs to its account"
    # The stranger was denied straight off the cached list - no second lookup -
    # while each *authorization* went back to the registry.
    assert control["calls"] == 2


async def test_deregistered_device_is_not_waved_through_by_the_cache(
    fake_signaling: tuple[str, dict[str, Any]],
) -> None:
    """A device removed from the account cannot reconnect on a stale device list.

    The list is cached to keep an offer flood from hammering signaling, but a
    cached list that would *authorize* is never trusted: the grant path always
    re-reads the registry. Otherwise revoking a device would take up to
    DEVICE_CACHE_TTL_SECONDS to take effect on new connections.
    """
    base, control = fake_signaling
    auth = AuthState("user@example.com", "jwt-token", OWN_DEVICE, base)
    verifier = RegisteredDeviceVerifier()

    with patch("app.tunnel.peer_auth.get_auth_state", return_value=auth):
        before = await verifier.verify(PeerIdentity(REGISTERED_PEER))
        # Deregistered on the account, well inside the cache TTL.
        control["devices"] = []
        after = await verifier.verify(PeerIdentity(REGISTERED_PEER))

    assert before.authorized is True
    assert after.authorized is False, "a deregistered device reconnected on cached data"
    assert "not registered" in after.reason


async def test_signaling_error_response_denies(
    fake_signaling: tuple[str, dict[str, Any]],
) -> None:
    """An expired JWT (401) must not be read as 'no devices, allow anyway'."""
    base, control = fake_signaling
    control["status"] = 401
    auth = AuthState("user@example.com", "stale-jwt", OWN_DEVICE, base)

    with patch("app.tunnel.peer_auth.get_auth_state", return_value=auth):
        decision = await RegisteredDeviceVerifier().verify(PeerIdentity(REGISTERED_PEER))

    assert decision.authorized is False
    assert "HTTP 401" in decision.reason


async def test_malformed_device_list_denies(
    fake_signaling: tuple[str, dict[str, Any]],
) -> None:
    """Junk from the registry is not permission either."""
    base, control = fake_signaling
    control["devices"] = [{"not_an_id": "x"}]
    auth = AuthState("user@example.com", "jwt-token", OWN_DEVICE, base)

    with patch("app.tunnel.peer_auth.get_auth_state", return_value=auth):
        decision = await RegisteredDeviceVerifier().verify(PeerIdentity(REGISTERED_PEER))

    assert decision.authorized is False


# ============================================================================
# Escape hatch: off by default, deliberate to turn on
# ============================================================================


def test_verification_is_on_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    """The safe path is the default; the permissive one must be chosen."""
    monkeypatch.delenv(ALLOW_UNVERIFIED_ENV_VAR, raising=False)

    assert unverified_peers_allowed() is False
    assert isinstance(build_peer_verifier(), RegisteredDeviceVerifier)


def test_escape_hatch_selects_the_permissive_verifier(monkeypatch: pytest.MonkeyPatch) -> None:
    """Setting the documented env var restores the old behavior."""
    monkeypatch.setenv(ALLOW_UNVERIFIED_ENV_VAR, "1")

    assert unverified_peers_allowed() is True
    assert isinstance(build_peer_verifier(), AllowAllVerifier)


def test_proxy_denies_by_default_and_opens_with_the_hatch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fresh proxy trusts nobody unless the operator opted out."""
    monkeypatch.delenv(ALLOW_UNVERIFIED_ENV_VAR, raising=False)
    assert HTTPProxyHandler().authorized_peer is None

    monkeypatch.setenv(ALLOW_UNVERIFIED_ENV_VAR, "true")
    assert HTTPProxyHandler().authorized_peer is not None


# ============================================================================
# Signaling: an unknown peer never gets an answer
# ============================================================================


async def test_offer_from_unknown_peer_is_never_answered() -> None:
    """The exploit path: any sender_device_id used to get a DataChannel."""
    agent = TunnelAgent(peer_verifier=_DenyingVerifier())

    with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
        with patch.object(agent, "_connect_signaling", new=AsyncMock()):
            with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id=OWN_DEVICE,
                    token="test-token",
                )
                await agent._process_signaling_message(
                    {
                        "type": "offer",
                        "sender_device_id": UNKNOWN_PEER,
                        "payload": {"sdp": "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n", "type": "offer"},
                    }
                )

    assert send.call_count == 0, "an answer was sent to an unauthorized peer"
    assert agent.peer_device_id is None
    assert agent.http_proxy.authorized_peer is None


async def test_offer_from_verified_peer_authorizes_the_proxy() -> None:
    """A verified peer still gets its answer, and unlocks the proxy."""
    agent = TunnelAgent(peer_verifier=AllowAllVerifier())

    with patch("app.tunnel.webrtc_client.aiohttp.ClientSession"):
        with patch.object(agent, "_connect_signaling", new=AsyncMock()):
            with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
                await agent.connect(
                    signal_url="ws://localhost:8000/signal",
                    device_id=OWN_DEVICE,
                    token="test-token",
                )
                await agent._process_signaling_message(
                    {
                        "type": "offer",
                        "sender_device_id": REGISTERED_PEER,
                        "payload": {"sdp": "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n", "type": "offer"},
                    }
                )

    assert send.call_args[0][0]["type"] == "answer"
    assert agent.http_proxy.authorized_peer == REGISTERED_PEER


async def test_relay_connect_request_from_unknown_peer_is_refused() -> None:
    """The relay transport is gated too: no session, no ack."""
    agent = TunnelAgent(peer_verifier=_DenyingVerifier())

    with patch.object(agent, "_send_signaling_message", new=AsyncMock()) as send:
        await agent._handle_connect_request(
            {
                "type": "connect-request-received",
                "from_device_id": UNKNOWN_PEER,
                "preferred_transport": "relay",
                "relay_session_id": "session-1",
            }
        )

    assert send.call_count == 0
    assert agent.relay_sessions == {}


# ============================================================================
# End to end: an unauthorized peer cannot reach the protected local API
# ============================================================================


@pytest.fixture
async def protected_api() -> AsyncGenerator[str, None]:
    """Run a CSRF-protected API on an ephemeral port.

    Yields:
        Base URL of the running server
    """
    api = FastAPI()
    api.add_middleware(
        LocalApiSecurityMiddleware,
        allowed_origins=ALLOWED_ORIGINS,
        require_token=False,
    )
    mutations: list[str] = []

    @api.post("/v1/services/ollama/stop")
    async def stop() -> dict[str, str]:
        mutations.append("stop")
        return {"status": "ok"}

    server = uvicorn.Server(uvicorn.Config(api, host="127.0.0.1", port=0, log_level="error"))
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.02)
    else:  # pragma: no cover - only on a broken event loop
        raise AssertionError("Test server did not start")

    port: int = server.servers[0].sockets[0].getsockname()[1]
    api.state.mutations = mutations
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


def _peer_frame(path: str) -> bytes:
    """Build a peer request frame that spoofs the CSRF header.

    Args:
        path: Request path chosen by the peer

    Returns:
        Serialized request frame
    """
    return serialize_request_head(
        {
            "request_id": 4242,
            "method": "POST",
            "path": path,
            "headers": [
                ("X-Lem-Client", "spoofed"),
                ("Origin", "https://evil.example.com"),
            ],
            "body_follows": False,
        }
    )


async def test_unauthorized_peer_gets_no_credentials_and_no_mutation(
    protected_api: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression for #29: the tunnel no longer lends out its credentials.

    Against the pre-fix code this frame came back 200 with the service stopped.
    """
    monkeypatch.delenv(ALLOW_UNVERIFIED_ENV_VAR, raising=False)
    collector = FrameCollector()
    handler = HTTPProxyHandler(
        local_server_url=protected_api,
        router=RequestRouter(protected_api),
        send_frame=collector.send,
    )
    await handler.start()
    try:
        await handler.handle_request_head(_peer_frame("/v1/services/ollama/stop"))
        await drain(handler, 4242)
    finally:
        await handler.stop()

    response = collector.response_for(4242)
    assert response.status_code == 403
    assert json.loads(response.body) == {"error": GENERIC_PEER_UNAUTHORIZED}


async def test_verified_peer_still_reaches_the_protected_api(protected_api: str) -> None:
    """The counterpart: authorization is what makes remote access work."""
    collector = FrameCollector()
    handler = HTTPProxyHandler(
        local_server_url=protected_api,
        router=RequestRouter(protected_api),
        send_frame=collector.send,
    )
    handler.authorize_peer(REGISTERED_PEER)
    await handler.start()
    try:
        await handler.handle_request_head(_peer_frame("/v1/services/ollama/stop"))
        await drain(handler, 4242)
    finally:
        await handler.stop()

    response = collector.response_for(4242)
    assert response.status_code == 200
    assert json.loads(response.body) == {"status": "ok"}
