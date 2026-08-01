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

"""Tests for app.services.lifecycle (service removal, Harbor error paths)."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.catalog.models import ServiceStatus
from app.jobs.models import Job, JobStatus, JobType
from app.services import lifecycle


def _job(service_id: str, job_type: JobType = JobType.REMOVE) -> Job:
    now = datetime.now(UTC)
    return Job(
        id="job-1",
        type=job_type,
        service_id=service_id,
        status=JobStatus.RUNNING,
        created_at=now,
        updated_at=now,
    )


class _DockerRecorder:
    """Stand-in for lifecycle._run_docker that records commands."""

    def __init__(self, results: dict[str, tuple[int, str]] | None = None) -> None:
        self.calls: list[list[str]] = []
        self._results = results or {}

    async def __call__(self, args: list[str], timeout: int) -> tuple[int, str]:
        self.calls.append(args)
        return self._results.get(args[0], (0, ""))

    @property
    def removed_images(self) -> list[str]:
        return [args[1] for args in self.calls if args[0] == "rmi"]

    @property
    def removed_containers(self) -> list[str]:
        return [args[-1] for args in self.calls if args[0] == "rm"]


@pytest.fixture
def remove_harness(monkeypatch: pytest.MonkeyPatch) -> _DockerRecorder:
    """Wire _handle_remove_job up to recorders instead of Harbor and Docker."""
    recorder = _DockerRecorder()

    async def _noop_harbor(args: list[str], timeout: int, service_id: str) -> tuple[int, str, str]:
        return 0, "", ""

    monkeypatch.setattr(lifecycle, "_run_harbor_command", _noop_harbor)
    monkeypatch.setattr(lifecycle, "_run_docker", recorder)
    monkeypatch.setattr(lifecycle, "update_job_progress", lambda *args, **kwargs: None)
    return recorder


class TestRemoveJobImageSafety:
    """P3: removal must never delete an image it did not positively identify."""

    async def test_removing_agent_does_not_touch_unrelated_images(
        self, monkeypatch: pytest.MonkeyPatch, remove_harness: _DockerRecorder
    ) -> None:
        """
        Regression: `agent` builds its image locally, so the old unanchored
        substring search matched openhands/agent-server and deleted it.
        """
        monkeypatch.setattr(lifecycle, "resolve_service_image", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "list_service_containers", lambda _sid: ["harbor.agent"])

        await lifecycle._handle_remove_job(_job("agent"))

        assert remove_harness.removed_images == []
        assert remove_harness.removed_containers == ["harbor.agent"]

    async def test_removes_only_the_exact_catalog_image(
        self, monkeypatch: pytest.MonkeyPatch, remove_harness: _DockerRecorder
    ) -> None:
        monkeypatch.setattr(lifecycle, "resolve_service_image", lambda _sid: "ollama/ollama:latest")
        monkeypatch.setattr(
            lifecycle,
            "list_service_containers",
            lambda _sid: ["harbor.ollama", "harbor.ollama-init"],
        )

        await lifecycle._handle_remove_job(_job("ollama"))

        assert remove_harness.removed_images == ["ollama/ollama:latest"]
        assert remove_harness.removed_containers == ["harbor.ollama", "harbor.ollama-init"]

    async def test_removes_every_container_of_the_service(
        self, monkeypatch: pytest.MonkeyPatch, remove_harness: _DockerRecorder
    ) -> None:
        """harbor.<id> is not the only container a service owns."""
        monkeypatch.setattr(lifecycle, "resolve_service_image", lambda _sid: None)
        monkeypatch.setattr(
            lifecycle,
            "list_service_containers",
            lambda _sid: ["harbor.dify-api", "harbor.dify-db", "harbor.dify-worker"],
        )

        await lifecycle._handle_remove_job(_job("dify"))

        assert remove_harness.removed_containers == [
            "harbor.dify-api",
            "harbor.dify-db",
            "harbor.dify-worker",
        ]


class TestRemoveJobFailureReporting:
    """P3: return codes were never checked, yet the job reported success."""

    async def test_failed_container_removal_fails_the_job(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder = _DockerRecorder(results={"rm": (1, "permission denied")})

        async def _noop_harbor(
            args: list[str], timeout: int, service_id: str
        ) -> tuple[int, str, str]:
            return 0, "", ""

        monkeypatch.setattr(lifecycle, "_run_harbor_command", _noop_harbor)
        monkeypatch.setattr(lifecycle, "_run_docker", recorder)
        monkeypatch.setattr(lifecycle, "update_job_progress", lambda *args, **kwargs: None)
        monkeypatch.setattr(lifecycle, "resolve_service_image", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "list_service_containers", lambda _sid: ["harbor.ollama"])

        with pytest.raises(RuntimeError, match="permission denied"):
            await lifecycle._handle_remove_job(_job("ollama"))

    async def test_already_absent_container_is_not_a_failure(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder = _DockerRecorder(results={"rm": (1, "Error: No such container: harbor.ollama")})

        async def _noop_harbor(
            args: list[str], timeout: int, service_id: str
        ) -> tuple[int, str, str]:
            return 0, "", ""

        monkeypatch.setattr(lifecycle, "_run_harbor_command", _noop_harbor)
        monkeypatch.setattr(lifecycle, "_run_docker", recorder)
        monkeypatch.setattr(lifecycle, "update_job_progress", lambda *args, **kwargs: None)
        monkeypatch.setattr(lifecycle, "resolve_service_image", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "list_service_containers", lambda _sid: ["harbor.ollama"])

        await lifecycle._handle_remove_job(_job("ollama"))

    async def test_failed_image_removal_fails_the_job(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        recorder = _DockerRecorder(results={"rmi": (1, "image is being used by running container")})

        async def _noop_harbor(
            args: list[str], timeout: int, service_id: str
        ) -> tuple[int, str, str]:
            return 0, "", ""

        monkeypatch.setattr(lifecycle, "_run_harbor_command", _noop_harbor)
        monkeypatch.setattr(lifecycle, "_run_docker", recorder)
        monkeypatch.setattr(lifecycle, "update_job_progress", lambda *args, **kwargs: None)
        monkeypatch.setattr(lifecycle, "resolve_service_image", lambda _sid: "ollama/ollama:latest")
        monkeypatch.setattr(lifecycle, "list_service_containers", lambda _sid: [])

        with pytest.raises(RuntimeError, match="being used"):
            await lifecycle._handle_remove_job(_job("ollama"))


class _HarborRecorder:
    """Stand-in for lifecycle._run_harbor_command that records invocations."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def __call__(
        self, args: list[str], timeout: int, service_id: str
    ) -> tuple[int, str, str]:
        self.calls.append(args)
        return 0, "", ""


class TestStartStop:
    """Start/stop are idempotent and never shell out when there is nothing to do."""

    async def test_starting_an_uninstalled_service_is_rejected(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        harbor = _HarborRecorder()
        monkeypatch.setattr(lifecycle, "_require_service", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "_run_harbor_command", harbor)

        async def _status(_sid: str) -> ServiceStatus:
            return ServiceStatus.NOT_INSTALLED

        monkeypatch.setattr(lifecycle, "get_service_status", _status)

        with pytest.raises(HTTPException) as exc_info:
            await lifecycle.start_service("ollama")

        assert exc_info.value.status_code == 400
        assert harbor.calls == []

    async def test_starting_a_running_service_is_a_no_op(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        harbor = _HarborRecorder()
        monkeypatch.setattr(lifecycle, "_require_service", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "_run_harbor_command", harbor)

        async def _status(_sid: str) -> ServiceStatus:
            return ServiceStatus.RUNNING

        monkeypatch.setattr(lifecycle, "get_service_status", _status)

        assert await lifecycle.start_service("ollama") == {"status": "ok"}
        assert harbor.calls == []

    async def test_starting_a_stopped_service_runs_harbor_up(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        harbor = _HarborRecorder()
        monkeypatch.setattr(lifecycle, "_require_service", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "_run_harbor_command", harbor)

        async def _status(_sid: str) -> ServiceStatus:
            return ServiceStatus.STOPPED

        monkeypatch.setattr(lifecycle, "get_service_status", _status)

        assert await lifecycle.start_service("ollama") == {"status": "ok"}
        assert harbor.calls == [["up", "--no-defaults", "ollama"]]

    async def test_stopping_an_already_stopped_service_is_a_no_op(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        harbor = _HarborRecorder()
        monkeypatch.setattr(lifecycle, "_require_service", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "_run_harbor_command", harbor)

        async def _status(_sid: str) -> ServiceStatus:
            return ServiceStatus.STOPPED

        monkeypatch.setattr(lifecycle, "get_service_status", _status)

        assert await lifecycle.stop_service("ollama") == {"status": "ok"}
        assert harbor.calls == []

    async def test_stopping_a_running_service_runs_harbor_down(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        harbor = _HarborRecorder()
        monkeypatch.setattr(lifecycle, "_require_service", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "_run_harbor_command", harbor)

        async def _status(_sid: str) -> ServiceStatus:
            return ServiceStatus.RUNNING

        monkeypatch.setattr(lifecycle, "get_service_status", _status)

        assert await lifecycle.stop_service("ollama") == {"status": "ok"}
        assert harbor.calls == [["down", "ollama"]]

    async def test_unknown_service_is_404(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(lifecycle, "get_service_definition", lambda _sid: None)

        with pytest.raises(HTTPException) as exc_info:
            await lifecycle.start_service("nope")

        assert exc_info.value.status_code == 404


class TestInstallJob:
    """Dependencies are installed before the service that needs them."""

    async def test_missing_dependency_is_installed_first(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        harbor = _HarborRecorder()
        monkeypatch.setattr(lifecycle, "_run_harbor_command", harbor)
        monkeypatch.setattr(lifecycle, "update_job_progress", lambda *args, **kwargs: None)
        monkeypatch.setattr(lifecycle, "get_service_definition", lambda sid: object())
        monkeypatch.setattr(lifecycle, "get_service_dependencies", lambda _sid: ["ollama"])

        async def _status(_sid: str) -> ServiceStatus:
            return ServiceStatus.NOT_INSTALLED

        monkeypatch.setattr(lifecycle, "get_service_status", _status)

        await lifecycle._handle_install_job(_job("webui", JobType.INSTALL))

        assert harbor.calls == [
            ["up", "--no-defaults", "ollama"],
            ["up", "--no-defaults", "webui"],
        ]

    async def test_satisfied_dependency_is_not_reinstalled(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        harbor = _HarborRecorder()
        monkeypatch.setattr(lifecycle, "_run_harbor_command", harbor)
        monkeypatch.setattr(lifecycle, "update_job_progress", lambda *args, **kwargs: None)
        monkeypatch.setattr(lifecycle, "get_service_definition", lambda sid: object())
        monkeypatch.setattr(lifecycle, "get_service_dependencies", lambda _sid: ["ollama"])

        async def _status(_sid: str) -> ServiceStatus:
            return ServiceStatus.RUNNING

        monkeypatch.setattr(lifecycle, "get_service_status", _status)

        await lifecycle._handle_install_job(_job("webui", JobType.INSTALL))

        assert harbor.calls == [["up", "--no-defaults", "webui"]]

    async def test_unknown_service_fails_the_job(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(lifecycle, "get_service_definition", lambda _sid: None)

        with pytest.raises(ValueError, match="Service not found"):
            await lifecycle._handle_install_job(_job("nope", JobType.INSTALL))


class TestHarborAbsent:
    """P8: a missing Harbor CLI must be an actionable 503, not a raw 500."""

    async def test_missing_harbor_cli_returns_actionable_503(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Regression: this used to be a bare FileNotFoundError 500."""
        monkeypatch.setattr(lifecycle, "HARBOR_SCRIPT", tmp_path / "nope" / "harbor.sh")

        with pytest.raises(HTTPException) as exc_info:
            await lifecycle._run_harbor_command(["up", "ollama"], 5, "ollama")

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail["type"] == "https://lem.gg/errors/harbor-not-installed"
        assert "harbor.sh" in exc_info.value.detail["detail"]

    async def test_non_executable_harbor_cli_returns_503(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        script = tmp_path / "harbor.sh"
        script.write_text("#!/bin/sh\nexit 0\n")
        script.chmod(0o644)  # present but not executable
        monkeypatch.setattr(lifecycle, "HARBOR_SCRIPT", script)

        with pytest.raises(HTTPException) as exc_info:
            await lifecycle._run_harbor_command(["up", "ollama"], 5, "ollama")

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail["title"] == "Harbor CLI Not Available"

    async def test_failing_harbor_command_reports_stderr(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        script = tmp_path / "harbor.sh"
        script.write_text("#!/bin/sh\necho 'compose not found' >&2\nexit 3\n")
        script.chmod(0o755)
        monkeypatch.setattr(lifecycle, "HARBOR_SCRIPT", script)

        with pytest.raises(HTTPException) as exc_info:
            await lifecycle._run_harbor_command(["up", "ollama"], 5, "ollama")

        assert exc_info.value.status_code == 503
        assert exc_info.value.detail["type"] == "https://lem.gg/errors/harbor-command-failed"
        assert "compose not found" in exc_info.value.detail["stderr"]

    async def test_hanging_harbor_command_times_out_with_504(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        script = tmp_path / "harbor.sh"
        script.write_text("#!/bin/sh\nsleep 30\n")
        script.chmod(0o755)
        monkeypatch.setattr(lifecycle, "HARBOR_SCRIPT", script)

        with pytest.raises(HTTPException) as exc_info:
            await lifecycle._run_harbor_command(["up", "ollama"], 1, "ollama")

        assert exc_info.value.status_code == 504
