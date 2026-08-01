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

This module is the single place that shells out to `docker`; everything else
goes through it so the Docker endpoint (DOCKER_HOST) is resolved once, in one
platform-aware way.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
from collections.abc import Collection

from fastapi import HTTPException

from app.catalog import get_all_services, get_service_definition, scan_harbor_services
from app.catalog.models import Service, ServiceStatus
from app.config.platform import DOCKER_HOST

logger = logging.getLogger(__name__)

# Harbor names every container it manages "harbor.<something>"
CONTAINER_PREFIX = "harbor."

# Docker CLI calls are cheap; anything slower than this means a wedged daemon
DOCKER_TIMEOUT = 10

# Docker states that mean "the container exists but is not serving"
_STOPPED_STATES = frozenset({"exited", "created", "paused", "dead", "removing"})


class DockerUnavailableError(RuntimeError):
    """Raised when the Docker daemon cannot be reached or the CLI is missing."""


def get_docker_env() -> dict[str, str]:
    """Get environment with the platform's Docker endpoint configured."""
    return {
        **os.environ,
        "DOCKER_HOST": DOCKER_HOST,
    }


def _run_docker(args: list[str]) -> str:
    """
    Run a read-only `docker` command and return stdout.

    Args:
        args: Arguments after the `docker` executable

    Returns:
        Captured stdout

    Raises:
        DockerUnavailableError: Docker is missing, unreachable, or hung
    """
    try:
        result = subprocess.run(
            ["docker", *args],
            capture_output=True,
            text=True,
            timeout=DOCKER_TIMEOUT,
            check=True,
            env=get_docker_env(),
        )
    except FileNotFoundError as e:
        raise DockerUnavailableError(
            "The 'docker' CLI was not found on PATH. Install Docker to manage services."
        ) from e
    except subprocess.TimeoutExpired as e:
        raise DockerUnavailableError(
            f"'docker {args[0]}' timed out after {DOCKER_TIMEOUT}s using DOCKER_HOST={DOCKER_HOST}"
        ) from e
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        raise DockerUnavailableError(
            f"'docker {args[0]}' failed using DOCKER_HOST={DOCKER_HOST}: {stderr[:300]}"
        ) from e

    return result.stdout


def _docker_unavailable(exc: DockerUnavailableError) -> HTTPException:
    """Build an RFC7807 503 for an unreachable Docker daemon."""
    return HTTPException(
        status_code=503,
        detail={
            "type": "https://lem.gg/errors/docker-unavailable",
            "title": "Docker Unavailable",
            "detail": str(exc),
            "docker_host": DOCKER_HOST,
        },
    )


def probe_docker() -> tuple[bool, str]:
    """
    Check whether the Docker daemon is actually reachable.

    Returns:
        (True, server version) or (False, reason)
    """
    try:
        version = _run_docker(["version", "--format", "{{.Server.Version}}"]).strip()
    except DockerUnavailableError as e:
        return False, str(e)

    return True, version or "unknown"


def container_to_service_id(container_name: str, known_ids: Collection[str]) -> str | None:
    """
    Map a Harbor container name to a catalog service ID.

    Harbor runs one container per compose service, named
    "harbor.<compose-service>". Auxiliary containers get a suffix
    ("harbor.ollama-init", "harbor.dify-api"), and some service IDs contain a
    hyphen of their own ("mcp-inspector"). Splitting on the first hyphen -
    what this used to do - keyed "harbor.mcp-inspector" as "mcp", so the
    service reported not_installed while it was running.

    Resolution is longest-match against the catalog, so:
        harbor.mcp-inspector -> mcp-inspector
        harbor.ollama-init   -> ollama
        harbor.dify-api      -> dify

    Args:
        container_name: Docker container name (e.g. "harbor.ollama-init")
        known_ids: Service IDs known to the catalog

    Returns:
        Service ID, or None if the container does not belong to a known service
    """
    if not container_name.startswith(CONTAINER_PREFIX):
        return None

    base = container_name[len(CONTAINER_PREFIX) :]
    parts = base.split("-")

    for end in range(len(parts), 0, -1):
        candidate = "-".join(parts[:end])
        if candidate in known_ids:
            return candidate

    return None


def _get_containers() -> dict[str, dict[str, str]]:
    """
    Get all Harbor containers from Docker, keyed by service ID.

    Returns:
        Dict mapping service_id to {"status": ..., "ports": ...}

    Raises:
        DockerUnavailableError: If Docker cannot be reached
    """
    stdout = _run_docker(["ps", "-a", "--filter", f"name={CONTAINER_PREFIX}", "--format", "json"])

    known_ids = set(scan_harbor_services())
    containers: dict[str, dict[str, str]] = {}
    # Service IDs whose entry came from an exactly-named container; those win
    # over sidecars such as harbor.dify-worker.
    exact_matches: set[str] = set()

    for line in stdout.strip().split("\n"):
        if not line:
            continue

        try:
            container = json.loads(line)
        except json.JSONDecodeError as e:
            logger.warning(f"Skipping unparsable docker ps line: {e}")
            continue

        name = str(container.get("Names", ""))
        service_id = container_to_service_id(name, known_ids)
        if service_id is None:
            continue

        is_exact = name == f"{CONTAINER_PREFIX}{service_id}"
        if service_id in containers and (service_id in exact_matches or not is_exact):
            continue

        containers[service_id] = {
            "status": str(container.get("State", "unknown")),
            "ports": str(container.get("Ports", "")),
        }
        if is_exact:
            exact_matches.add(service_id)

    return containers


def list_service_containers(service_id: str) -> list[str]:
    """
    List every container name belonging to a service.

    A service can own several containers ("harbor.dify-api",
    "harbor.dify-worker", "harbor.ollama-init", ...); removal has to clean up
    all of them, not just "harbor.<service_id>".

    Args:
        service_id: Service ID to look up

    Returns:
        Container names, most specific first

    Raises:
        DockerUnavailableError: If Docker cannot be reached
    """
    stdout = _run_docker(
        ["ps", "-a", "--filter", f"name={CONTAINER_PREFIX}", "--format", "{{.Names}}"]
    )

    known_ids = set(scan_harbor_services())
    names = []

    for line in stdout.splitlines():
        name = line.strip()
        if name and container_to_service_id(name, known_ids) == service_id:
            names.append(name)

    return sorted(names)


def _normalize_image_ref(image: str) -> str:
    """
    Normalize a Docker image reference so it can be compared to `docker images`.

    `docker images --format {{.Repository}}:{{.Tag}}` always emits a tag, so an
    untagged compose reference needs ":latest" appended. A colon in the
    registry host ("localhost:5000/foo") is not a tag.
    """
    last_segment = image.rsplit("/", 1)[-1]
    if ":" in last_segment:
        return image
    return f"{image}:latest"


def resolve_service_image(service_id: str) -> str | None:
    """
    Get the fully-resolved Docker image reference for a service.

    Args:
        service_id: Service ID to look up

    Returns:
        Normalized image reference, or None when the compose file builds the
        image locally or leaves a variable unresolved.
    """
    service_def = get_service_definition(service_id)
    if service_def is None or not service_def.image:
        return None

    if "$" in service_def.image:
        # An unresolved compose variable - we cannot claim to know the image.
        logger.debug(f"Unresolved image reference for {service_id}: {service_def.image}")
        return None

    return _normalize_image_ref(service_def.image)


def _get_local_images() -> set[str]:
    """
    Get every image reference present locally, in one Docker call.

    Returns:
        Set of "repository:tag" strings

    Raises:
        DockerUnavailableError: If Docker cannot be reached
    """
    stdout = _run_docker(["images", "--format", "{{.Repository}}:{{.Tag}}"])
    return {line.strip() for line in stdout.splitlines() if line.strip()}


def _image_is_installed(service_id: str, local_images: set[str]) -> bool:
    """
    Check whether a service's image is present locally.

    Uses exact image references only. The previous implementation asked whether
    the service ID appeared anywhere in any image name, so "agent" matched
    "openhands/agent-server" and "bench" matched anything benchmark-shaped.

    Args:
        service_id: Service ID to check
        local_images: Result of _get_local_images()

    Returns:
        True if the image exists locally
    """
    image = resolve_service_image(service_id)
    if image is not None:
        return image in local_images

    # Services whose compose file uses `build:` have no image reference. Docker
    # Compose names those "<project>-<service>", and Harbor's project is
    # "harbor", so this is the only other reference we can name exactly.
    return _normalize_image_ref(f"harbor-{service_id}") in local_images


def _status_from_container(container_status: str) -> ServiceStatus:
    """Translate a Docker container state into a ServiceStatus."""
    if container_status == "running":
        return ServiceStatus.RUNNING
    if container_status in _STOPPED_STATES:
        return ServiceStatus.STOPPED
    return ServiceStatus.ERROR


def _parse_host_port(
    ports_str: str, container_port: int | None = None, *, strict: bool = False
) -> int | None:
    """
    Parse the host port from Docker port mappings.

    Two modes, because the two callers have very different failure costs:

    - **strict**: only an exact `<host_port>-><container_port>/tcp` match counts.
      A miss returns None, and an unknown `container_port` is itself a miss - you
      cannot match exactly against an unknown target. Used by tunnel routing,
      where a guessed port sends an authenticated request to whatever else
      happens to be listening on the host.
    - lenient (default): fall through to the first host port anywhere in the
      string. Used by the local dashboard's own `endpoint`/`host_port` display,
      where a wrong guess is a broken link on the user's own machine.

    Args:
        ports_str: Docker ports string like "0.0.0.0:33821->11434/tcp"
        container_port: Container port to find mapping for (optional)
        strict: Refuse to guess when the container port does not match

    Returns:
        Host port or None
    """
    if not ports_str:
        return None

    if container_port:
        # Pattern: look for <host_port>-><container_port>/tcp
        pattern = rf"(?:0\.0\.0\.0:|::]:)?(\d+)->{container_port}/tcp"
        match = re.search(pattern, ports_str)
        if match:
            return int(match.group(1))

    if strict:
        return None

    # Fallback: extract the first host port from the string
    # Pattern matches: "0.0.0.0:33891->33891/tcp" or "[::]:33891->33891/tcp"
    fallback_pattern = r"(?:0\.0\.0\.0:|:\]:|\[::\]:)(\d+)->"
    match = re.search(fallback_pattern, ports_str)
    if match:
        return int(match.group(1))

    return None


def _endpoint_for(
    service_id: str, container: dict[str, str], *, strict: bool = False
) -> tuple[int | None, str | None]:
    """Resolve (host_port, endpoint URL) for a container, if it publishes a port.

    Args:
        service_id: Service ID the container belongs to
        container: Container record from :func:`_get_containers`
        strict: Pass through to :func:`_parse_host_port`; see its docstring

    Returns:
        (host port, endpoint URL), or (None, None) when no port resolves
    """
    service_def = get_service_definition(service_id)
    container_port = service_def.container_port if service_def else None
    host_port = _parse_host_port(container.get("ports", ""), container_port, strict=strict)

    if host_port is None:
        return None, None

    return host_port, f"http://127.0.0.1:{host_port}"


def get_service_url(service_id: str) -> str | None:
    """
    Resolve a running service's local URL, synchronously and without raising.

    Used by callers that cannot await (e.g. tunnel request routing), and
    therefore **strict**: when the container's published ports do not exactly
    map the catalog's `container_port`, this returns None rather than the first
    port it can find. The tunnel must not forward to an address it cannot
    positively resolve, for the same reason it must not extend credentials to a
    peer it cannot positively identify.

    Args:
        service_id: Service ID to look up

    Returns:
        URL like "http://127.0.0.1:33801", or None if not running, not exactly
        resolvable, or Docker is down
    """
    try:
        containers = _get_containers()
    except DockerUnavailableError as e:
        logger.warning(f"Cannot resolve URL for {service_id}: {e}")
        return None

    container = containers.get(service_id)
    if container is None or container.get("status") != "running":
        return None

    _, endpoint = _endpoint_for(service_id, container, strict=True)
    if endpoint is None:
        logger.warning(
            f"Refusing to guess a port for {service_id}: published ports "
            f"{container.get('ports', '')!r} do not map its catalog container port"
        )
    return endpoint


async def get_service_status(service_id: str) -> ServiceStatus:
    """
    Get the current status of a service.

    Status determination:
    - RUNNING: Container exists and is running
    - STOPPED: Image exists but container not running
    - NOT_INSTALLED: Image doesn't exist
    - ERROR: Container exists but in an unexpected state

    Args:
        service_id: Service ID to check

    Returns:
        ServiceStatus enum value

    Raises:
        HTTPException: 503 if Docker cannot be reached
    """
    try:
        containers = await asyncio.to_thread(_get_containers)

        if service_id in containers:
            return _status_from_container(containers[service_id].get("status", ""))

        local_images = await asyncio.to_thread(_get_local_images)
    except DockerUnavailableError as e:
        raise _docker_unavailable(e) from e

    if _image_is_installed(service_id, local_images):
        return ServiceStatus.STOPPED

    return ServiceStatus.NOT_INSTALLED


async def get_service_endpoint(service_id: str) -> str | None:
    """
    Get the endpoint URL for a running service.

    Args:
        service_id: Service ID to get endpoint for

    Returns:
        Endpoint URL or None if not running

    Raises:
        HTTPException: 503 if Docker cannot be reached
    """
    if get_service_definition(service_id) is None:
        return None

    try:
        containers = await asyncio.to_thread(_get_containers)
    except DockerUnavailableError as e:
        raise _docker_unavailable(e) from e

    container = containers.get(service_id)
    if container is None:
        return None

    _, endpoint = _endpoint_for(service_id, container)
    return endpoint


async def get_all_services_with_status() -> list[Service]:
    """
    Get all services from the catalog with their current runtime status.

    Issues exactly two Docker calls regardless of catalog size. It used to run
    one blocking `docker images` per service (89 subprocesses per request).

    Returns:
        List of Service objects with status populated

    Raises:
        HTTPException: 503 if Docker cannot be reached
    """
    all_definitions = get_all_services()

    try:
        containers = await asyncio.to_thread(_get_containers)
        local_images = await asyncio.to_thread(_get_local_images)
    except DockerUnavailableError as e:
        raise _docker_unavailable(e) from e

    services: list[Service] = []

    for svc_def in all_definitions:
        container = containers.get(svc_def.id)

        if container is not None:
            status = _status_from_container(container.get("status", ""))
        elif _image_is_installed(svc_def.id, local_images):
            status = ServiceStatus.STOPPED
        else:
            status = ServiceStatus.NOT_INSTALLED

        host_port: int | None = None
        endpoint: str | None = None
        if status == ServiceStatus.RUNNING and container is not None:
            host_port, endpoint = _endpoint_for(svc_def.id, container)

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
