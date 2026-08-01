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
Tests for the P9 `/v1/health` composition in app.main.

Issue #11 was that health reported a hardcoded `"docker": "ok"` while every
Docker call underneath it was failing. These tests pin the composition across
the four states that matter - both healthy, Docker unreachable, Harbor absent,
both failing - and assert the *reasons* are accurate and actionable, not just
that the status string changed.

Both probes are stubbed, so nothing here needs a Docker daemon or a Harbor
checkout.
"""

from __future__ import annotations

import threading
from typing import Any

import pytest
from fastapi import HTTPException

from app import main
from app.catalog.models import ServiceStatus
from app.config.platform import ARCH, DOCKER_HOST, IS_WSL, OS_TYPE, PLATFORM
from app.drivers.clients.openwebui import OPENWEBUI_SERVICE_ID
from app.drivers.harbor_wrapper import HarborError
from app.drivers.runners.ollama import OLLAMA_SERVICE_ID

DOCKER_DOWN = (
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. "
    "Is the docker daemon running?"
)
HARBOR_ABSENT = (
    "Harbor CLI not usable at /home/u/.lem/harbor/harbor.sh: "
    "[Errno 2] No such file or directory. "
    "Install Harbor (or re-run the Lem installer) and try again."
)


class _Probes:
    """Records how the health handler drove its probes."""

    def __init__(self) -> None:
        self.docker_threads: list[int] = []
        self.harbor_threads: list[int] = []
        self.status_calls: list[str] = []


class _FakeTunnelManager:
    """Stands in for TunnelManager, whose real status needs auth state on disk."""

    def __init__(self, status: dict[str, Any]) -> None:
        self._status = status

    def get_status(self) -> dict[str, Any]:
        return self._status


def _patch_probes(
    monkeypatch: pytest.MonkeyPatch,
    *,
    docker: tuple[bool, str],
    harbor: str | HarborError,
    statuses: dict[str, ServiceStatus] | None = None,
    status_error: HTTPException | None = None,
) -> _Probes:
    """
    Stub every external probe `/v1/health` composes over.

    Args:
        docker: what `probe_docker()` returns - (reachable, version-or-reason)
        harbor: Harbor version string, or a HarborError to raise
        statuses: per-service status for the legacy runner/client rollup
        status_error: raised by every status lookup instead of returning

    Returns:
        A recorder of the calls the handler made.
    """
    probes = _Probes()

    def fake_probe_docker() -> tuple[bool, str]:
        probes.docker_threads.append(threading.get_ident())
        return docker

    def fake_check_harbor_installed() -> str:
        probes.harbor_threads.append(threading.get_ident())
        if isinstance(harbor, HarborError):
            raise harbor
        return harbor

    async def fake_get_service_status(service_id: str) -> ServiceStatus:
        probes.status_calls.append(service_id)
        if status_error is not None:
            raise status_error
        return (statuses or {}).get(service_id, ServiceStatus.STOPPED)

    monkeypatch.setattr(main, "probe_docker", fake_probe_docker)
    monkeypatch.setattr(main, "check_harbor_installed", fake_check_harbor_installed)
    monkeypatch.setattr(main, "get_service_status", fake_get_service_status)
    monkeypatch.setattr(main, "tunnel_manager", None)
    return probes


class TestBothHealthy:
    """Docker up, Harbor installed: `ok`, with both real versions reported."""

    async def test_reports_ok_with_both_versions(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_probes(monkeypatch, docker=(True, "27.3.1"), harbor="0.3.20")

        body = await main.health()

        assert body["status"] == "ok"
        assert body["components"]["docker"] == "ok (v27.3.1)"
        assert body["components"]["harbor"] == "ok (v0.3.20)"

    async def test_rolls_up_the_legacy_runner_and_client(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        probes = _patch_probes(
            monkeypatch,
            docker=(True, "27.3.1"),
            harbor="0.3.20",
            statuses={
                OLLAMA_SERVICE_ID: ServiceStatus.RUNNING,
                OPENWEBUI_SERVICE_ID: ServiceStatus.STOPPED,
            },
        )

        body = await main.health()

        assert body["components"]["runners"] == {OLLAMA_SERVICE_ID: "running"}
        assert body["components"]["clients"] == {"openwebui": "stopped"}
        assert probes.status_calls == [OLLAMA_SERVICE_ID, OPENWEBUI_SERVICE_ID]

    async def test_a_version_free_docker_still_reads_as_ok(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """`probe_docker` reports "unknown" rather than "" when the daemon answers."""
        _patch_probes(monkeypatch, docker=(True, "unknown"), harbor="0.3.20")

        body = await main.health()

        assert body["status"] == "ok"
        assert body["components"]["docker"] == "ok (vunknown)"


class TestDockerUnreachable:
    """The issue #11 case: health must not claim `ok` when Docker is down."""

    async def test_reports_error_not_ok(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_probes(monkeypatch, docker=(False, DOCKER_DOWN), harbor="0.3.20")

        body = await main.health()

        assert body["status"] == "error"

    async def test_docker_component_carries_the_actual_failure_reason(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: this used to be the literal string "ok", unconditionally."""
        _patch_probes(monkeypatch, docker=(False, DOCKER_DOWN), harbor="0.3.20")

        body = await main.health()
        docker_component = body["components"]["docker"]

        assert not docker_component.startswith("ok")
        assert docker_component.startswith("unavailable: ")
        # The reason has to name the endpoint - a misrouted socket is the
        # whole reason P1/P2 exist, and it must be diagnosable from one request.
        assert "unix:///var/run/docker.sock" in docker_component

    async def test_skips_per_service_probes_that_could_only_fail(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        probes = _patch_probes(monkeypatch, docker=(False, DOCKER_DOWN), harbor="0.3.20")

        body = await main.health()

        assert body["components"]["runners"] == {}
        assert body["components"]["clients"] == {}
        assert probes.status_calls == []

    async def test_harbor_is_still_reported_so_one_request_shows_everything(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_probes(monkeypatch, docker=(False, DOCKER_DOWN), harbor="0.3.20")

        body = await main.health()

        assert body["components"]["harbor"] == "ok (v0.3.20)"


class TestHarborAbsent:
    """Docker fine, Harbor missing: degraded, with installer guidance."""

    async def test_reports_degraded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_probes(monkeypatch, docker=(True, "27.3.1"), harbor=HarborError(HARBOR_ABSENT))

        body = await main.health()

        assert body["status"] == "degraded"

    async def test_harbor_component_is_actionable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_probes(monkeypatch, docker=(True, "27.3.1"), harbor=HarborError(HARBOR_ABSENT))

        body = await main.health()
        harbor_component = body["components"]["harbor"]

        assert not harbor_component.startswith("ok")
        # Names the path it tried and tells the user what to do about it.
        assert "harbor.sh" in harbor_component
        assert "installer" in harbor_component

    async def test_docker_and_services_are_still_reported(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Degraded means partially usable - the Docker-backed rollup still runs."""
        _patch_probes(
            monkeypatch,
            docker=(True, "27.3.1"),
            harbor=HarborError(HARBOR_ABSENT),
            statuses={OLLAMA_SERVICE_ID: ServiceStatus.RUNNING},
        )

        body = await main.health()

        assert body["components"]["docker"] == "ok (v27.3.1)"
        assert body["components"]["runners"] == {OLLAMA_SERVICE_ID: "running"}

    async def test_a_hung_harbor_degrades_rather_than_raising(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_probes(
            monkeypatch,
            docker=(True, "27.3.1"),
            harbor=HarborError("Harbor version check timed out after 5 seconds", exit_code=124),
        )

        body = await main.health()

        assert body["status"] == "degraded"
        assert "timed out" in body["components"]["harbor"]


class TestBothFailing:
    """Docker down wins the status, but neither reason may be dropped."""

    async def test_docker_failure_outranks_harbor_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_probes(monkeypatch, docker=(False, DOCKER_DOWN), harbor=HarborError(HARBOR_ABSENT))

        body = await main.health()

        assert body["status"] == "error"

    async def test_both_reasons_survive_into_the_response(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_probes(monkeypatch, docker=(False, DOCKER_DOWN), harbor=HarborError(HARBOR_ABSENT))

        body = await main.health()

        assert "docker daemon" in body["components"]["docker"]
        assert "harbor.sh" in body["components"]["harbor"]

    async def test_no_component_reports_ok_when_nothing_works(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_probes(monkeypatch, docker=(False, DOCKER_DOWN), harbor=HarborError(HARBOR_ABSENT))

        body = await main.health()
        components = body["components"]

        assert not components["docker"].startswith("ok")
        assert not components["harbor"].startswith("ok")
        assert components["runners"] == {}
        assert components["clients"] == {}


class TestLegacyStatusMapping:
    """`_legacy_status` narrows ServiceStatus onto running|stopped|error."""

    @pytest.mark.parametrize(
        ("status", "expected"),
        [
            (ServiceStatus.RUNNING, "running"),
            (ServiceStatus.STOPPED, "stopped"),
            (ServiceStatus.ERROR, "error"),
            # The legacy Runner/Client TS interfaces have no "not_installed".
            (ServiceStatus.NOT_INSTALLED, "stopped"),
        ],
    )
    async def test_maps_onto_the_legacy_vocabulary(
        self, monkeypatch: pytest.MonkeyPatch, status: ServiceStatus, expected: str
    ) -> None:
        _patch_probes(
            monkeypatch,
            docker=(True, "27.3.1"),
            harbor="0.3.20",
            statuses={OLLAMA_SERVICE_ID: status},
        )

        assert await main._legacy_status(OLLAMA_SERVICE_ID) == expected

    async def test_a_failed_status_check_reports_error_instead_of_raising(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A 503 from the status layer must not take the whole health check down."""
        _patch_probes(
            monkeypatch,
            docker=(True, "27.3.1"),
            harbor="0.3.20",
            status_error=HTTPException(status_code=503, detail={"title": "Docker Unavailable"}),
        )

        body = await main.health()

        assert body["components"]["runners"] == {OLLAMA_SERVICE_ID: "error"}
        assert body["components"]["clients"] == {"openwebui": "error"}


class TestPlatformBlock:
    """P9 also reports where Lem thinks it is - a misrouted socket in one request."""

    async def test_reports_the_resolved_platform_and_docker_host(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_probes(monkeypatch, docker=(True, "27.3.1"), harbor="0.3.20")

        platform_block: dict[str, Any] = (await main.health())["platform"]

        assert platform_block["os"] == OS_TYPE
        assert platform_block["arch"] == ARCH
        assert platform_block["platform"] == PLATFORM
        assert platform_block["wsl"] == IS_WSL
        assert platform_block["docker_host"] == DOCKER_HOST

    async def test_the_platform_block_survives_a_total_outage(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """It is most useful precisely when everything else is failing."""
        _patch_probes(monkeypatch, docker=(False, DOCKER_DOWN), harbor=HarborError(HARBOR_ABSENT))

        body = await main.health()

        assert body["platform"]["docker_host"] == DOCKER_HOST

    async def test_tunnel_reports_offline_without_a_manager(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_probes(monkeypatch, docker=(True, "27.3.1"), harbor="0.3.20")

        body = await main.health()

        assert body["components"]["tunnel"] == "offline"

    async def test_tunnel_reports_the_managers_mode(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_probes(monkeypatch, docker=(True, "27.3.1"), harbor="0.3.20")
        monkeypatch.setattr(main, "tunnel_manager", _FakeTunnelManager({"mode": "relay"}))

        body = await main.health()

        assert body["components"]["tunnel"] == "relay"

    async def test_a_manager_without_a_mode_reports_offline(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _patch_probes(monkeypatch, docker=(True, "27.3.1"), harbor="0.3.20")
        monkeypatch.setattr(main, "tunnel_manager", _FakeTunnelManager({"authenticated": False}))

        body = await main.health()

        assert body["components"]["tunnel"] == "offline"


class TestProbesDoNotBlockTheEventLoop:
    """Both probes shell out; both must run via asyncio.to_thread."""

    async def test_docker_and_harbor_probes_run_off_the_event_loop(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        probes = _patch_probes(monkeypatch, docker=(True, "27.3.1"), harbor="0.3.20")
        loop_thread = threading.get_ident()

        await main.health()

        assert len(probes.docker_threads) == 1
        assert len(probes.harbor_threads) == 1
        assert probes.docker_threads[0] != loop_thread
        assert probes.harbor_threads[0] != loop_thread
