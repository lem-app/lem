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
Background job queue for processing long-running operations.

The JobQueue manages:
- A background worker that processes jobs from the database
- Job lifecycle (pending -> running -> completed/failed)
- Progress tracking and status updates
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from app.jobs.db import (
    delete_old_jobs,
    fail_orphaned_jobs,
    get_job,
    get_pending_jobs,
    init_jobs_schema,
    update_job_progress,
    update_job_status,
)
from app.jobs.models import Job, JobStatus, JobType

logger = logging.getLogger(__name__)

# Type for job handlers: async function that takes a Job and returns None
JobHandler = Callable[[Job], Awaitable[None]]


class JobQueue:
    """
    Background job queue with SQLite persistence.

    Usage:
        queue = JobQueue()
        queue.register_handler(JobType.INSTALL, handle_install)
        await queue.start()  # Start background worker

        job = create_job(JobType.INSTALL, "ollama")

        await queue.stop()  # Stop background worker
    """

    def __init__(self, poll_interval: float = 1.0) -> None:
        """
        Initialize the job queue.

        Args:
            poll_interval: Seconds between polling for new jobs
        """
        self._poll_interval = poll_interval
        self._worker_task: asyncio.Task[None] | None = None
        self._running = False
        self._handlers: dict[JobType, JobHandler] = {}
        self._current_job: Job | None = None

    def register_handler(self, job_type: JobType, handler: JobHandler) -> None:
        """
        Register a handler for a job type.

        Args:
            job_type: Type of job to handle
            handler: Async function that processes the job
        """
        self._handlers[job_type] = handler
        logger.debug(f"Registered handler for {job_type.value}")

    async def start(self) -> None:
        """Start the background worker."""
        if self._running:
            logger.warning("JobQueue already running")
            return

        self._running = True
        self._worker_task = asyncio.create_task(self._worker())
        logger.info("JobQueue started")

    async def stop(self) -> None:
        """Stop the background worker gracefully."""
        if not self._running:
            return

        self._running = False

        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass

        logger.info("JobQueue stopped")

    @property
    def is_running(self) -> bool:
        """Check if the queue is running."""
        return self._running

    @property
    def current_job(self) -> Job | None:
        """Get the currently processing job, if any."""
        return self._current_job

    async def _worker(self) -> None:
        """Background worker that processes jobs from the database."""
        logger.info("Job worker started")

        # Clean up old jobs on startup
        delete_old_jobs(days=7)

        while self._running:
            try:
                # Get next pending job
                pending = get_pending_jobs()
                if not pending:
                    await asyncio.sleep(self._poll_interval)
                    continue

                job = pending[0]
                await self._process_job(job)

            except asyncio.CancelledError:
                logger.info("Job worker cancelled")
                raise
            except Exception as e:
                logger.error(f"Error in job worker: {e}", exc_info=True)
                await asyncio.sleep(self._poll_interval)

    async def _process_job(self, job: Job) -> None:
        """
        Process a single job.

        Args:
            job: Job to process
        """
        logger.info(f"Processing job {job.id}: {job.type.value} for {job.service_id}")

        # Update status to running
        update_job_status(job.id, JobStatus.RUNNING)
        update_job_progress(job.id, 0, "Starting...")

        # Get handler for job type
        handler = self._handlers.get(job.type)
        if not handler:
            error = f"No handler registered for job type: {job.type.value}"
            logger.error(error)
            update_job_status(job.id, JobStatus.FAILED, error)
            return

        # Track current job
        self._current_job = job

        try:
            # Refresh job from database to get latest state
            refreshed_job = get_job(job.id)
            if refreshed_job is None:
                logger.error(f"Job {job.id} not found in database")
                return

            # Run the handler
            await handler(refreshed_job)

            # Mark as completed if handler didn't fail
            refreshed_job = get_job(job.id)
            if refreshed_job and refreshed_job.status == JobStatus.RUNNING:
                update_job_status(job.id, JobStatus.COMPLETED)
                update_job_progress(job.id, 100, "Completed")

            logger.info(f"Job {job.id} completed successfully")

        except Exception as e:
            error = str(e)
            logger.error(f"Job {job.id} failed: {error}", exc_info=True)
            update_job_status(job.id, JobStatus.FAILED, error)

        finally:
            self._current_job = None


# Global job queue instance
_job_queue: JobQueue | None = None


def get_job_queue() -> JobQueue:
    """
    Get the global job queue instance.

    Returns:
        JobQueue instance
    """
    global _job_queue
    if _job_queue is None:
        _job_queue = JobQueue()
    return _job_queue


async def init_job_queue() -> JobQueue:
    """
    Initialize and start the global job queue.

    Recovers jobs orphaned by a previous crash before enforcing (and relying
    on) the one-active-job-per-service constraint. This should be called during
    app startup.

    Returns:
        Started JobQueue instance
    """
    fail_orphaned_jobs()
    init_jobs_schema()

    queue = get_job_queue()
    if not queue.is_running:
        await queue.start()
    return queue


async def shutdown_job_queue() -> None:
    """
    Stop the global job queue.

    This should be called during app shutdown.
    """
    global _job_queue
    if _job_queue:
        await _job_queue.stop()
