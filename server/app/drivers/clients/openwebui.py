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
Open WebUI Client Driver for Lem v0.1

Provides lifecycle management for Open WebUI via Harbor CLI:
- install: Pull and configure Open WebUI container
- start: Start Open WebUI service (idempotent)
- stop: Stop Open WebUI service

All operations use Harbor CLI via the harbor_wrapper module.
Harbor automatically configures Open WebUI → Ollama binding.
"""

import logging

from fastapi import HTTPException

from app.drivers.harbor_wrapper import HarborError, harbor_down, harbor_ps, harbor_up

logger = logging.getLogger(__name__)


async def install_openwebui() -> dict[str, str]:
    """
    Install Open WebUI via Harbor CLI.

    This performs the initial pull of the Open WebUI container image.
    Uses a longer timeout (10 minutes) for the initial image pull.
    Harbor automatically configures the connection to Ollama.

    Returns:
        dict: {"status": "ok", "message": "Open WebUI installed successfully"}

    Raises:
        HTTPException: 503 if Harbor CLI fails, 504 if timeout
    """
    logger.info("Installing Open WebUI via Harbor CLI")
    try:
        # Use longer timeout for initial image pull
        # Note: Harbor CLI uses "webui" as the service name for Open WebUI
        exit_code, stdout, stderr = harbor_up("webui", timeout=600)
        logger.info(f"Open WebUI installation completed (exit code: {exit_code})")
        return {"status": "ok", "message": "Open WebUI installed successfully"}

    except HarborError as e:
        logger.error(f"Open WebUI installation failed: {e}")

        # Handle timeout (exit code 124)
        if e.exit_code == 124:
            raise HTTPException(
                status_code=504,
                detail={
                    "type": "https://lem.gg/errors/harbor-timeout",
                    "title": "Harbor CLI Timeout",
                    "detail": str(e),
                },
            ) from e

        # Handle other Harbor CLI errors
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/harbor-unavailable",
                "title": "Harbor CLI Unavailable",
                "detail": str(e),
                "harbor_stderr": e.stderr,
            },
        ) from e


async def start_openwebui() -> dict[str, str]:
    """
    Start Open WebUI service via Harbor CLI.

    This operation is idempotent - if Open WebUI is already running, it succeeds.
    Harbor automatically binds Open WebUI to Ollama.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails, 504 if timeout
    """
    logger.info("Starting Open WebUI via Harbor CLI")
    try:
        # Note: Harbor CLI uses "webui" as the service name for Open WebUI
        exit_code, stdout, stderr = harbor_up("webui")
        logger.info(f"Open WebUI start completed (exit code: {exit_code})")
        return {"status": "ok"}

    except HarborError as e:
        logger.error(f"Open WebUI start failed: {e}")

        # Handle timeout (exit code 124)
        if e.exit_code == 124:
            raise HTTPException(
                status_code=504,
                detail={
                    "type": "https://lem.gg/errors/harbor-timeout",
                    "title": "Harbor CLI Timeout",
                    "detail": str(e),
                },
            ) from e

        # Handle other Harbor CLI errors
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/harbor-unavailable",
                "title": "Harbor CLI Unavailable",
                "detail": str(e),
                "harbor_stderr": e.stderr,
            },
        ) from e


async def stop_openwebui() -> dict[str, str]:
    """
    Stop Open WebUI service via Harbor CLI.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails
    """
    logger.info("Stopping Open WebUI via Harbor CLI")
    try:
        # Note: Harbor CLI uses "webui" as the service name for Open WebUI
        exit_code, stdout, stderr = harbor_down("webui")
        logger.info(f"Open WebUI stop completed (exit code: {exit_code})")
        return {"status": "ok"}

    except HarborError as e:
        logger.error(f"Open WebUI stop failed: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/harbor-unavailable",
                "title": "Harbor CLI Unavailable",
                "detail": str(e),
                "harbor_stderr": e.stderr,
            },
        ) from e


async def get_openwebui_status() -> str:
    """
    Get Open WebUI container status.

    Queries Docker to check if the Open WebUI container is running.
    Uses harbor_ps() which calls `docker ps --format json`.

    Returns:
        str: "running" | "stopped" | "error"
            - "running": Container is running
            - "stopped": Container exists but is not running, or doesn't exist
            - "error": Error querying Docker status

    Note:
        Harbor uses "webui" as the service name for Open WebUI.
        This function only checks if the container is running, not the service health.
    """
    try:
        services = harbor_ps()

        # Look for "webui" service in Harbor services
        # Note: Harbor uses "webui" as the service name, not "openwebui"
        if "webui" in services:
            service_status = services["webui"]["status"]
            # Docker states: running, exited, created, paused, restarting, removing, dead
            if service_status == "running":
                return "running"
            else:
                return "stopped"
        else:
            # No webui container found
            return "stopped"

    except Exception as e:
        logger.error(f"Error checking Open WebUI status: {e}")
        return "error"


def get_openwebui_url() -> str:
    """
    Get the Open WebUI URL with the actual dynamically-mapped port.

    Harbor maps Open WebUI to a dynamic port, so we need to query Docker to find it.
    Falls back to the standard port 3000 if discovery fails.

    Returns:
        str: The Open WebUI URL (e.g., "http://127.0.0.1:33801")

    Note:
        Harbor uses "webui" as the service name for Open WebUI.
        Open WebUI container exposes port 8080, which Harbor maps to a dynamic host port.
    """
    try:
        # Use harbor_ps to get service info with parsed ports
        services = harbor_ps()
        if "webui" in services:
            host_port = services["webui"].get("host_port")
            if host_port:
                logger.debug(f"Discovered Open WebUI on host port {host_port}")
                return f"http://127.0.0.1:{host_port}"

        # Fallback to standard port
        logger.warning("Could not discover Open WebUI port, using default 3000")
        return "http://127.0.0.1:3000"

    except Exception as e:
        logger.warning(f"Error discovering Open WebUI port: {e}, using default 3000")
        return "http://127.0.0.1:3000"
