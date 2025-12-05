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
Database operations for the job queue.

Jobs are stored in SQLite at ~/.lem/lem.db alongside auth and device data.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta

from app.db import get_db
from app.jobs.models import Job, JobStatus, JobType

logger = logging.getLogger(__name__)


def init_jobs_table() -> None:
    """
    Initialize the jobs table in the database.

    This is called during app startup via init_db().
    """
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                service_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                progress INTEGER DEFAULT 0,
                message TEXT DEFAULT '',
                error TEXT,
                extra_json TEXT DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        # Create indexes for common queries
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_service_id ON jobs(service_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at)")
        conn.commit()


def _row_to_job(row: dict[str, str | int | None]) -> Job:
    """Convert a database row to a Job object."""
    extra_json_raw = row.get("extra_json") or "{}"
    extra_json = str(extra_json_raw)
    extra: dict[str, str] = json.loads(extra_json) if extra_json else {}

    return Job(
        id=str(row["id"]),
        type=JobType(str(row["type"])),
        service_id=str(row["service_id"]),
        status=JobStatus(str(row["status"])),
        progress=int(row["progress"] or 0),
        message=str(row["message"] or ""),
        error=str(row["error"]) if row.get("error") else None,
        extra=extra,
        created_at=datetime.fromisoformat(str(row["created_at"])),
        updated_at=datetime.fromisoformat(str(row["updated_at"])),
    )


def create_job(
    job_type: JobType,
    service_id: str,
    extra: dict[str, str] | None = None,
) -> Job:
    """
    Create a new job in the database.

    Args:
        job_type: Type of job (install, remove, pull_model)
        service_id: Service ID the job operates on
        extra: Additional job-specific data

    Returns:
        The created Job object
    """
    job_id = str(uuid.uuid4())
    now = datetime.utcnow()
    extra_json = json.dumps(extra or {})

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO jobs
                (id, type, service_id, status, progress, message,
                 extra_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                job_type.value,
                service_id,
                JobStatus.PENDING.value,
                0,
                "Queued",
                extra_json,
                now.isoformat(),
                now.isoformat(),
            ),
        )
        conn.commit()

    logger.info(f"Created job {job_id}: {job_type.value} for {service_id}")

    return Job(
        id=job_id,
        type=job_type,
        service_id=service_id,
        status=JobStatus.PENDING,
        progress=0,
        message="Queued",
        extra=extra or {},
        created_at=now,
        updated_at=now,
    )


def get_job(job_id: str) -> Job | None:
    """
    Get a job by ID.

    Args:
        job_id: Job ID to look up

    Returns:
        Job object or None if not found
    """
    with get_db() as conn:
        cursor = conn.execute(
            "SELECT * FROM jobs WHERE id = ?",
            (job_id,),
        )
        row = cursor.fetchone()

    if not row:
        return None

    return _row_to_job(dict(row))


def get_pending_jobs() -> list[Job]:
    """
    Get all pending jobs, ordered by creation time (FIFO).

    Returns:
        List of pending Job objects
    """
    with get_db() as conn:
        cursor = conn.execute(
            "SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC",
            (JobStatus.PENDING.value,),
        )
        rows = cursor.fetchall()

    return [_row_to_job(dict(row)) for row in rows]


def get_recent_jobs(
    status: JobStatus | None = None,
    service_id: str | None = None,
    limit: int = 20,
) -> list[Job]:
    """
    Get recent jobs with optional filtering.

    Args:
        status: Filter by status (optional)
        service_id: Filter by service ID (optional)
        limit: Maximum number of jobs to return

    Returns:
        List of Job objects, most recent first
    """
    query = "SELECT * FROM jobs WHERE 1=1"
    params: list[str | int] = []

    if status:
        query += " AND status = ?"
        params.append(status.value)

    if service_id:
        query += " AND service_id = ?"
        params.append(service_id)

    query += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)

    with get_db() as conn:
        cursor = conn.execute(query, params)
        rows = cursor.fetchall()

    return [_row_to_job(dict(row)) for row in rows]


def get_active_job_for_service(service_id: str) -> Job | None:
    """
    Get the active (pending or running) job for a service.

    Only one job per service should be active at a time.

    Args:
        service_id: Service ID to check

    Returns:
        Active Job or None
    """
    with get_db() as conn:
        cursor = conn.execute(
            """
            SELECT * FROM jobs
            WHERE service_id = ? AND status IN (?, ?)
            ORDER BY created_at DESC
            LIMIT 1
            """,
            (service_id, JobStatus.PENDING.value, JobStatus.RUNNING.value),
        )
        row = cursor.fetchone()

    if not row:
        return None

    return _row_to_job(dict(row))


def update_job_status(
    job_id: str,
    status: JobStatus,
    error: str | None = None,
) -> None:
    """
    Update a job's status.

    Args:
        job_id: Job ID to update
        status: New status
        error: Error message (for failed status)
    """
    now = datetime.utcnow()

    with get_db() as conn:
        if error:
            conn.execute(
                """
                UPDATE jobs SET status = ?, error = ?, updated_at = ?
                WHERE id = ?
                """,
                (status.value, error, now.isoformat(), job_id),
            )
        else:
            conn.execute(
                """
                UPDATE jobs SET status = ?, updated_at = ?
                WHERE id = ?
                """,
                (status.value, now.isoformat(), job_id),
            )
        conn.commit()

    logger.info(f"Job {job_id} status updated to {status.value}")


def update_job_progress(
    job_id: str,
    progress: int,
    message: str = "",
) -> None:
    """
    Update a job's progress.

    Args:
        job_id: Job ID to update
        progress: Progress percentage (0-100)
        message: Status message
    """
    now = datetime.utcnow()

    with get_db() as conn:
        conn.execute(
            """
            UPDATE jobs SET progress = ?, message = ?, updated_at = ?
            WHERE id = ?
            """,
            (progress, message, now.isoformat(), job_id),
        )
        conn.commit()


def delete_old_jobs(days: int = 7) -> int:
    """
    Delete jobs older than the specified number of days.

    Only deletes completed or failed jobs.

    Args:
        days: Number of days to keep

    Returns:
        Number of jobs deleted
    """
    cutoff = datetime.utcnow() - timedelta(days=days)

    with get_db() as conn:
        cursor = conn.execute(
            """
            DELETE FROM jobs
            WHERE status IN (?, ?) AND created_at < ?
            """,
            (JobStatus.COMPLETED.value, JobStatus.FAILED.value, cutoff.isoformat()),
        )
        deleted = cursor.rowcount
        conn.commit()

    if deleted > 0:
        logger.info(f"Deleted {deleted} old jobs")

    return deleted
