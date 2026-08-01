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
Ollama model operations for Lem.

Install/start/stop/status for Ollama are handled by app.services (the generic
Harbor service path); this module only covers what that path does not do -
talking to the Ollama HTTP API to list and pull models.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

import httpx
from fastapi import HTTPException

from app.services.status import get_service_url

logger = logging.getLogger(__name__)

# Harbor's service ID for Ollama
OLLAMA_SERVICE_ID = "ollama"

# Ollama API configuration
OLLAMA_API_TIMEOUT = 300.0  # 5 minutes for model operations
OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434"


async def get_ollama_endpoint() -> str:
    """
    Get the Ollama API base URL, discovering the mapped host port from Docker.

    Harbor maps Ollama to a dynamic port, so the port has to be looked up.
    Falls back to the standard port 11434 if discovery fails.

    Returns:
        str: The Ollama API base URL (e.g., "http://127.0.0.1:33821")
    """
    url = await asyncio.to_thread(get_service_url, OLLAMA_SERVICE_ID)
    if url:
        return url

    logger.warning("Could not discover Ollama port, using default 11434")
    return OLLAMA_DEFAULT_URL


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
        ollama_api_base = await get_ollama_endpoint()
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

    except httpx.HTTPError as e:
        logger.error(f"Unexpected error listing Ollama models: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-unavailable",
                "title": "Ollama API Unavailable",
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
        ollama_api_base = await get_ollama_endpoint()
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
                if not line.strip():
                    continue
                try:
                    status_obj = json.loads(line)
                except json.JSONDecodeError as parse_error:
                    logger.warning(f"Failed to parse progress line: {parse_error}")
                    continue

                last_status = status_obj
                if "status" in status_obj:
                    logger.info(f"Pull progress: {status_obj['status']}")

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
        error_detail = str(e)
        try:
            error_data = e.response.json()
            error_detail = error_data.get("error", str(e))
        except ValueError:
            pass

        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-api-error",
                "title": "Ollama API Error",
                "detail": error_detail,
            },
        ) from e

    except httpx.HTTPError as e:
        logger.error(f"Unexpected error pulling Ollama model: {e}")
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-unavailable",
                "title": "Ollama API Unavailable",
                "detail": str(e),
            },
        ) from e
