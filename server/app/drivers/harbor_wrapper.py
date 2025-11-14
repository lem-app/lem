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
Harbor CLI wrapper for Lem v0.1 (CORRECTED)

Provides safe subprocess execution of Harbor CLI commands with:
- Timeout handling (default 5 minutes)
- Error capture and logging
- Version validation
- DOCKER_HOST env var for DSP routing

IMPORTANT CORRECTIONS from original design:
1. Harbor is at ~/.lem/harbor/harbor.sh (not /usr/local/bin/harbor binary)
2. Docker routing via DOCKER_HOST env var (not HARBOR_CONFIG)
3. No harbor-config.yaml file (Harbor uses .env, but we don't need it)
4. Harbor version is 0.3.20 (not 1.2.3)

See docs/harbor_review_2025-10-24.md for detailed explanation of corrections.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

# Harbor installation path (cloned git repo)
HARBOR_SCRIPT = Path.home() / ".lem" / "harbor" / "harbor.sh"

# DSP socket path
# TODO: Switch to DSP socket when Phase 1.3 is complete
# DSP_SOCKET = Path("/run/lem/lem-docker-proxy.sock")
# For now, use actual Docker socket for testing
DSP_SOCKET = Path.home() / ".docker" / "run" / "docker.sock"

DEFAULT_TIMEOUT = 300  # 5 minutes


class HarborError(Exception):
    """Raised when Harbor CLI operation fails"""

    def __init__(self, message: str, stderr: str = "", exit_code: int = 1):
        super().__init__(message)
        self.stderr = stderr
        self.exit_code = exit_code


def check_harbor_installed() -> str:
    """
    Verify Harbor CLI is installed and get version.

    Returns:
        str: Harbor version (e.g., "0.3.20")

    Raises:
        HarborError: If Harbor CLI not found or wrong version
    """
    try:
        result = subprocess.run(
            [str(HARBOR_SCRIPT), "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=True,
        )
        # Parse version from output (format may vary)
        # TODO: Test actual output format from Harbor v0.3.20
        version = result.stdout.strip().split()[-1]
        logger.info(f"Harbor CLI version: {version}")
        return version
    except FileNotFoundError as e:
        raise HarborError(f"Harbor CLI not found at {HARBOR_SCRIPT}") from e
    except subprocess.CalledProcessError as e:
        raise HarborError(f"Harbor version check failed: {e.stderr}", e.stderr, e.returncode) from e


def harbor_up(
    service: str, timeout: int = DEFAULT_TIMEOUT, skip_defaults: bool = True
) -> tuple[int, str, str]:
    """
    Start a Harbor service (idempotent).

    Args:
        service: Service name (e.g., "ollama", "webui")
        timeout: Timeout in seconds (default 300)
        skip_defaults: If True, pass --no-defaults to prevent Harbor from starting
                      default services (Ollama + Open WebUI stack). Default is True
                      to allow independent service control.

    Returns:
        tuple[exit_code, stdout, stderr]

    Raises:
        HarborError: If command fails or times out
    """
    logger.info(f"Starting Harbor service: {service} (skip_defaults={skip_defaults})")

    # WHY: We set DOCKER_HOST to route all Docker operations through DSP
    # Harbor uses standard Docker environment variables, not Harbor-specific config
    env = {
        **os.environ,  # Preserve existing env
        "DOCKER_HOST": f"unix://{DSP_SOCKET}",
    }

    # Build command list conditionally to avoid empty string args
    cmd = [str(HARBOR_SCRIPT), "up"]
    if skip_defaults:
        cmd.append("--no-defaults")
    cmd.append(service)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=True,
            env=env,
        )
        logger.info(f"Harbor service {service} started successfully")
        return result.returncode, result.stdout, result.stderr

    except subprocess.TimeoutExpired as e:
        logger.error(f"Harbor up {service} timed out after {timeout}s")
        raise HarborError(
            f"harbor up {service} timed out after {timeout} seconds",
            exit_code=124,  # Standard timeout exit code
        ) from e

    except subprocess.CalledProcessError as e:
        logger.error(f"Harbor up {service} failed: {e.stderr}")
        raise HarborError(
            f"harbor up {service} exited with code {e.returncode}",
            stderr=e.stderr,
            exit_code=e.returncode,
        ) from e


def harbor_down(service: str, timeout: int = 60) -> tuple[int, str, str]:
    """
    Stop a Harbor service.

    Args:
        service: Service name
        timeout: Timeout in seconds (default 60)

    Returns:
        tuple[exit_code, stdout, stderr]

    Raises:
        HarborError: If command fails
    """
    logger.info(f"Stopping Harbor service: {service}")

    # Set DOCKER_HOST for DSP routing
    env = {
        **os.environ,
        "DOCKER_HOST": f"unix://{DSP_SOCKET}",
    }

    try:
        result = subprocess.run(
            [str(HARBOR_SCRIPT), "down", service],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=True,
            env=env,
        )
        logger.info(f"Harbor service {service} stopped successfully")
        return result.returncode, result.stdout, result.stderr

    except subprocess.CalledProcessError as e:
        logger.error(f"Harbor down {service} failed: {e.stderr}")
        raise HarborError(
            f"harbor down {service} exited with code {e.returncode}",
            stderr=e.stderr,
            exit_code=e.returncode,
        ) from e


def parse_host_port(ports_str: str, container_port: int) -> int | None:
    """
    Parse Docker port mapping string to extract host port for a given container port.

    Args:
        ports_str: Docker ports string (e.g., "0.0.0.0:33821->11434/tcp, [::]:33821->11434/tcp")
        container_port: Container port to look for (e.g., 11434)

    Returns:
        int: Host port number if found, None otherwise

    Examples:
        >>> parse_host_port("0.0.0.0:33821->11434/tcp", 11434)
        33821
        >>> parse_host_port("0.0.0.0:33801->8080/tcp, [::]:33801->8080/tcp", 8080)
        33801
        >>> parse_host_port("", 11434)
        None
    """
    if not ports_str:
        return None

    # Docker port format: "0.0.0.0:33821->11434/tcp" or multiple mappings separated by ", "
    # We want to extract the host port (33821) for the given container port (11434)
    import re

    # Pattern: look for <host_port>-><container_port>/tcp
    # The host_port might be prefixed with 0.0.0.0: or [::]
    pattern = rf"(?:0\.0\.0\.0:|::]:)?(\d+)->{container_port}/tcp"
    match = re.search(pattern, ports_str)

    if match:
        return int(match.group(1))

    return None


def harbor_ps() -> dict[str, dict[str, str | bool | int | None]]:
    """
    Get status of all Harbor services.

    Uses Docker CLI directly since harbor ps doesn't support JSON output.
    Filters for containers with 'harbor.' prefix.

    Returns:
        dict: {
            "service_name": {
                "status": "running" | "exited" | "created",
                "health": bool,  # True if healthy, False otherwise
                "ports": str,    # Raw port mappings string
                "host_port": int | None  # Parsed host port for primary service port
            },
            ...
        }
        Empty dict if no Harbor services running.
    """
    env = {
        **os.environ,
        "DOCKER_HOST": f"unix://{DSP_SOCKET}",
    }

    try:
        # Use docker ps with JSON format - harbor ps doesn't support --json
        result = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=harbor.", "--format", "json"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
            env=env,
        )

        # Parse newline-delimited JSON
        services: dict[str, dict[str, str | bool | int | None]] = {}
        for line in result.stdout.strip().split("\n"):
            if not line:
                continue

            container = json.loads(line)

            # Extract service name from container name (harbor.ollama -> ollama)
            # Handle both harbor.ollama and harbor.ollama-init containers
            name = container["Names"]
            if name.startswith("harbor."):
                service_name = name.replace("harbor.", "").split("-")[0]

                # Only track main service containers (ignore -init, -helper, etc.)
                if service_name not in services:
                    ports_str = container["Ports"]

                    # Parse host port for each service's primary port
                    # Ollama uses 11434, Open WebUI uses 8080
                    container_port = 11434 if service_name == "ollama" else 8080
                    host_port = parse_host_port(ports_str, container_port)

                    services[service_name] = {
                        "status": container["State"],
                        "health": "healthy" in container["Status"].lower(),
                        "ports": ports_str,
                        "host_port": host_port,
                    }

        return services

    except subprocess.CalledProcessError as e:
        logger.warning(f"Docker ps failed: {e.stderr}")
        return {}
    except json.JSONDecodeError as e:
        logger.error(f"Failed to parse docker ps JSON output: {e}")
        return {}


def check_harbor_requirements() -> tuple[bool, list[str]]:
    """
    Run harbor doctor to validate system requirements.

    Checks:
    - Docker installed and running
    - Docker Compose v2 installed (>2.23.1)
    - Harbor home directory accessible
    - Profile files readable

    Returns:
        tuple[bool, list[str]]: (all_checks_passed, list_of_error_messages)

    Example:
        >>> ok, issues = check_harbor_requirements()
        >>> if not ok:
        ...     for issue in issues:
        ...         print(f"ERROR: {issue}")
    """
    try:
        result = subprocess.run(
            [str(HARBOR_SCRIPT), "doctor"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,  # Don't raise on non-zero exit
        )

        # Parse output for ERROR lines
        errors = []
        for line in result.stdout.split("\n"):
            if "[ERROR]" in line:
                # Extract error message after the ✘ symbol
                msg = line.split("✘")[-1].strip()
                errors.append(msg)

        logger.info(f"Harbor doctor completed with {len(errors)} errors")
        return len(errors) == 0, errors

    except subprocess.TimeoutExpired:
        logger.error("Harbor doctor timed out")
        return False, ["Harbor doctor timed out after 10 seconds"]
    except FileNotFoundError:
        return False, [f"Harbor CLI not found at {HARBOR_SCRIPT}"]
    except Exception as e:
        logger.error(f"Harbor doctor failed: {e}")
        return False, [str(e)]


# TODO: Add additional Harbor CLI wrapper functions as needed:
# - harbor_restart(service)
# - harbor_logs(service, tail=100)
# - harbor_url(service) - get service URL
