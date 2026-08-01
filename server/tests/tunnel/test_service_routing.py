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

"""Service selection over the tunnel: the ``X-Lem-Service`` header.

Two live upstreams run for every test - one standing in for the privileged
local Lem server and one for a Harbor service - so "which target received it"
is answered by what each server actually recorded, not by reading the router's
return value back.

The rule under test is that an unresolvable service id produces
``E_UNKNOWN_SERVICE`` and reaches *neither* upstream. v2 fell through to the
local server, so a mistyped service id arrived at the privileged local API with
the local server's own bearer token attached by the proxy.
"""

import asyncio
import json
from collections.abc import AsyncGenerator

import pytest
import uvicorn
from fastapi import FastAPI, Request, Response

from app.tunnel.errors import TunnelErrorCode
from app.tunnel.http_proxy import PROXY_CONTROLLED_HEADERS
from app.tunnel.router import SERVICE_HEADER, RequestRouter, UnknownServiceError

from .proxy_harness import authorized_handler, send_request


class Recorder:
    """What one stub upstream saw."""

    def __init__(self, label: str) -> None:
        """Initialize empty state.

        Args:
            label: Name this upstream answers with, so a response identifies it
        """
        self.label = label
        self.requests: list[tuple[str, str]] = []
        self.headers: list[dict[str, str]] = []


async def _serve(recorder: Recorder) -> AsyncGenerator[str, None]:
    """Run one stub upstream on an ephemeral port.

    Args:
        recorder: State object the app records into

    Yields:
        Base URL of the running server
    """
    api = FastAPI()

    @api.api_route("/{path:path}", methods=["GET", "POST"])
    async def catch_all(request: Request, path: str) -> Response:
        recorder.requests.append((request.method, "/" + path))
        recorder.headers.append({k.lower(): v for k, v in request.headers.items()})
        return Response(content=recorder.label.encode(), media_type="text/plain")

    server = uvicorn.Server(uvicorn.Config(api, host="127.0.0.1", port=0, log_level="error"))
    task = asyncio.create_task(server.serve())
    for _ in range(200):
        if server.started:
            break
        await asyncio.sleep(0.02)
    else:  # pragma: no cover - only on a broken event loop
        raise AssertionError(f"Stub upstream {recorder.label} did not start")

    port: int = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        await task


@pytest.fixture
async def local_server() -> AsyncGenerator[tuple[str, Recorder], None]:
    """Stub standing in for the privileged local Lem server.

    Yields:
        Base URL and its recorder
    """
    recorder = Recorder("local-server")
    async for base in _serve(recorder):
        yield base, recorder


@pytest.fixture
async def service() -> AsyncGenerator[tuple[str, Recorder], None]:
    """Stub standing in for a running Harbor service.

    Yields:
        Base URL and its recorder
    """
    recorder = Recorder("webui")
    async for base in _serve(recorder):
        yield base, recorder


class TestRouterUnit:
    """The router's own contract, without a transport in the way."""

    def test_no_header_means_the_local_server(self) -> None:
        router = RequestRouter("http://localhost:5142", lambda _sid: "http://127.0.0.1:1")
        assert router.route("/v1/health", []) == "http://localhost:5142"

    def test_header_selects_the_resolved_service(self) -> None:
        router = RequestRouter("http://localhost:5142", lambda _sid: "http://127.0.0.1:33801")
        assert router.route("/api/models", [("X-Lem-Service", "webui")]) == "http://127.0.0.1:33801"

    def test_header_name_is_case_insensitive(self) -> None:
        router = RequestRouter("http://localhost:5142", lambda _sid: "http://127.0.0.1:33801")
        assert router.route("/api/models", [("x-LEM-service", "webui")]) == "http://127.0.0.1:33801"

    def test_unresolvable_service_raises_rather_than_falling_through(self) -> None:
        """The whole point: no silent fall-through to the local server."""
        router = RequestRouter("http://localhost:5142", lambda _sid: None)
        with pytest.raises(UnknownServiceError) as exc_info:
            router.route("/api/models", [("X-Lem-Service", "nosuch")])
        assert exc_info.value.service_id == "nosuch"

    def test_two_selectors_are_not_a_choice_to_make(self) -> None:
        router = RequestRouter("http://localhost:5142", lambda _sid: "http://127.0.0.1:33801")
        with pytest.raises(UnknownServiceError):
            router.route("/x", [("X-Lem-Service", "webui"), ("X-Lem-Service", "ollama")])

    @pytest.mark.parametrize("value", ["", "  ", "../etc", "a/b", "x" * 65, "web ui", ".", ".."])
    def test_malformed_service_ids_are_refused(self, value: str) -> None:
        router = RequestRouter("http://localhost:5142", lambda _sid: "http://127.0.0.1:33801")
        with pytest.raises(UnknownServiceError):
            router.route("/x", [("X-Lem-Service", value)])

    def test_the_selector_is_a_proxy_controlled_header(self) -> None:
        """A peer's value must never reach the app; the proxy strips it."""
        assert SERVICE_HEADER in PROXY_CONTROLLED_HEADERS


class TestRoutingOverTheProxy:
    """End to end through HTTPProxyHandler, asserted at each upstream."""

    async def test_request_with_the_header_reaches_the_service(
        self, local_server: tuple[str, Recorder], service: tuple[str, Recorder]
    ) -> None:
        local_base, local_recorder = local_server
        service_base, service_recorder = service

        handler, collector = authorized_handler(
            local_base, RequestRouter(local_base, lambda _sid: service_base)
        )
        await handler.start()
        try:
            await send_request(
                handler, 1, "GET", "/api/models", headers=[("X-Lem-Service", "webui")]
            )
        finally:
            await handler.stop()

        assert collector.response_for(1).body == b"webui"
        assert service_recorder.requests == [("GET", "/api/models")]
        assert local_recorder.requests == []

    async def test_the_selector_is_stripped_before_forwarding(
        self, local_server: tuple[str, Recorder], service: tuple[str, Recorder]
    ) -> None:
        """The app never sees the routing metadata that selected it."""
        local_base, _ = local_server
        service_base, service_recorder = service

        handler, _collector = authorized_handler(
            local_base, RequestRouter(local_base, lambda _sid: service_base)
        )
        await handler.start()
        try:
            await send_request(
                handler,
                2,
                "GET",
                "/api/models",
                headers=[("X-Lem-Service", "webui"), ("Accept", "application/json")],
            )
        finally:
            await handler.stop()

        seen = service_recorder.headers[0]
        assert SERVICE_HEADER not in seen
        # Positive control: a header that is *not* proxy-controlled did arrive,
        # so the assertion above is reading real forwarded headers.
        assert seen["accept"] == "application/json"

    async def test_no_credentials_are_attached_when_routing_to_a_service(
        self, local_server: tuple[str, Recorder], service: tuple[str, Recorder]
    ) -> None:
        """The local server's token is for the local server only."""
        local_base, _ = local_server
        service_base, service_recorder = service

        handler, _collector = authorized_handler(
            local_base, RequestRouter(local_base, lambda _sid: service_base)
        )
        await handler.start()
        try:
            await send_request(handler, 3, "GET", "/", headers=[("X-Lem-Service", "webui")])
        finally:
            await handler.stop()

        assert "authorization" not in service_recorder.headers[0]
        assert "x-lem-client" not in service_recorder.headers[0]

    async def test_unknown_service_is_502_and_reaches_no_upstream(
        self, local_server: tuple[str, Recorder], service: tuple[str, Recorder]
    ) -> None:
        """A typo must not arrive at the privileged local API."""
        local_base, local_recorder = local_server
        _service_base, service_recorder = service

        handler, collector = authorized_handler(
            local_base, RequestRouter(local_base, lambda _sid: None)
        )
        await handler.start()
        try:
            await send_request(
                handler, 4, "GET", "/v1/services", headers=[("X-Lem-Service", "typo")]
            )
        finally:
            await handler.stop()

        response = collector.response_for(4)
        assert response.status_code == 502
        assert json.loads(response.body) == {"error": "Unknown service"}
        assert response.cancel_reason == int(TunnelErrorCode.E_UNKNOWN_SERVICE)
        assert local_recorder.requests == []
        assert service_recorder.requests == []

    async def test_request_without_the_header_still_reaches_the_local_server(
        self, local_server: tuple[str, Recorder], service: tuple[str, Recorder]
    ) -> None:
        """The control plane the dashboard already depends on is unchanged.

        This is the positive control for the test above: the same handler, the
        same path, no selector - and it does reach an upstream.
        """
        local_base, local_recorder = local_server
        _service_base, service_recorder = service

        handler, collector = authorized_handler(
            local_base, RequestRouter(local_base, lambda _sid: None)
        )
        await handler.start()
        try:
            await send_request(handler, 5, "GET", "/v1/services")
        finally:
            await handler.stop()

        assert collector.response_for(5).body == b"local-server"
        assert local_recorder.requests == [("GET", "/v1/services")]
        assert service_recorder.requests == []
