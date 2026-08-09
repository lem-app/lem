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

"""Tests for app.config.platform (platform + Docker endpoint detection)."""

from __future__ import annotations

import platform
from pathlib import Path

import pytest

from app.config import platform as platform_config


class TestGetPlatform:
    """PLATFORM detection from platform.system()."""

    def test_darwin_is_macos(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "system", lambda: "Darwin")
        assert platform_config.get_platform() == "macos"

    def test_linux_is_linux(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "system", lambda: "Linux")
        assert platform_config.get_platform() == "linux"

    def test_native_windows_is_rejected_with_wsl_guidance(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(platform, "system", lambda: "Windows")

        with pytest.raises(RuntimeError, match="WSL2"):
            platform_config.get_platform()

    def test_unknown_platform_is_rejected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "system", lambda: "Haiku")

        with pytest.raises(RuntimeError, match="Unsupported platform: Haiku"):
            platform_config.get_platform()


class TestIsWsl:
    """WSL2 detection via /proc/version."""

    def test_wsl_kernel_detected(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "system", lambda: "Linux")
        monkeypatch.setattr(
            Path,
            "read_text",
            lambda self, encoding=None: (
                "Linux version 5.15.153.1-microsoft-standard-WSL2 (gcc ...)"
            ),
        )

        assert platform_config.is_wsl() is True

    def test_plain_linux_is_not_wsl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "system", lambda: "Linux")
        monkeypatch.setattr(
            Path,
            "read_text",
            lambda self, encoding=None: "Linux version 6.8.0-generic (gcc ...)",
        )

        assert platform_config.is_wsl() is False

    def test_wsl_is_still_reported_as_linux_platform(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """WSL2 is where Windows users run Lem, and it behaves like Linux."""
        monkeypatch.setattr(platform, "system", lambda: "Linux")
        monkeypatch.setattr(
            Path,
            "read_text",
            lambda self, encoding=None: "Linux version 5.15-microsoft-standard-WSL2",
        )

        assert platform_config.is_wsl() is True
        assert platform_config.get_platform() == "linux"

    def test_missing_proc_version_is_not_wsl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "system", lambda: "Linux")

        def _raise(self: Path, encoding: str | None = None) -> str:
            raise FileNotFoundError("/proc/version")

        monkeypatch.setattr(Path, "read_text", _raise)

        assert platform_config.is_wsl() is False

    def test_macos_is_not_wsl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(platform, "system", lambda: "Darwin")
        assert platform_config.is_wsl() is False


class TestDockerSocketDefaults:
    """DOCKER_SOCKET / DOCKER_HOST defaults per platform."""

    def test_linux_default_socket(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("DOCKER_HOST", raising=False)
        monkeypatch.setattr(platform_config, "PLATFORM", "linux")

        assert platform_config.get_docker_socket_path() == Path("/var/run/docker.sock")
        assert platform_config.get_docker_host_uri() == "unix:///var/run/docker.sock"

    def test_macos_default_socket(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("DOCKER_HOST", raising=False)
        monkeypatch.setattr(platform_config, "PLATFORM", "macos")
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: Path("/Users/tester")))

        expected = Path("/Users/tester/.docker/run/docker.sock")
        assert platform_config.get_docker_socket_path() == expected
        assert platform_config.get_docker_host_uri() == f"unix://{expected}"


class TestDockerHostOverride:
    """DOCKER_HOST overrides must never be rewritten."""

    def test_tcp_endpoint_passes_through_untouched(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Regression: tcp:// used to become unix://tcp:/10.0.0.5:2375."""
        monkeypatch.setenv("DOCKER_HOST", "tcp://10.0.0.5:2375")

        assert platform_config.get_docker_host_uri() == "tcp://10.0.0.5:2375"
        assert platform_config.get_docker_socket_path() is None

    def test_ssh_endpoint_passes_through_untouched(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DOCKER_HOST", "ssh://user@build-host")

        assert platform_config.get_docker_host_uri() == "ssh://user@build-host"
        assert platform_config.get_docker_socket_path() is None

    def test_unix_override_is_preserved_and_resolves_to_a_socket(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DOCKER_HOST", "unix:///custom/docker.sock")

        assert platform_config.get_docker_host_uri() == "unix:///custom/docker.sock"
        assert platform_config.get_docker_socket_path() == Path("/custom/docker.sock")

    def test_npipe_override_is_preserved(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DOCKER_HOST", "npipe:////./pipe/docker_engine")

        assert platform_config.get_docker_host_uri() == "npipe:////./pipe/docker_engine"
        assert platform_config.get_docker_socket_path() == Path("//./pipe/docker_engine")

    def test_bare_path_override_is_treated_as_socket(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("DOCKER_HOST", "/run/user/1000/docker.sock")

        assert platform_config.get_docker_socket_path() == Path("/run/user/1000/docker.sock")

    def test_empty_override_falls_back_to_platform_default(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("DOCKER_HOST", "")
        monkeypatch.setattr(platform_config, "PLATFORM", "linux")

        assert platform_config.get_docker_host_uri() == "unix:///var/run/docker.sock"


class TestGetLemHome:
    """The install prefix, which the installer may relocate."""

    def test_defaults_to_dot_lem_under_home(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("LEM_HOME", raising=False)

        assert platform_config.get_lem_home() == Path.home() / ".lem"

    def test_env_override_wins(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        """A relocated install must not read its database out of ~/.lem."""
        monkeypatch.setenv("LEM_HOME", str(tmp_path / "lem home"))

        assert platform_config.get_lem_home() == tmp_path / "lem home"

    def test_blank_override_falls_back_to_the_default(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("LEM_HOME", "   ")

        assert platform_config.get_lem_home() == Path.home() / ".lem"

    def test_tilde_in_the_override_is_expanded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LEM_HOME", "~/elsewhere/lem")

        assert platform_config.get_lem_home() == Path.home() / "elsewhere" / "lem"


class TestModuleLevelConstants:
    """The precomputed constants the rest of the app imports."""

    def test_constants_are_consistent(self) -> None:
        assert platform_config.PLATFORM in ("macos", "linux")
        assert platform_config.DOCKER_HOST.startswith(("unix://", "npipe://", "tcp://", "ssh://"))
        assert platform_config.HARBOR_SCRIPT == platform_config.HARBOR_DIR / "harbor.sh"
        assert platform_config.HARBOR_DIR == platform_config.LEM_HOME / "harbor"

    def test_the_database_lives_under_the_same_prefix_as_harbor(self) -> None:
        """db.py used to resolve its own ~/.lem, so the two could disagree."""
        from app import db

        assert db.DB_PATH == platform_config.LEM_HOME / "lem.db"
