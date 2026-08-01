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

"""Tests for app.jobs.db (orphan recovery, one-active-job-per-service)."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException

from app import db as app_db
from app.jobs.db import (
    ActiveJobExistsError,
    create_job,
    delete_old_jobs,
    fail_orphaned_jobs,
    get_active_job_for_service,
    get_job,
    init_jobs_schema,
    update_job_status,
)
from app.jobs.models import JobStatus, JobType
from app.services import lifecycle


@pytest.fixture
def jobs_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """A throwaway SQLite database with the jobs schema applied."""
    db_path = tmp_path / "lem.db"
    monkeypatch.setattr(app_db, "LEM_HOME", tmp_path)
    monkeypatch.setattr(app_db, "DB_PATH", db_path)

    app_db.init_db()
    init_jobs_schema()

    yield db_path


def _insert_raw(service_id: str, status: str, created_at: str) -> str:
    """Insert a job row directly, bypassing create_job's guards."""
    job_id = f"{service_id}-{status}-{created_at}"
    with app_db.get_db() as conn:
        conn.execute(
            """
            INSERT INTO jobs
                (id, type, service_id, status, progress, message,
                 extra_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                JobType.INSTALL.value,
                service_id,
                status,
                0,
                "",
                "{}",
                created_at,
                created_at,
            ),
        )
        conn.commit()
    return job_id


class TestOrphanedJobRecovery:
    """P7: a crash mid-install used to wedge a service behind a 409 forever."""

    def test_running_job_is_failed_after_restart(self, jobs_db: Path) -> None:
        """Regression: nothing resumes a 'running' row, so it must be failed."""
        job_id = _insert_raw("ollama", JobStatus.RUNNING.value, "2026-01-01T00:00:00+00:00")

        assert fail_orphaned_jobs() == 1

        job = get_job(job_id)
        assert job is not None
        assert job.status == JobStatus.FAILED
        assert job.error is not None
        assert "restarted" in job.error

    def test_pending_job_is_failed_after_restart(self, jobs_db: Path) -> None:
        job_id = _insert_raw("webui", JobStatus.PENDING.value, "2026-01-01T00:00:00+00:00")

        assert fail_orphaned_jobs() == 1

        job = get_job(job_id)
        assert job is not None
        assert job.status == JobStatus.FAILED

    def test_service_is_installable_again_after_recovery(self, jobs_db: Path) -> None:
        """The whole point: the service must stop being permanently blocked."""
        _insert_raw("ollama", JobStatus.RUNNING.value, "2026-01-01T00:00:00+00:00")
        assert get_active_job_for_service("ollama") is not None

        fail_orphaned_jobs()

        assert get_active_job_for_service("ollama") is None
        assert create_job(JobType.INSTALL, "ollama").status == JobStatus.PENDING

    def test_terminal_jobs_are_left_alone(self, jobs_db: Path) -> None:
        done = _insert_raw("dify", JobStatus.COMPLETED.value, "2026-01-01T00:00:00+00:00")
        failed = _insert_raw("bench", JobStatus.FAILED.value, "2026-01-01T00:00:00+00:00")

        assert fail_orphaned_jobs() == 0

        completed_job = get_job(done)
        failed_job = get_job(failed)
        assert completed_job is not None and completed_job.status == JobStatus.COMPLETED
        assert failed_job is not None and failed_job.status == JobStatus.FAILED

    def test_recovery_is_a_no_op_on_a_clean_database(self, jobs_db: Path) -> None:
        assert fail_orphaned_jobs() == 0

    def test_recovery_clears_duplicates_so_the_index_can_be_created(self, jobs_db: Path) -> None:
        """Legacy databases can hold two active rows; recovery runs first."""
        with app_db.get_db() as conn:
            conn.execute("DROP INDEX IF EXISTS idx_jobs_one_active_per_service")
            conn.commit()

        _insert_raw("ollama", JobStatus.RUNNING.value, "2026-01-01T00:00:00+00:00")
        _insert_raw("ollama", JobStatus.PENDING.value, "2026-01-02T00:00:00+00:00")

        assert fail_orphaned_jobs() == 2

        init_jobs_schema()
        create_job(JobType.INSTALL, "ollama")
        with pytest.raises(ActiveJobExistsError):
            create_job(JobType.REMOVE, "ollama")


class TestOneActiveJobPerService:
    """P7: the TOCTOU between the check and the insert is closed by the DB."""

    def test_second_active_job_for_a_service_is_rejected(self, jobs_db: Path) -> None:
        """
        Regression: two concurrent installs both passed
        get_active_job_for_service() and both enqueued. create_job is called
        here directly, which is exactly what a lost race looks like.
        """
        create_job(JobType.INSTALL, "ollama")

        with pytest.raises(ActiveJobExistsError):
            create_job(JobType.INSTALL, "ollama")

    def test_a_running_job_also_blocks_a_second_one(self, jobs_db: Path) -> None:
        first = create_job(JobType.INSTALL, "ollama")
        update_job_status(first.id, JobStatus.RUNNING)

        with pytest.raises(ActiveJobExistsError):
            create_job(JobType.REMOVE, "ollama")

    def test_different_services_are_independent(self, jobs_db: Path) -> None:
        create_job(JobType.INSTALL, "ollama")
        create_job(JobType.INSTALL, "webui")

        assert get_active_job_for_service("ollama") is not None
        assert get_active_job_for_service("webui") is not None

    def test_a_new_job_is_allowed_once_the_previous_one_is_terminal(self, jobs_db: Path) -> None:
        first = create_job(JobType.INSTALL, "ollama")
        update_job_status(first.id, JobStatus.COMPLETED)

        second = create_job(JobType.REMOVE, "ollama")
        assert second.id != first.id

    async def test_lost_race_surfaces_as_409_not_500(
        self, jobs_db: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """
        The pre-check is only cosmetic. Force it to report "no active job"
        while one exists, and the endpoint must still answer 409.
        """
        existing = create_job(JobType.INSTALL, "ollama")

        monkeypatch.setattr(lifecycle, "_require_service", lambda _sid: None)
        monkeypatch.setattr(lifecycle, "get_active_job_for_service", lambda _sid: None)

        with pytest.raises(HTTPException) as exc_info:
            await lifecycle.install_service("ollama")

        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["type"] == "https://lem.gg/errors/job-in-progress"
        still_active = get_active_job_for_service("ollama")
        assert still_active is not None
        assert still_active.id == existing.id

    async def test_conflict_reports_the_blocking_job_id(
        self, jobs_db: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        existing = create_job(JobType.INSTALL, "ollama")
        monkeypatch.setattr(lifecycle, "_require_service", lambda _sid: None)

        with pytest.raises(HTTPException) as exc_info:
            await lifecycle.install_service("ollama")

        assert exc_info.value.detail["job_id"] == existing.id


class TestTimestamps:
    """P10: datetime.utcnow() was deprecated and produced naive timestamps."""

    def test_created_at_is_timezone_aware(self, jobs_db: Path) -> None:
        job = create_job(JobType.INSTALL, "ollama")
        assert job.created_at.tzinfo is not None

        stored = get_job(job.id)
        assert stored is not None
        assert stored.created_at.tzinfo is not None

    def test_old_jobs_are_pruned_by_iso_string_comparison(self, jobs_db: Path) -> None:
        old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        recent = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        old_id = _insert_raw("ollama", JobStatus.COMPLETED.value, old)
        recent_id = _insert_raw("webui", JobStatus.COMPLETED.value, recent)

        assert delete_old_jobs(days=7) == 1
        assert get_job(old_id) is None
        assert get_job(recent_id) is not None

    def test_legacy_naive_timestamps_still_compare_correctly(self, jobs_db: Path) -> None:
        """Rows written by the old utcnow() code have no UTC offset suffix."""
        old_naive = (datetime.now(UTC) - timedelta(days=30)).replace(tzinfo=None).isoformat()
        recent_naive = (datetime.now(UTC) - timedelta(hours=1)).replace(tzinfo=None).isoformat()
        old_id = _insert_raw("ollama", JobStatus.COMPLETED.value, old_naive)
        recent_id = _insert_raw("webui", JobStatus.COMPLETED.value, recent_naive)

        assert delete_old_jobs(days=7) == 1
        assert get_job(old_id) is None
        assert get_job(recent_id) is not None

    def test_active_jobs_are_never_pruned(self, jobs_db: Path) -> None:
        old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
        running_id = _insert_raw("ollama", JobStatus.RUNNING.value, old)

        assert delete_old_jobs(days=7) == 0
        assert get_job(running_id) is not None
