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
Data models for the job queue system.
"""

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, Field


class JobStatus(StrEnum):
    """Status of a background job."""

    PENDING = "pending"  # Queued, waiting to be processed
    RUNNING = "running"  # Currently being processed
    COMPLETED = "completed"  # Finished successfully
    FAILED = "failed"  # Failed with error


class JobType(StrEnum):
    """
    Type of background job.

    Every member must have a handler registered in
    app.services.lifecycle.register_job_handlers(); a job whose type has no
    handler is failed immediately by the worker.
    """

    INSTALL = "install"  # Install (pull) a service
    REMOVE = "remove"  # Remove a service (container + image)


class Job(BaseModel):
    """
    Background job for long-running operations.

    Jobs are persisted to SQLite and processed by the background worker.
    Progress and status updates are written back to the database.
    """

    id: str = Field(description="Unique job ID (UUID)")
    type: JobType = Field(description="Type of job")
    service_id: str = Field(description="Service ID this job operates on")
    status: JobStatus = Field(default=JobStatus.PENDING, description="Current status")
    progress: int = Field(default=0, ge=0, le=100, description="Progress percentage")
    message: str = Field(default="", description="Current status message")
    error: str | None = Field(default=None, description="Error message if failed")
    created_at: datetime = Field(description="When the job was created")
    updated_at: datetime = Field(description="When the job was last updated")

    # Optional extra data for specific job types
    extra: dict[str, str] = Field(
        default_factory=dict,
        description="Additional job-specific data",
    )

    def is_active(self) -> bool:
        """Check if the job is still active (pending or running)."""
        return self.status in (JobStatus.PENDING, JobStatus.RUNNING)

    def is_terminal(self) -> bool:
        """Check if the job has reached a terminal state."""
        return self.status in (JobStatus.COMPLETED, JobStatus.FAILED)


class JobCreate(BaseModel):
    """Request to create a new job."""

    type: JobType
    service_id: str
    extra: dict[str, str] = Field(default_factory=dict)


class JobUpdate(BaseModel):
    """Request to update a job's status."""

    status: JobStatus | None = None
    progress: int | None = Field(default=None, ge=0, le=100)
    message: str | None = None
    error: str | None = None
