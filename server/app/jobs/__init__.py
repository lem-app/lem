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
Jobs module for background task processing.

Provides:
- Job queue for long-running operations (install, remove, pull)
- SQLite-backed job persistence
- Background worker for async processing
- Progress tracking and status updates
"""

from app.jobs.db import (
    ActiveJobExistsError,
    create_job,
    delete_old_jobs,
    fail_orphaned_jobs,
    get_active_job_for_service,
    get_job,
    get_pending_jobs,
    get_recent_jobs,
    init_jobs_schema,
    update_job_progress,
    update_job_status,
)
from app.jobs.models import Job, JobStatus, JobType
from app.jobs.queue import JobQueue

__all__ = [
    # Models
    "Job",
    "JobStatus",
    "JobType",
    # Queue
    "JobQueue",
    # Database operations
    "ActiveJobExistsError",
    "create_job",
    "fail_orphaned_jobs",
    "get_job",
    "get_pending_jobs",
    "get_recent_jobs",
    "get_active_job_for_service",
    "init_jobs_schema",
    "update_job_status",
    "update_job_progress",
    "delete_old_jobs",
]
