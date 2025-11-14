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
Ollama Runner Driver for Lem v0.1

Provides lifecycle management for Ollama via Harbor CLI:
- install: Pull and configure Ollama container
- start: Start Ollama service (idempotent)
- stop: Stop Ollama service
- health: Check Ollama service health
- models: List/pull/manage Ollama models

All operations use Harbor CLI via the harbor_wrapper module.
"""

import json
import logging
from typing import Any

import httpx
from fastapi import HTTPException

from app.drivers.harbor_wrapper import HarborError, harbor_down, harbor_ps, harbor_up

logger = logging.getLogger(__name__)

# Ollama API configuration
OLLAMA_API_TIMEOUT = 300.0  # 5 minutes for model operations


def _get_ollama_api_base() -> str:
    """
    Get the Ollama API base URL by discovering the actual port from Docker.

    Harbor maps Ollama to a dynamic port, so we need to query Docker to find it.
    Falls back to the standard port 11434 if discovery fails.

    Returns:
        str: The Ollama API base URL (e.g., "http://127.0.0.1:33821")
    """
    try:
        # Use harbor_ps to get service info with parsed ports
        services = harbor_ps()
        if "ollama" in services:
            host_port = services["ollama"].get("host_port")
            if host_port:
                logger.debug(f"Discovered Ollama on host port {host_port}")
                return f"http://127.0.0.1:{host_port}"

        # Fallback to standard port
        logger.warning("Could not discover Ollama port, using default 11434")
        return "http://127.0.0.1:11434"

    except Exception as e:
        logger.warning(f"Error discovering Ollama port: {e}, using default 11434")
        return "http://127.0.0.1:11434"


async def install_ollama() -> dict[str, str]:
    """
    Install Ollama via Harbor CLI.

    This performs the initial pull of the Ollama container image.
    Uses a longer timeout (10 minutes) for the initial image pull.

    Returns:
        dict: {"status": "ok", "message": "Ollama installed successfully"}

    Raises:
        HTTPException: 503 if Harbor CLI fails, 504 if timeout
    """
    logger.info("Installing Ollama via Harbor CLI")
    try:
        # Use longer timeout for initial image pull
        exit_code, stdout, stderr = harbor_up("ollama", timeout=600)
        logger.info(f"Ollama installation completed (exit code: {exit_code})")
        return {"status": "ok", "message": "Ollama installed successfully"}

    except HarborError as e:
        logger.error(f"Ollama installation failed: {e}")

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


async def start_ollama() -> dict[str, str]:
    """
    Start Ollama service via Harbor CLI.

    This operation is idempotent - if Ollama is already running, it succeeds.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails, 504 if timeout
    """
    logger.info("Starting Ollama via Harbor CLI")
    try:
        exit_code, stdout, stderr = harbor_up("ollama")
        logger.info(f"Ollama start completed (exit code: {exit_code})")
        return {"status": "ok"}

    except HarborError as e:
        logger.error(f"Ollama start failed: {e}")

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


async def stop_ollama() -> dict[str, str]:
    """
    Stop Ollama service via Harbor CLI.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails
    """
    logger.info("Stopping Ollama via Harbor CLI")
    try:
        exit_code, stdout, stderr = harbor_down("ollama")
        logger.info(f"Ollama stop completed (exit code: {exit_code})")
        return {"status": "ok"}

    except HarborError as e:
        logger.error(f"Ollama stop failed: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/harbor-unavailable",
                "title": "Harbor CLI Unavailable",
                "detail": str(e),
                "harbor_stderr": e.stderr,
            },
        ) from e


async def get_ollama_status() -> str:
    """
    Get Ollama container status.

    Queries Docker to check if the Ollama container is running.
    Uses harbor_ps() which calls `docker ps --format json`.

    Returns:
        str: "running" | "stopped" | "error"
            - "running": Container is running
            - "stopped": Container exists but is not running, or doesn't exist
            - "error": Error querying Docker status

    Note:
        This is different from get_ollama_health() which checks the Ollama API health.
        This function only checks if the container is running.
    """
    try:
        services = harbor_ps()

        # Look for "ollama" service in Harbor services
        if "ollama" in services:
            service_status = services["ollama"]["status"]
            # Docker states: running, exited, created, paused, restarting, removing, dead
            if service_status == "running":
                return "running"
            else:
                return "stopped"
        else:
            # No ollama container found
            return "stopped"

    except Exception as e:
        logger.error(f"Error checking Ollama status: {e}")
        return "error"


def get_ollama_endpoint() -> str:
    """
    Get the Ollama API endpoint URL with the actual dynamically-mapped port.

    Returns:
        str: The Ollama endpoint URL (e.g., "http://127.0.0.1:33821")
    """
    return _get_ollama_api_base()


async def get_ollama_health() -> dict[str, Any]:
    """
    Get Ollama service health status.

    TODO: Implement actual health check by calling Ollama API /api/health

    Returns:
        dict: {"status": "ok", "uptime_sec": 1234, "details": {...}}

    Raises:
        HTTPException: 503 if Ollama is not running or unhealthy
    """
    # TODO: Implement health check by calling Ollama API
    # For now, return a placeholder
    return {
        "status": "ok",
        "uptime_sec": 0,
        "details": {"note": "Health check not yet implemented"},
    }


async def list_ollama_models() -> list[dict[str, Any]]:
    """
    List models installed in Ollama.

    Calls Ollama API GET /api/tags to retrieve the list of installed models.

    Returns:
        list[dict]: List of models with their metadata
            Each model dict contains: name, size, digest, modified_at

    Raises:
        HTTPException: 503 if Ollama is not running or API is unavailable
    """
    logger.info("Listing Ollama models via API")

    try:
        ollama_api_base = _get_ollama_api_base()
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{ollama_api_base}/api/tags")
            response.raise_for_status()

            data = response.json()
            models: list[dict[str, Any]] = data.get("models", [])

            logger.info(f"Found {len(models)} Ollama models")
            return models

    except httpx.ConnectError as e:
        logger.error(f"Failed to connect to Ollama API: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-unavailable",
                "title": "Ollama API Unavailable",
                "detail": "Ollama is not running. Start Ollama first.",
            },
        ) from e

    except httpx.HTTPStatusError as e:
        logger.error(f"Ollama API returned error: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-api-error",
                "title": "Ollama API Error",
                "detail": f"Ollama API returned status {e.response.status_code}",
            },
        ) from e

    except Exception as e:
        logger.error(f"Unexpected error listing Ollama models: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "type": "https://lem.gg/errors/internal-error",
                "title": "Internal Server Error",
                "detail": str(e),
            },
        ) from e


async def pull_ollama_model(model_ref: str) -> dict[str, Any]:
    """
    Pull a model for Ollama.

    Calls Ollama API POST /api/pull to download and install a model.
    This operation can take a long time (several minutes to hours) depending on model size.

    For v0.1, this is a synchronous operation that waits for the pull to complete.
    Future versions will implement streaming progress updates.

    Args:
        model_ref: Model reference in format "name:tag" (e.g., "llama3.2:1b")

    Returns:
        dict: {"status": "ok", "model_ref": "...", "message": "..."}

    Raises:
        HTTPException: 400 if model_ref is invalid, 503 if Ollama unavailable,
                      504 if pull times out
    """
    logger.info(f"Pulling Ollama model: {model_ref}")

    if not model_ref:
        raise HTTPException(
            status_code=400,
            detail={
                "type": "https://lem.gg/errors/invalid-model-ref",
                "title": "Invalid Model Reference",
                "detail": "model_ref cannot be empty",
            },
        )

    try:
        ollama_api_base = _get_ollama_api_base()
        async with httpx.AsyncClient(timeout=OLLAMA_API_TIMEOUT) as client:
            # Send pull request to Ollama API
            # The API returns a stream of JSON objects with progress updates
            # For v0.1, we'll consume the stream and wait for completion
            response = await client.post(
                f"{ollama_api_base}/api/pull",
                json={"name": model_ref},
                timeout=OLLAMA_API_TIMEOUT,
            )
            response.raise_for_status()

            # Stream the response line by line
            # Each line is a JSON object with status/progress info
            last_status = None
            async for line in response.aiter_lines():
                if line.strip():
                    try:
                        status_obj = json.loads(line)
                        last_status = status_obj
                        # Log progress
                        if "status" in status_obj:
                            logger.info(f"Pull progress: {status_obj['status']}")
                    except Exception as parse_error:
                        logger.warning(f"Failed to parse progress line: {parse_error}")

            logger.info(f"Ollama model pull completed: {model_ref}")
            return {
                "status": "ok",
                "model_ref": model_ref,
                "message": f"Successfully pulled {model_ref}",
                "details": last_status,
            }

    except httpx.ConnectError as e:
        logger.error(f"Failed to connect to Ollama API: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-unavailable",
                "title": "Ollama API Unavailable",
                "detail": "Ollama is not running. Start Ollama first.",
            },
        ) from e

    except httpx.TimeoutException as e:
        logger.error(f"Ollama model pull timed out: {e}")
        raise HTTPException(
            status_code=504,
            detail={
                "type": "https://lem.gg/errors/ollama-timeout",
                "title": "Ollama Pull Timeout",
                "detail": (
                    f"Model pull timed out after {OLLAMA_API_TIMEOUT}s. "
                    "Large models may need more time."
                ),
            },
        ) from e

    except httpx.HTTPStatusError as e:
        logger.error(f"Ollama API returned error: {e}")
        error_detail = "Unknown error"
        try:
            error_data = e.response.json()
            error_detail = error_data.get("error", str(e))
        except Exception:
            error_detail = str(e)

        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-api-error",
                "title": "Ollama API Error",
                "detail": error_detail,
            },
        ) from e

    except Exception as e:
        logger.error(f"Unexpected error pulling Ollama model: {e}")
        raise HTTPException(
            status_code=500,
            detail={
                "type": "https://lem.gg/errors/internal-error",
                "title": "Internal Server Error",
                "detail": str(e),
            },
        ) from e
