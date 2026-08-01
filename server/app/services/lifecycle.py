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
import subprocess

from fastapi import HTTPException

from app.catalog import get_service_definition, get_service_dependencies
from app.catalog.models import ServiceStatus
from app.config.platform import HARBOR_SCRIPT
from app.jobs import (
    ActiveJobExistsError,
    Job,
    JobType,
    create_job,
    get_active_job_for_service,
    update_job_progress,
)
from app.jobs.queue import get_job_queue
from app.services.status import (
    DockerUnavailableError,
    get_docker_env,
    get_service_status,
    list_service_containers,
    resolve_service_image,
)

logger = logging.getLogger(__name__)

# Timeouts
INSTALL_TIMEOUT = 600  # 10 minutes for install (image pull)
START_TIMEOUT = 300  # 5 minutes for start
STOP_TIMEOUT = 60  # 1 minute for stop
CONTAINER_RM_TIMEOUT = 30
IMAGE_RM_TIMEOUT = 60


def _harbor_missing(service_id: str, error: OSError) -> HTTPException:
    """Build an RFC7807 503 for a missing/unusable Harbor CLI."""
    return HTTPException(
        status_code=503,
        detail={
            "type": "https://lem.gg/errors/harbor-not-installed",
            "title": "Harbor CLI Not Available",
            "detail": (
                f"Could not run the Harbor CLI at {HARBOR_SCRIPT}: {error}. "
                "Install Harbor (or re-run the Lem installer) and try again."
            ),
            "service": service_id,
        },
    )


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
        HTTPException: If Harbor is missing (503), the command fails (503),
            or it times out (504)
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
            env=get_docker_env(),
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

    except OSError as e:
        # Harbor not installed, not executable, ... - previously escaped as a
        # bare 500 FileNotFoundError.
        logger.error(f"Cannot execute Harbor CLI at {HARBOR_SCRIPT}: {e}")
        raise _harbor_missing(service_id, e) from e


async def _run_docker(args: list[str], timeout: int) -> tuple[int, str]:
    """
    Run a Docker command, reporting rather than raising on failure.

    Args:
        args: Arguments after the `docker` executable
        timeout: Timeout in seconds

    Returns:
        Tuple of (return_code, stderr); return code 127 means Docker is missing
        and 124 means it timed out.
    """
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["docker", *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=get_docker_env(),
        )
    except FileNotFoundError as e:
        return 127, f"docker CLI not found: {e}"
    except subprocess.TimeoutExpired:
        return 124, f"'docker {args[0]}' timed out after {timeout}s"

    return result.returncode, (result.stderr or "").strip()


def _require_service(service_id: str) -> None:
    """
    Raise 404 unless the service exists in the catalog.

    Args:
        service_id: Service ID to validate

    Raises:
        HTTPException: 404 if the service is unknown
    """
    if get_service_definition(service_id) is None:
        raise HTTPException(
            status_code=404,
            detail={
                "type": "https://lem.gg/errors/service-not-found",
                "title": "Service Not Found",
                "detail": f"Service '{service_id}' not found in catalog",
            },
        )


def _job_conflict(service_id: str, job_id: str | None) -> HTTPException:
    """Build an RFC7807 409 for a service that already has an active job."""
    detail: dict[str, str] = {
        "type": "https://lem.gg/errors/job-in-progress",
        "title": "Job Already In Progress",
        "detail": f"Service '{service_id}' already has an active job",
    }
    if job_id:
        detail["job_id"] = job_id
    return HTTPException(status_code=409, detail=detail)


def _create_job_or_conflict(job_type: JobType, service_id: str) -> str:
    """
    Create a job, refusing if the service already has an active one.

    The pre-check is only an optimisation for a nicer error; the guarantee
    comes from the partial unique index on jobs(service_id) for non-terminal
    rows, which closes the race where two concurrent installs both passed the
    check and both enqueued.

    Args:
        job_type: Type of job to create
        service_id: Service the job operates on

    Returns:
        The new job ID

    Raises:
        HTTPException: 409 if a job is already active for the service
    """
    active_job = get_active_job_for_service(service_id)
    if active_job:
        raise _job_conflict(service_id, active_job.id)

    try:
        job = create_job(job_type, service_id)
    except ActiveJobExistsError as e:
        existing = get_active_job_for_service(service_id)
        raise _job_conflict(service_id, existing.id if existing else None) from e

    logger.info(f"Created {job_type.value} job {job.id} for {service_id}")
    return job.id


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
    _require_service(service_id)
    return _create_job_or_conflict(JobType.INSTALL, service_id)


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
    _require_service(service_id)

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
    _require_service(service_id)

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


async def install_service_inline(service_id: str) -> None:
    """
    Pull and start a service, waiting for it to finish.

    Used by the legacy /v1/runners and /v1/clients endpoints, which promised a
    synchronous result before the job queue existed. Prefer install_service().

    Args:
        service_id: Service ID to install

    Raises:
        HTTPException: 404 if unknown, 503/504 if Harbor fails
    """
    _require_service(service_id)

    await _run_harbor_command(
        ["up", "--no-defaults", service_id],
        INSTALL_TIMEOUT,
        service_id,
    )


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
    _require_service(service_id)
    return _create_job_or_conflict(JobType.REMOVE, service_id)


async def _handle_remove_job(job: Job) -> None:
    """
    Handle a remove job (called by job queue worker).

    Args:
        job: Job to process

    Raises:
        RuntimeError: If any removal step failed, so the job is marked failed
            instead of reporting a success it did not achieve
    """
    service_id = job.service_id
    failures: list[str] = []

    # Stop the service first
    update_job_progress(job.id, 20, "Stopping service...")

    try:
        await _run_harbor_command(
            ["down", service_id],
            STOP_TIMEOUT,
            service_id,
        )
    except HTTPException as e:
        # Not fatal: the service may already be down, or Harbor may be gone.
        logger.warning(f"harbor down {service_id} did not succeed: {e.detail}")

    # Resolve the exact image BEFORE the containers are gone
    image = resolve_service_image(service_id)

    update_job_progress(job.id, 50, "Removing containers...")

    try:
        containers = await asyncio.to_thread(list_service_containers, service_id)
    except DockerUnavailableError as e:
        raise RuntimeError(f"Cannot remove {service_id}: {e}") from e

    for container in containers:
        code, stderr = await _run_docker(["rm", "-f", container], CONTAINER_RM_TIMEOUT)
        if code != 0 and "No such container" not in stderr:
            failures.append(f"docker rm {container} exited {code}: {stderr}")
        else:
            logger.info(f"Removed container: {container}")

    update_job_progress(job.id, 80, "Removing image...")

    if image is None:
        # The compose file builds the image locally or leaves the reference
        # unresolved. Removing a guess is how "remove agent" used to delete
        # openhands/agent-server, so do nothing instead.
        logger.info(f"No exact image known for {service_id}; leaving images untouched")
        message = "Service removed (image kept: no exact image reference)"
    else:
        code, stderr = await _run_docker(["rmi", image], IMAGE_RM_TIMEOUT)
        if code == 0:
            logger.info(f"Removed image: {image}")
            message = f"Service removed (image {image} deleted)"
        elif "No such image" in stderr:
            message = "Service removed (image was not present)"
        else:
            failures.append(f"docker rmi {image} exited {code}: {stderr}")
            message = f"Service removed (image {image} could not be deleted)"

    if failures:
        raise RuntimeError("; ".join(failures))

    update_job_progress(job.id, 100, message)


def register_job_handlers() -> None:
    """
    Register job handlers with the job queue.

    This should be called during app startup after the job queue is initialized.
    """
    queue = get_job_queue()
    queue.register_handler(JobType.INSTALL, _handle_install_job)
    queue.register_handler(JobType.REMOVE, _handle_remove_job)
    logger.info("Registered service job handlers")
