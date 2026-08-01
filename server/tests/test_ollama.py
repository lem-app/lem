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
Tests for app.drivers.runners.ollama - the model list/pull driver kept in P6.

The claim these pin is that the retained driver is *non-blocking*: the one
synchronous dependency (`get_service_url`, which shells out to Docker) stays
wrapped in `asyncio.to_thread`, and the HTTP calls go through
`httpx.AsyncClient`. Both are asserted at runtime, not by reading the source.

The network is stubbed with `httpx.MockTransport` and port discovery is
stubbed outright, so nothing here needs a running Ollama or a Docker daemon.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import HTTPException

from app.drivers.runners import ollama
from app.drivers.runners.ollama import (
    OLLAMA_API_TIMEOUT,
    OLLAMA_DEFAULT_URL,
    OLLAMA_SERVICE_ID,
    get_ollama_endpoint,
    list_ollama_models,
    pull_ollama_model,
)

DISCOVERED_URL = "http://127.0.0.1:33821"

# Captured before any test swaps httpx.AsyncClient for the mock-transport
# factory, so "did the driver use an async client?" stays answerable.
REAL_ASYNC_CLIENT = httpx.AsyncClient

Handler = Callable[[httpx.Request], httpx.Response]


class _Calls:
    """Records what the driver did, so the mocks can be asserted against."""

    def __init__(self) -> None:
        self.discovery_ids: list[str] = []
        self.discovery_threads: list[int] = []
        self.requests: list[httpx.Request] = []
        self.clients: list[httpx.AsyncClient] = []
        self.timeouts: list[Any] = []


def _stub_ollama(
    monkeypatch: pytest.MonkeyPatch,
    handler: Handler,
    *,
    service_url: str | None = DISCOVERED_URL,
    discovery_delay: float = 0.0,
) -> _Calls:
    """
    Stub port discovery and the Ollama HTTP endpoint.

    `httpx.AsyncClient` is replaced with a factory that builds a real client
    over a `MockTransport`, so every httpx code path the driver relies on
    (`raise_for_status`, `aiter_lines`, JSON decoding) runs for real while the
    socket never does.

    Args:
        handler: answers each request, or raises to simulate a transport error
        service_url: what `get_service_url` resolves to (None = not running)
        discovery_delay: blocking sleep inside the sync discovery call

    Returns:
        A recorder of the driver's calls.
    """
    calls = _Calls()

    def fake_get_service_url(service_id: str) -> str | None:
        calls.discovery_ids.append(service_id)
        calls.discovery_threads.append(threading.get_ident())
        if discovery_delay:
            time.sleep(discovery_delay)
        return service_url

    def recording_handler(request: httpx.Request) -> httpx.Response:
        calls.requests.append(request)
        return handler(request)

    real_client = REAL_ASYNC_CLIENT

    def factory(**kwargs: Any) -> httpx.AsyncClient:
        calls.timeouts.append(kwargs.get("timeout"))
        kwargs.pop("transport", None)
        client = real_client(transport=httpx.MockTransport(recording_handler), **kwargs)
        calls.clients.append(client)
        return client

    monkeypatch.setattr(ollama, "get_service_url", fake_get_service_url)
    monkeypatch.setattr(httpx, "AsyncClient", factory)
    return calls


def _ok(payload: dict[str, Any]) -> Handler:
    """A handler that answers 200 with a JSON body."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    return handler


def _raises(error: Exception) -> Handler:
    """A handler that fails the transport."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    return handler


def _problem(excinfo: pytest.ExceptionInfo[HTTPException]) -> dict[str, Any]:
    """The RFC7807 body; FastAPI types `detail` as str, Lem always sends a dict."""
    detail = excinfo.value.detail
    assert isinstance(detail, dict), f"expected an RFC7807 body, got {detail!r}"
    return detail


class TestGetOllamaEndpoint:
    """Harbor maps Ollama to a dynamic port, so the port has to be discovered."""

    async def test_returns_the_discovered_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = _stub_ollama(monkeypatch, _ok({}))

        assert await get_ollama_endpoint() == DISCOVERED_URL
        assert calls.discovery_ids == [OLLAMA_SERVICE_ID]

    async def test_falls_back_to_the_default_port_when_ollama_is_not_running(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`get_service_url` returns None when the service is down or Docker is."""
        _stub_ollama(monkeypatch, _ok({}), service_url=None)

        assert await get_ollama_endpoint() == OLLAMA_DEFAULT_URL

    async def test_discovery_runs_off_the_event_loop(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """`get_service_url` is synchronous and shells out to Docker: to_thread it."""
        calls = _stub_ollama(monkeypatch, _ok({}))
        loop_thread = threading.get_ident()

        await get_ollama_endpoint()

        assert len(calls.discovery_threads) == 1
        assert calls.discovery_threads[0] != loop_thread

    async def test_a_slow_discovery_does_not_stall_the_event_loop(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The regression P6 closed: a blocking Docker call froze the whole server."""
        _stub_ollama(monkeypatch, _ok({"models": []}), discovery_delay=0.2)
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            while True:
                await asyncio.sleep(0.01)
                ticks += 1

        beat = asyncio.create_task(ticker())
        try:
            await list_ollama_models()
        finally:
            beat.cancel()

        # ~20 ticks are available during a 0.2s blocking sleep; anything above
        # a couple proves the loop kept running while Docker was queried.
        assert ticks >= 3


class TestListOllamaModels:
    """GET /api/tags against the discovered endpoint."""

    async def test_returns_the_models(self, monkeypatch: pytest.MonkeyPatch) -> None:
        models = [
            {"name": "llama3.2:1b", "size": 1321098329, "digest": "baf6a", "modified_at": "x"},
            {"name": "qwen2.5:3b", "size": 1929900000, "digest": "357c5", "modified_at": "y"},
        ]
        _stub_ollama(monkeypatch, _ok({"models": models}))

        assert await list_ollama_models() == models

    async def test_a_payload_without_models_is_an_empty_list(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub_ollama(monkeypatch, _ok({}))

        assert await list_ollama_models() == []

    async def test_calls_the_tags_endpoint_on_the_discovered_port(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _stub_ollama(monkeypatch, _ok({"models": []}))

        await list_ollama_models()

        assert len(calls.requests) == 1
        assert calls.requests[0].method == "GET"
        assert str(calls.requests[0].url) == f"{DISCOVERED_URL}/api/tags"

    async def test_uses_an_async_client(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """P6's claim: the retained driver talks HTTP without blocking the loop."""
        calls = _stub_ollama(monkeypatch, _ok({"models": []}))

        await list_ollama_models()

        assert len(calls.clients) == 1
        assert isinstance(calls.clients[0], REAL_ASYNC_CLIENT)

    async def test_a_down_ollama_is_a_503_that_says_what_to_do(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub_ollama(monkeypatch, _raises(httpx.ConnectError("connection refused")))

        with pytest.raises(HTTPException) as excinfo:
            await list_ollama_models()

        assert excinfo.value.status_code == 503
        assert _problem(excinfo)["title"] == "Ollama API Unavailable"
        assert "Start Ollama first" in _problem(excinfo)["detail"]

    async def test_an_api_error_status_is_a_503_naming_the_status(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "internal"})

        _stub_ollama(monkeypatch, handler)

        with pytest.raises(HTTPException) as excinfo:
            await list_ollama_models()

        assert excinfo.value.status_code == 503
        assert _problem(excinfo)["title"] == "Ollama API Error"
        assert "500" in _problem(excinfo)["detail"]

    async def test_an_unexpected_transport_error_is_still_a_503(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Never a raw traceback out of an endpoint - issue #11's other half."""
        _stub_ollama(monkeypatch, _raises(httpx.ReadError("peer reset")))

        with pytest.raises(HTTPException) as excinfo:
            await list_ollama_models()

        assert excinfo.value.status_code == 503
        assert "peer reset" in _problem(excinfo)["detail"]


class TestPullOllamaModel:
    """POST /api/pull, consuming the streamed progress objects."""

    @staticmethod
    def _progress(*objects: dict[str, Any]) -> Handler:
        body = "\n".join(json.dumps(obj) for obj in objects) + "\n"

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=body.encode())

        return handler

    async def test_reports_success_with_the_final_progress_object(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub_ollama(
            monkeypatch,
            self._progress({"status": "pulling manifest"}, {"status": "success"}),
        )

        result = await pull_ollama_model("llama3.2:1b")

        assert result["status"] == "ok"
        assert result["model_ref"] == "llama3.2:1b"
        assert result["details"] == {"status": "success"}

    async def test_posts_the_model_name_to_the_pull_endpoint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _stub_ollama(monkeypatch, self._progress({"status": "success"}))

        await pull_ollama_model("qwen2.5:3b")

        assert len(calls.requests) == 1
        request = calls.requests[0]
        assert request.method == "POST"
        assert str(request.url) == f"{DISCOVERED_URL}/api/pull"
        assert json.loads(request.content) == {"name": "qwen2.5:3b"}

    async def test_blank_and_unparseable_progress_lines_are_skipped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A malformed progress line must not fail an otherwise successful pull."""

        def handler(request: httpx.Request) -> httpx.Response:
            body = '{"status": "pulling"}\n\n   \nnot json at all\n{"status": "success"}\n'
            return httpx.Response(200, content=body.encode())

        _stub_ollama(monkeypatch, handler)

        result = await pull_ollama_model("llama3.2:1b")

        assert result["status"] == "ok"
        assert result["details"] == {"status": "success"}

    async def test_uses_an_async_client_with_the_long_pull_timeout(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _stub_ollama(monkeypatch, self._progress({"status": "success"}))

        await pull_ollama_model("llama3.2:1b")

        assert isinstance(calls.clients[0], REAL_ASYNC_CLIENT)
        assert calls.timeouts == [OLLAMA_API_TIMEOUT]

    async def test_an_empty_model_ref_is_a_400_and_never_touches_the_network(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls = _stub_ollama(monkeypatch, self._progress({"status": "success"}))

        with pytest.raises(HTTPException) as excinfo:
            await pull_ollama_model("")

        assert excinfo.value.status_code == 400
        assert _problem(excinfo)["title"] == "Invalid Model Reference"
        assert calls.requests == []
        assert calls.discovery_ids == []

    async def test_a_down_ollama_is_a_503_that_says_what_to_do(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub_ollama(monkeypatch, _raises(httpx.ConnectError("connection refused")))

        with pytest.raises(HTTPException) as excinfo:
            await pull_ollama_model("llama3.2:1b")

        assert excinfo.value.status_code == 503
        assert "Start Ollama first" in _problem(excinfo)["detail"]

    async def test_a_slow_pull_is_a_504_naming_the_budget(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A timeout is not "unavailable" - large models legitimately need longer."""
        _stub_ollama(monkeypatch, _raises(httpx.ReadTimeout("timed out")))

        with pytest.raises(HTTPException) as excinfo:
            await pull_ollama_model("llama3.3:70b")

        assert excinfo.value.status_code == 504
        assert _problem(excinfo)["title"] == "Ollama Pull Timeout"
        assert str(OLLAMA_API_TIMEOUT) in _problem(excinfo)["detail"]

    async def test_an_api_error_surfaces_ollamas_own_message(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"error": "model 'nope:1b' not found"})

        _stub_ollama(monkeypatch, handler)

        with pytest.raises(HTTPException) as excinfo:
            await pull_ollama_model("nope:1b")

        assert excinfo.value.status_code == 503
        assert _problem(excinfo)["detail"] == "model 'nope:1b' not found"

    async def test_an_api_error_without_a_json_body_still_reports_503(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(502, content=b"<html>bad gateway</html>")

        _stub_ollama(monkeypatch, handler)

        with pytest.raises(HTTPException) as excinfo:
            await pull_ollama_model("llama3.2:1b")

        assert excinfo.value.status_code == 503
        assert _problem(excinfo)["title"] == "Ollama API Error"

    async def test_an_unexpected_transport_error_is_still_a_503(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _stub_ollama(monkeypatch, _raises(httpx.ReadError("peer reset")))

        with pytest.raises(HTTPException) as excinfo:
            await pull_ollama_model("llama3.2:1b")

        assert excinfo.value.status_code == 503
        assert "peer reset" in _problem(excinfo)["detail"]
