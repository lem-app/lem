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
Service status checking operations.

Determines the runtime status of Harbor services by querying Docker.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path

from app.catalog import get_all_services, get_service_definition
from app.catalog.models import Service, ServiceStatus

logger = logging.getLogger(__name__)

# DSP/Docker socket path
DSP_SOCKET = Path.home() / ".docker" / "run" / "docker.sock"


def _get_docker_env() -> dict[str, str]:
    """Get environment with Docker socket configured."""
    return {
        **os.environ,
        "DOCKER_HOST": f"unix://{DSP_SOCKET}",
    }


def _get_running_containers() -> dict[str, dict[str, str | int | None]]:
    """
    Get all running Harbor containers from Docker.

    Returns:
        Dict mapping service_id to container info:
        {
            "ollama": {"status": "running", "host_port": 33821},
            "webui": {"status": "running", "host_port": 33801},
        }
    """
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=harbor.", "--format", "json"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
            env=_get_docker_env(),
        )

        containers: dict[str, dict[str, str | int | None]] = {}

        for line in result.stdout.strip().split("\n"):
            if not line:
                continue

            container = json.loads(line)
            name = container.get("Names", "")

            # Extract service name: harbor.ollama -> ollama
            if name.startswith("harbor."):
                service_id = name.replace("harbor.", "").split("-")[0]

                # Only track main containers (skip -init, etc.)
                if service_id not in containers:
                    containers[service_id] = {
                        "status": container.get("State", "unknown"),
                        "ports": container.get("Ports", ""),
                    }

        return containers

    except subprocess.CalledProcessError as e:
        logger.warning(f"Failed to get running containers: {e}")
        return {}
    except Exception as e:
        logger.warning(f"Error getting running containers: {e}")
        return {}


def _check_image_exists(service_id: str) -> bool:
    """
    Check if the Docker image for a service exists locally.

    This determines if a service is "installed" (image pulled) vs "not_installed".

    Args:
        service_id: Service ID to check

    Returns:
        True if image exists, False otherwise
    """
    # Get the service definition to find the image name
    service_def = get_service_definition(service_id)
    if not service_def:
        return False

    # Image might be templated: ${HARBOR_OLLAMA_VERSION}
    # We can check by listing images with the harbor filter
    try:
        result = subprocess.run(
            ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
            env=_get_docker_env(),
        )

        images = result.stdout.strip().split("\n")

        # Check if any image matches common patterns for this service
        # Common patterns: ollama/ollama, ghcr.io/open-webui/open-webui, etc.
        service_patterns = [
            f"{service_id}/",  # ollama/ollama
            f"/{service_id}:",  # */ollama:*
            f"harbor.{service_id}",  # harbor.ollama
        ]

        for image in images:
            image_lower = image.lower()
            for pattern in service_patterns:
                if pattern.lower() in image_lower:
                    return True

        return False

    except subprocess.CalledProcessError:
        return False
    except Exception as e:
        logger.warning(f"Error checking image for {service_id}: {e}")
        return False


def _parse_host_port(ports_str: str, container_port: int) -> int | None:
    """
    Parse the host port from Docker port mappings.

    Args:
        ports_str: Docker ports string like "0.0.0.0:33821->11434/tcp"
        container_port: Container port to find mapping for

    Returns:
        Host port or None
    """
    import re

    if not ports_str:
        return None

    # Pattern: look for <host_port>-><container_port>/tcp
    pattern = rf"(?:0\.0\.0\.0:|::]:)?(\d+)->{container_port}/tcp"
    match = re.search(pattern, ports_str)

    if match:
        return int(match.group(1))

    return None


async def get_service_status(service_id: str) -> ServiceStatus:
    """
    Get the current status of a service.

    Status determination:
    - RUNNING: Container exists and is running
    - STOPPED: Image exists but container not running
    - NOT_INSTALLED: Image doesn't exist
    - ERROR: Container exists but in error state

    Args:
        service_id: Service ID to check

    Returns:
        ServiceStatus enum value
    """
    # Check if container is running
    containers = _get_running_containers()

    if service_id in containers:
        container_status = containers[service_id].get("status", "")
        if container_status == "running":
            return ServiceStatus.RUNNING
        elif container_status in ("exited", "created", "paused"):
            return ServiceStatus.STOPPED
        else:
            return ServiceStatus.ERROR

    # Container not running - check if image exists
    if _check_image_exists(service_id):
        return ServiceStatus.STOPPED

    return ServiceStatus.NOT_INSTALLED


async def get_service_endpoint(service_id: str) -> str | None:
    """
    Get the endpoint URL for a running service.

    Args:
        service_id: Service ID to get endpoint for

    Returns:
        Endpoint URL or None if not running
    """
    service_def = get_service_definition(service_id)
    if not service_def or not service_def.container_port:
        return None

    containers = _get_running_containers()

    if service_id not in containers:
        return None

    ports_str = str(containers[service_id].get("ports", ""))
    host_port = _parse_host_port(ports_str, service_def.container_port)

    if host_port:
        return f"http://127.0.0.1:{host_port}"

    return None


async def get_all_services_with_status() -> list[Service]:
    """
    Get all services from the catalog with their current runtime status.

    Returns:
        List of Service objects with status populated
    """
    all_definitions = get_all_services()
    containers = _get_running_containers()

    services: list[Service] = []

    for svc_def in all_definitions:
        # Determine status
        if svc_def.id in containers:
            container_status = containers[svc_def.id].get("status", "")
            if container_status == "running":
                status = ServiceStatus.RUNNING
            elif container_status in ("exited", "created", "paused"):
                status = ServiceStatus.STOPPED
            else:
                status = ServiceStatus.ERROR
        elif _check_image_exists(svc_def.id):
            status = ServiceStatus.STOPPED
        else:
            status = ServiceStatus.NOT_INSTALLED

        # Get endpoint if running
        endpoint = None
        host_port = None
        if status == ServiceStatus.RUNNING and svc_def.container_port:
            ports_str = str(containers[svc_def.id].get("ports", ""))
            host_port = _parse_host_port(ports_str, svc_def.container_port)
            if host_port:
                endpoint = f"http://127.0.0.1:{host_port}"

        services.append(
            Service(
                id=svc_def.id,
                name=svc_def.name,
                category=svc_def.category,
                description=svc_def.description,
                status=status,
                host_port=host_port,
                endpoint=endpoint,
                tags=svc_def.tags,
                depends_on=svc_def.depends_on,
                has_api=svc_def.has_api,
                has_ui=svc_def.has_ui,
            )
        )

    return services
