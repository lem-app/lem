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
Tests for app.drivers.harbor_wrapper (read-only Harbor probes).

Harbor is stubbed with throwaway shell scripts, so nothing here needs a real
Harbor checkout or a running Docker daemon.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.drivers import harbor_wrapper
from app.drivers.harbor_wrapper import (
    HarborError,
    check_harbor_installed,
    check_harbor_requirements,
)


def _fake_harbor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, body: str) -> Path:
    """Install a stub harbor.sh and point the wrapper at it."""
    script = tmp_path / "harbor.sh"
    script.write_text(f"#!/bin/sh\n{body}\n")
    script.chmod(0o755)
    monkeypatch.setattr(harbor_wrapper, "HARBOR_SCRIPT", script)
    return script


class TestCheckHarborInstalled:
    """P8: every failure mode must be a HarborError, never a raw traceback."""

    def test_returns_the_version(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        _fake_harbor(tmp_path, monkeypatch, "echo '0.3.20'")
        assert check_harbor_installed() == "0.3.20"

    def test_takes_the_last_token_of_a_verbose_banner(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _fake_harbor(tmp_path, monkeypatch, "echo 'Harbor version 0.3.20'")
        assert check_harbor_installed() == "0.3.20"

    def test_empty_output_raises_harbor_error_not_index_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: `.split()[-1]` on empty output raised IndexError."""
        _fake_harbor(tmp_path, monkeypatch, "true")

        with pytest.raises(HarborError, match="empty version"):
            check_harbor_installed()

    def test_whitespace_only_output_raises_harbor_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _fake_harbor(tmp_path, monkeypatch, "echo '   '")

        with pytest.raises(HarborError, match="empty version"):
            check_harbor_installed()

    def test_missing_script_raises_actionable_harbor_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Regression: a missing Harbor used to escape as FileNotFoundError."""
        monkeypatch.setattr(harbor_wrapper, "HARBOR_SCRIPT", tmp_path / "absent" / "harbor.sh")

        with pytest.raises(HarborError, match="Install Harbor"):
            check_harbor_installed()

    def test_non_executable_script_raises_harbor_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        script = tmp_path / "harbor.sh"
        script.write_text("#!/bin/sh\necho 0.3.20\n")
        script.chmod(0o644)
        monkeypatch.setattr(harbor_wrapper, "HARBOR_SCRIPT", script)

        with pytest.raises(HarborError, match="not usable"):
            check_harbor_installed()

    def test_non_zero_exit_reports_stderr(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _fake_harbor(tmp_path, monkeypatch, "echo 'broken checkout' >&2\nexit 2")

        with pytest.raises(HarborError) as exc_info:
            check_harbor_installed()

        assert exc_info.value.exit_code == 2
        assert "broken checkout" in exc_info.value.stderr

    def test_hanging_script_times_out_as_harbor_error(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _fake_harbor(tmp_path, monkeypatch, "sleep 30")
        monkeypatch.setattr(harbor_wrapper, "PROBE_TIMEOUT", 1)

        with pytest.raises(HarborError) as exc_info:
            check_harbor_installed()

        assert exc_info.value.exit_code == 124


class TestCheckHarborRequirements:
    """P8: `harbor doctor` reports, it never raises."""

    def test_clean_doctor_output_passes(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _fake_harbor(tmp_path, monkeypatch, "echo '[OK] Docker is running'")

        assert check_harbor_requirements() == (True, [])

    def test_error_lines_are_collected(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _fake_harbor(
            tmp_path,
            monkeypatch,
            "echo '[OK] Harbor home'\necho '[ERROR] ✘ Docker is not running'\nexit 1",
        )

        ok, issues = check_harbor_requirements()

        assert ok is False
        assert issues == ["Docker is not running"]

    def test_missing_script_is_reported_not_raised(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(harbor_wrapper, "HARBOR_SCRIPT", tmp_path / "absent" / "harbor.sh")

        ok, issues = check_harbor_requirements()

        assert ok is False
        assert any("not usable" in issue for issue in issues)

    def test_hanging_doctor_is_reported_not_raised(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _fake_harbor(tmp_path, monkeypatch, "sleep 30")
        monkeypatch.setattr(harbor_wrapper, "PROBE_TIMEOUT", 1)

        ok, issues = check_harbor_requirements()

        assert ok is False
        assert any("timed out" in issue for issue in issues)
