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
Service lifecycle operations.

Handles install, start, stop, and remove operations for Harbor services.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess

from fastapi import HTTPException

from app.catalog import get_service_definition, get_service_dependencies
from app.catalog.models import ServiceStatus
from app.config.platform import DOCKER_HOST, HARBOR_SCRIPT
from app.jobs import (
    Job,
    JobType,
    create_job,
    get_active_job_for_service,
    update_job_progress,
)
from app.jobs.queue import get_job_queue
from app.services.status import get_service_status

logger = logging.getLogger(__name__)

# Timeouts
INSTALL_TIMEOUT = 600  # 10 minutes for install (image pull)
START_TIMEOUT = 300  # 5 minutes for start
STOP_TIMEOUT = 60  # 1 minute for stop
REMOVE_TIMEOUT = 120  # 2 minutes for remove


def _get_docker_env() -> dict[str, str]:
    """Get environment with Docker socket configured."""
    return {
        **os.environ,
        "DOCKER_HOST": DOCKER_HOST,
    }


async def _run_harbor_command(
    args: list[str],
    timeout: int,
    service_id: str,
) -> tuple[int, str, str]:
    """
    Run a Harbor CLI command asynchronously.

    Args:
        args: Command arguments (e.g., ["up", "--no-defaults", "ollama"])
        timeout: Timeout in seconds
        service_id: Service ID for logging

    Returns:
        Tuple of (return_code, stdout, stderr)

    Raises:
        HTTPException: If command fails or times out
    """
    cmd = [str(HARBOR_SCRIPT)] + args
    logger.info(f"Running: {' '.join(cmd)}")

    try:
        result = await asyncio.to_thread(
            subprocess.run,
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_get_docker_env(),
        )

        if result.returncode != 0:
            logger.error(f"Harbor command failed: {result.stderr}")
            raise HTTPException(
                status_code=503,
                detail={
                    "type": "https://lem.gg/errors/harbor-command-failed",
                    "title": "Harbor Command Failed",
                    "detail": f"Command failed with exit code {result.returncode}",
                    "service": service_id,
                    "stderr": result.stderr[:500],  # Truncate for response
                },
            )

        return result.returncode, result.stdout, result.stderr

    except subprocess.TimeoutExpired as e:
        logger.error(f"Harbor command timed out after {timeout}s")
        raise HTTPException(
            status_code=504,
            detail={
                "type": "https://lem.gg/errors/timeout",
                "title": "Operation Timed Out",
                "detail": f"Operation timed out after {timeout} seconds",
                "service": service_id,
            },
        ) from e


async def install_service(service_id: str) -> str:
    """
    Install a service (async job).

    Creates a background job that:
    1. Checks and installs dependencies first
    2. Pulls the service image via Harbor

    Args:
        service_id: Service ID to install

    Returns:
        Job ID for tracking progress

    Raises:
        HTTPException: If service not found or already installing
    """
    service_def = get_service_definition(service_id)
    if not service_def:
        raise HTTPException(
            status_code=404,
            detail={
                "type": "https://lem.gg/errors/service-not-found",
                "title": "Service Not Found",
                "detail": f"Service '{service_id}' not found in catalog",
            },
        )

    # Check if already installing
    active_job = get_active_job_for_service(service_id)
    if active_job:
        raise HTTPException(
            status_code=409,
            detail={
                "type": "https://lem.gg/errors/job-in-progress",
                "title": "Job Already In Progress",
                "detail": f"Service '{service_id}' already has an active job",
                "job_id": active_job.id,
            },
        )

    # Create the job (will be processed by background worker)
    job = create_job(JobType.INSTALL, service_id)
    logger.info(f"Created install job {job.id} for {service_id}")

    return job.id


async def _handle_install_job(job: Job) -> None:
    """
    Handle an install job (called by job queue worker).

    Args:
        job: Job to process
    """
    service_id = job.service_id
    service_def = get_service_definition(service_id)

    if not service_def:
        raise ValueError(f"Service not found: {service_id}")

    # Check dependencies
    deps = get_service_dependencies(service_id)
    total_steps = len(deps) + 1  # deps + main service
    current_step = 0

    for dep_id in deps:
        current_step += 1
        progress = int((current_step / total_steps) * 80)  # Leave 20% for main

        dep_status = await get_service_status(dep_id)
        if dep_status == ServiceStatus.NOT_INSTALLED:
            update_job_progress(job.id, progress, f"Installing dependency: {dep_id}...")

            # Install dependency synchronously
            await _run_harbor_command(
                ["up", "--no-defaults", dep_id],
                INSTALL_TIMEOUT,
                dep_id,
            )

    # Install the main service
    update_job_progress(job.id, 85, f"Installing {service_id}...")

    await _run_harbor_command(
        ["up", "--no-defaults", service_id],
        INSTALL_TIMEOUT,
        service_id,
    )

    update_job_progress(job.id, 100, "Installation complete")


async def start_service(service_id: str) -> dict[str, str]:
    """
    Start an installed service.

    Args:
        service_id: Service ID to start

    Returns:
        {"status": "ok"}

    Raises:
        HTTPException: If service not found or not installed
    """
    service_def = get_service_definition(service_id)
    if not service_def:
        raise HTTPException(
            status_code=404,
            detail={
                "type": "https://lem.gg/errors/service-not-found",
                "title": "Service Not Found",
                "detail": f"Service '{service_id}' not found in catalog",
            },
        )

    status = await get_service_status(service_id)
    if status == ServiceStatus.NOT_INSTALLED:
        raise HTTPException(
            status_code=400,
            detail={
                "type": "https://lem.gg/errors/service-not-installed",
                "title": "Service Not Installed",
                "detail": f"Service '{service_id}' must be installed first",
            },
        )

    if status == ServiceStatus.RUNNING:
        # Already running - idempotent success
        return {"status": "ok"}

    await _run_harbor_command(
        ["up", "--no-defaults", service_id],
        START_TIMEOUT,
        service_id,
    )

    return {"status": "ok"}


async def stop_service(service_id: str) -> dict[str, str]:
    """
    Stop a running service.

    Args:
        service_id: Service ID to stop

    Returns:
        {"status": "ok"}

    Raises:
        HTTPException: If service not found
    """
    service_def = get_service_definition(service_id)
    if not service_def:
        raise HTTPException(
            status_code=404,
            detail={
                "type": "https://lem.gg/errors/service-not-found",
                "title": "Service Not Found",
                "detail": f"Service '{service_id}' not found in catalog",
            },
        )

    status = await get_service_status(service_id)
    if status in (ServiceStatus.NOT_INSTALLED, ServiceStatus.STOPPED):
        # Already stopped - idempotent success
        return {"status": "ok"}

    await _run_harbor_command(
        ["down", service_id],
        STOP_TIMEOUT,
        service_id,
    )

    return {"status": "ok"}


async def remove_service(service_id: str) -> str:
    """
    Remove a service (async job).

    Creates a background job that:
    1. Stops the service if running
    2. Removes the container
    3. Removes the image

    Args:
        service_id: Service ID to remove

    Returns:
        Job ID for tracking progress

    Raises:
        HTTPException: If service not found or already removing
    """
    service_def = get_service_definition(service_id)
    if not service_def:
        raise HTTPException(
            status_code=404,
            detail={
                "type": "https://lem.gg/errors/service-not-found",
                "title": "Service Not Found",
                "detail": f"Service '{service_id}' not found in catalog",
            },
        )

    # Check if already has active job
    active_job = get_active_job_for_service(service_id)
    if active_job:
        raise HTTPException(
            status_code=409,
            detail={
                "type": "https://lem.gg/errors/job-in-progress",
                "title": "Job Already In Progress",
                "detail": f"Service '{service_id}' already has an active job",
                "job_id": active_job.id,
            },
        )

    # Create the job
    job = create_job(JobType.REMOVE, service_id)
    logger.info(f"Created remove job {job.id} for {service_id}")

    return job.id


async def _handle_remove_job(job: Job) -> None:
    """
    Handle a remove job (called by job queue worker).

    Args:
        job: Job to process
    """
    service_id = job.service_id

    # Stop the service first
    update_job_progress(job.id, 20, "Stopping service...")

    try:
        await _run_harbor_command(
            ["down", service_id],
            STOP_TIMEOUT,
            service_id,
        )
    except HTTPException:
        # Ignore if already stopped
        pass

    # Remove container
    update_job_progress(job.id, 50, "Removing container...")

    try:
        await asyncio.to_thread(
            subprocess.run,
            ["docker", "rm", f"harbor.{service_id}"],
            capture_output=True,
            timeout=30,
            env=_get_docker_env(),
        )
    except Exception as e:
        logger.warning(f"Failed to remove container: {e}")

    # Find and remove image
    update_job_progress(job.id, 80, "Removing image...")

    try:
        # List images to find the one for this service
        result = await asyncio.to_thread(
            subprocess.run,
            ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True,
            text=True,
            timeout=10,
            env=_get_docker_env(),
        )

        for image in result.stdout.strip().split("\n"):
            if service_id.lower() in image.lower():
                await asyncio.to_thread(
                    subprocess.run,
                    ["docker", "rmi", image],
                    capture_output=True,
                    timeout=60,
                    env=_get_docker_env(),
                )
                logger.info(f"Removed image: {image}")
                break

    except Exception as e:
        logger.warning(f"Failed to remove image: {e}")

    update_job_progress(job.id, 100, "Service removed")


def register_job_handlers() -> None:
    """
    Register job handlers with the job queue.

    This should be called during app startup after the job queue is initialized.
    """
    queue = get_job_queue()
    queue.register_handler(JobType.INSTALL, _handle_install_job)
    queue.register_handler(JobType.REMOVE, _handle_remove_job)
    logger.info("Registered service job handlers")
