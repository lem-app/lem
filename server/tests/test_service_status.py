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

"""Tests for app.services.status (Docker queries, container/service mapping)."""

from __future__ import annotations

import json
import subprocess

import pytest
from fastapi import HTTPException

from app.catalog.models import ServiceCategory, ServiceDefinition, ServiceStatus
from app.services import status as status_mod

# A realistic slice of the Harbor catalog: hyphenated IDs and shared prefixes
CATALOG_IDS = frozenset(
    {"ollama", "webui", "mcp-inspector", "metamcp", "dify", "agent", "bench", "speaches"}
)


def _definition(
    service_id: str, image: str = "", container_port: int | None = None
) -> ServiceDefinition:
    return ServiceDefinition(
        id=service_id,
        name=service_id,
        category=ServiceCategory.SATELLITE,
        description="test",
        container_port=container_port,
        image=image,
    )


class TestContainerToServiceId:
    """P4: hyphenated service IDs must not be truncated at the first hyphen."""

    @pytest.mark.parametrize(
        ("container", "expected"),
        [
            ("harbor.ollama", "ollama"),
            ("harbor.webui", "webui"),
            # Regression: used to resolve to "mcp", so mcp-inspector reported
            # not_installed while it was running.
            ("harbor.mcp-inspector", "mcp-inspector"),
            # Known suffixes still resolve to the parent service
            ("harbor.ollama-init", "ollama"),
            ("harbor.speaches-init", "speaches"),
            ("harbor.dify-api", "dify"),
            ("harbor.dify-worker", "dify"),
            ("harbor.metamcp-postgres", "metamcp"),
        ],
    )
    def test_maps_container_to_catalog_id(self, container: str, expected: str) -> None:
        assert status_mod.container_to_service_id(container, CATALOG_IDS) == expected

    def test_unknown_container_is_ignored(self) -> None:
        assert status_mod.container_to_service_id("harbor.notaservice", CATALOG_IDS) is None

    def test_non_harbor_container_is_ignored(self) -> None:
        assert status_mod.container_to_service_id("my-postgres", CATALOG_IDS) is None

    def test_longest_match_wins_over_shared_prefix(self) -> None:
        """"metamcp" must not swallow a hypothetical "metamcp-sse" service."""
        ids = {"metamcp", "metamcp-sse"}
        assert status_mod.container_to_service_id("harbor.metamcp-sse", ids) == "metamcp-sse"
        assert status_mod.container_to_service_id("harbor.metamcp", ids) == "metamcp"


class TestResolveServiceImage:
    """P3/P5: only exact image references count."""

    def test_resolved_reference_is_normalized(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            status_mod, "get_service_definition", lambda _id: _definition("aider", "user/aider")
        )
        assert status_mod.resolve_service_image("aider") == "user/aider:latest"

    def test_tagged_reference_is_kept(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            status_mod,
            "get_service_definition",
            lambda _id: _definition("ollama", "ollama/ollama:latest"),
        )
        assert status_mod.resolve_service_image("ollama") == "ollama/ollama:latest"

    def test_registry_port_is_not_mistaken_for_a_tag(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            status_mod,
            "get_service_definition",
            lambda _id: _definition("local", "localhost:5000/thing"),
        )
        assert status_mod.resolve_service_image("local") == "localhost:5000/thing:latest"

    def test_unresolved_variable_yields_no_image(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            status_mod,
            "get_service_definition",
            lambda _id: _definition("bolt", "${HARBOR_BOLT_IMAGE}:latest"),
        )
        assert status_mod.resolve_service_image("bolt") is None

    def test_build_only_service_yields_no_image(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            status_mod, "get_service_definition", lambda _id: _definition("agent", "")
        )
        assert status_mod.resolve_service_image("agent") is None


class TestImageIsInstalled:
    """P3 regression: substring matching used to claim unrelated images."""

    def test_unrelated_image_does_not_count_as_installed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            status_mod, "get_service_definition", lambda _id: _definition("agent", "")
        )
        local = {"openhands/agent-server:latest", "ghcr.io/some/agentic-thing:1.0"}

        assert status_mod._image_is_installed("agent", local) is False

    def test_exact_image_counts_as_installed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            status_mod,
            "get_service_definition",
            lambda _id: _definition("ollama", "ollama/ollama:latest"),
        )
        assert status_mod._image_is_installed("ollama", {"ollama/ollama:latest"}) is True

    def test_locally_built_service_matches_compose_project_image(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            status_mod, "get_service_definition", lambda _id: _definition("agent", "")
        )
        assert status_mod._image_is_installed("agent", {"harbor-agent:latest"}) is True


class _DockerRecorder:
    """Stand-in for status._run_docker that records the commands it is given."""

    def __init__(self, ps_json: str = "", images: str = "") -> None:
        self.calls: list[list[str]] = []
        self._ps_json = ps_json
        self._images = images

    def __call__(self, args: list[str]) -> str:
        self.calls.append(args)
        if args[0] == "ps":
            if "{{.Names}}" in args:
                names = [
                    json.loads(line)["Names"] for line in self._ps_json.splitlines() if line.strip()
                ]
                return "\n".join(names)
            return self._ps_json
        if args[0] == "images":
            return self._images
        return ""


def _ps_line(name: str, state: str = "running", ports: str = "") -> str:
    return json.dumps({"Names": name, "State": state, "Ports": ports})


class TestDockerQuerying:
    """P2/P5: one batched query, and Docker failures are surfaced not swallowed."""

    def test_exact_container_wins_over_sidecar(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _DockerRecorder(
            ps_json="\n".join(
                [
                    _ps_line("harbor.ollama-init", state="exited"),
                    _ps_line("harbor.ollama", state="running", ports="0.0.0.0:33821->11434/tcp"),
                ]
            )
        )
        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))

        containers = status_mod._get_containers()

        assert containers["ollama"]["status"] == "running"

    def test_hyphenated_service_is_reported_running(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _DockerRecorder(ps_json=_ps_line("harbor.mcp-inspector"))
        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))

        assert status_mod._get_containers() == {
            "mcp-inspector": {"status": "running", "ports": ""}
        }

    async def test_status_of_hyphenated_service(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _DockerRecorder(ps_json=_ps_line("harbor.mcp-inspector"))
        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))

        assert await status_mod.get_service_status("mcp-inspector") == ServiceStatus.RUNNING

    async def test_unreachable_docker_raises_503_instead_of_reporting_empty(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: failures used to return {} - i.e. "nothing installed"."""

        def _explode(_args: list[str]) -> str:
            raise status_mod.DockerUnavailableError("Cannot connect to the Docker daemon")

        monkeypatch.setattr(status_mod, "_run_docker", _explode)

        with pytest.raises(HTTPException) as exc_info:
            await status_mod.get_service_status("ollama")

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail["title"] == "Docker Unavailable"

    async def test_listing_all_services_uses_two_docker_calls(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: this used to run one `docker images` per service."""
        definitions = [_definition(service_id) for service_id in sorted(CATALOG_IDS)]
        recorder = _DockerRecorder(ps_json=_ps_line("harbor.ollama"), images="ollama/ollama:latest")

        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))
        monkeypatch.setattr(status_mod, "get_all_services", lambda: definitions)
        monkeypatch.setattr(status_mod, "get_service_definition", lambda sid: _definition(sid))

        services = await status_mod.get_all_services_with_status()

        assert len(services) == len(definitions)
        assert [call[0] for call in recorder.calls] == ["ps", "images"]

    def test_list_service_containers_only_returns_that_service(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder = _DockerRecorder(
            ps_json="\n".join(
                [
                    _ps_line("harbor.dify-api"),
                    _ps_line("harbor.dify-worker"),
                    _ps_line("harbor.ollama"),
                ]
            )
        )
        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))

        assert status_mod.list_service_containers("dify") == [
            "harbor.dify-api",
            "harbor.dify-worker",
        ]

    def test_probe_docker_reports_failure_reason(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _explode(_args: list[str]) -> str:
            raise status_mod.DockerUnavailableError("docker CLI not found")

        monkeypatch.setattr(status_mod, "_run_docker", _explode)

        ok, detail = status_mod.probe_docker()

        assert ok is False
        assert "docker CLI not found" in detail

    def test_probe_docker_reports_version(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(status_mod, "_run_docker", lambda _args: "27.3.1\n")

        assert status_mod.probe_docker() == (True, "27.3.1")


class TestRunDocker:
    """P2: every way Docker can be unusable becomes one explicit error type."""

    def test_missing_docker_cli_is_reported(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _missing(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            raise FileNotFoundError("docker")

        monkeypatch.setattr(status_mod.subprocess, "run", _missing)

        with pytest.raises(status_mod.DockerUnavailableError, match="not found on PATH"):
            status_mod._run_docker(["ps"])

    def test_hung_daemon_is_reported(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def _hang(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            raise subprocess.TimeoutExpired(cmd="docker ps", timeout=10)

        monkeypatch.setattr(status_mod.subprocess, "run", _hang)

        with pytest.raises(status_mod.DockerUnavailableError, match="timed out"):
            status_mod._run_docker(["ps"])

    def test_daemon_error_includes_stderr_and_endpoint(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _fail(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
            raise subprocess.CalledProcessError(
                returncode=1, cmd="docker ps", stderr="Cannot connect to the Docker daemon"
            )

        monkeypatch.setattr(status_mod.subprocess, "run", _fail)

        with pytest.raises(status_mod.DockerUnavailableError) as exc_info:
            status_mod._run_docker(["ps"])

        assert "Cannot connect to the Docker daemon" in str(exc_info.value)
        assert "DOCKER_HOST=" in str(exc_info.value)

    def test_docker_env_carries_the_platform_endpoint(self) -> None:
        assert status_mod.get_docker_env()["DOCKER_HOST"] == status_mod.DOCKER_HOST


class TestParseHostPort:
    """Port discovery from `docker ps` output."""

    @pytest.mark.parametrize(
        ("ports", "container_port", "expected"),
        [
            ("0.0.0.0:33821->11434/tcp", 11434, 33821),
            ("[::]:33891->33891/tcp", None, 33891),
            ("0.0.0.0:33801->8080/tcp, [::]:33801->8080/tcp", 8080, 33801),
            # The requested container port wins over the first mapping listed
            ("0.0.0.0:5000->5000/tcp, 0.0.0.0:9000->9090/tcp", 9090, 9000),
            ("", None, None),
            ("11434/tcp", 11434, None),
        ],
    )
    def test_parses_host_port(
        self, ports: str, container_port: int | None, expected: int | None
    ) -> None:
        assert status_mod._parse_host_port(ports, container_port) == expected


class TestGetServiceUrl:
    """The synchronous lookup used by tunnel routing must never raise."""

    def test_running_service_resolves_to_a_local_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _DockerRecorder(
            ps_json=_ps_line("harbor.webui", ports="0.0.0.0:33801->8080/tcp")
        )
        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))
        monkeypatch.setattr(
            status_mod, "get_service_definition", lambda sid: _definition(sid, container_port=8080)
        )

        assert status_mod.get_service_url("webui") == "http://127.0.0.1:33801"

    def test_stopped_service_has_no_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        recorder = _DockerRecorder(ps_json=_ps_line("harbor.webui", state="exited"))
        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))

        assert status_mod.get_service_url("webui") is None

    def test_unreachable_docker_yields_none_rather_than_raising(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def _explode(_args: list[str]) -> str:
            raise status_mod.DockerUnavailableError("Cannot connect to the Docker daemon")

        monkeypatch.setattr(status_mod, "_run_docker", _explode)

        assert status_mod.get_service_url("webui") is None


class TestStatusMapping:
    """Docker container states collapse onto the four ServiceStatus values."""

    @pytest.mark.parametrize(
        ("docker_state", "expected"),
        [
            ("running", ServiceStatus.RUNNING),
            ("exited", ServiceStatus.STOPPED),
            ("created", ServiceStatus.STOPPED),
            ("paused", ServiceStatus.STOPPED),
            ("dead", ServiceStatus.STOPPED),
            ("restarting", ServiceStatus.ERROR),
            ("", ServiceStatus.ERROR),
        ],
    )
    def test_maps_docker_state(self, docker_state: str, expected: ServiceStatus) -> None:
        assert status_mod._status_from_container(docker_state) == expected

    async def test_image_present_but_no_container_is_stopped(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: this used to report not_installed after a stop."""
        recorder = _DockerRecorder(ps_json="", images="ollama/ollama:latest")
        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))
        monkeypatch.setattr(
            status_mod,
            "get_service_definition",
            lambda sid: _definition(sid, "ollama/ollama:latest"),
        )

        assert await status_mod.get_service_status("ollama") == ServiceStatus.STOPPED

    async def test_no_image_and_no_container_is_not_installed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder = _DockerRecorder(ps_json="", images="")
        monkeypatch.setattr(status_mod, "_run_docker", recorder)
        monkeypatch.setattr(status_mod, "scan_harbor_services", lambda: dict.fromkeys(CATALOG_IDS))
        monkeypatch.setattr(
            status_mod,
            "get_service_definition",
            lambda sid: _definition(sid, "ollama/ollama:latest"),
        )

        assert await status_mod.get_service_status("ollama") == ServiceStatus.NOT_INSTALLED
