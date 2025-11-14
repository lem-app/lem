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
Lem Local Server - Main FastAPI Application

This is the local server that runs on the user's machine and manages:
- Ollama runner installation and lifecycle
- Open WebUI client installation and lifecycle
- Remote access tunneling (P2P/TURN/relay)

Port: 5142 (default)
"""
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import auth as auth_module
from app.api.v1.auth import router as auth_router
from app.db import init_db
from app.tunnel.manager import TunnelManager
from app.drivers.clients.openwebui import (
    get_openwebui_status,
    get_openwebui_url,
    install_openwebui,
    start_openwebui,
    stop_openwebui,
)
from app.drivers.runners.ollama import (
    get_ollama_endpoint,
    get_ollama_health,
    get_ollama_status,
    install_ollama,
    list_ollama_models,
    pull_ollama_model,
    start_ollama,
    stop_ollama,
)

# Configure logging for the application
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# Create logger for this module
logger = logging.getLogger(__name__)

# Global TunnelManager instance
tunnel_manager: TunnelManager | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Lifespan context manager for FastAPI.
    Handles startup and shutdown events.
    """
    global tunnel_manager

    # Startup: Initialize database
    init_db()
    logger.info("✓ Database initialized at ~/.lem/lem.db")

    # Startup: Initialize TunnelManager
    tunnel_manager = TunnelManager()

    # Wire up TunnelManager to auth module
    auth_module.set_tunnel_manager(tunnel_manager)

    # Auto-start TunnelAgent if user is authenticated
    try:
        await tunnel_manager.start()
    except Exception as e:
        logger.warning(f"TunnelAgent auto-start failed: {e}")

    yield

    # Shutdown: Stop TunnelAgent gracefully
    if tunnel_manager:
        await tunnel_manager.stop()

    logger.info("✓ Server shutdown complete")


# Create FastAPI app
app = FastAPI(
    title="Lem Local Server",
    description="Local AI launcher with remote access",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# Configure CORS for local development
# In v0.1, we allow localhost origins. In production, this will be restricted.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev server (web/remote)
        "http://127.0.0.1:5173",
        "http://localhost:5174",  # Vite dev server (web/local)
        "http://127.0.0.1:5174",
        "http://localhost:3000",  # Future: served by FastAPI
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API routers
app.include_router(auth_router, prefix="/v1")


@app.get("/v1/health")
async def health() -> dict[str, Any]:
    """
    Health check endpoint.

    Returns composed health status across Docker, runners, clients, and tunnel.
    In this initial version, we return a minimal response.

    Returns:
        dict: Health status with components
    """
    return {
        "status": "ok",
        "components": {"docker": "ok", "runners": {}, "clients": {}, "tunnel": "offline"},
    }


@app.get("/")
async def root() -> dict[str, str]:
    """
    Root endpoint - redirects to docs.

    Returns:
        dict: Welcome message
    """
    return {"message": "Lem Local Server v0.1.0", "docs": "/docs", "health": "/v1/health"}


# ----- Runners List Endpoint -----


@app.get("/v1/runners")
async def list_runners() -> list[dict[str, Any]]:
    """
    List all available runners.

    For v0.1, this returns only Ollama.
    Status is determined by checking if the container is running.

    Returns:
        list[dict]: List of runners with their status
    """
    # For v0.1, we only have Ollama
    # Get actual status from Docker via harbor_ps()
    status = await get_ollama_status()
    endpoint = get_ollama_endpoint()

    return [
        {
            "id": "ollama",
            "name": "Ollama",
            "status": status,
            "capabilities": ["chat", "embeddings"],
            "endpoint": endpoint,
            "harbor_service": "ollama",
            "version": "latest",  # TODO: Get actual version from Harbor
        }
    ]


# ----- Ollama Runner Endpoints -----


@app.post("/v1/runners/ollama/install")
async def ollama_install() -> dict[str, str]:
    """
    Install Ollama via Harbor CLI.

    This performs the initial pull of the Ollama container image.
    Uses a longer timeout (10 minutes) for the initial image pull.

    Returns:
        dict: {"status": "ok", "message": "Ollama installed successfully"}

    Raises:
        HTTPException: 503 if Harbor CLI fails, 504 if timeout
    """
    return await install_ollama()


@app.post("/v1/runners/ollama/start")
async def ollama_start() -> dict[str, str]:
    """
    Start Ollama service via Harbor CLI.

    This operation is idempotent - if Ollama is already running, it succeeds.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails, 504 if timeout
    """
    return await start_ollama()


@app.post("/v1/runners/ollama/stop")
async def ollama_stop() -> dict[str, str]:
    """
    Stop Ollama service via Harbor CLI.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails
    """
    return await stop_ollama()


@app.get("/v1/runners/ollama/health")
async def ollama_health() -> dict[str, Any]:
    """
    Get Ollama service health status.

    Returns:
        dict: {"status": "ok", "uptime_sec": 1234, "details": {...}}

    Raises:
        HTTPException: 503 if Ollama is not running or unhealthy
    """
    return await get_ollama_health()


# ----- Clients List Endpoint -----


@app.get("/v1/clients")
async def list_clients() -> list[dict[str, Any]]:
    """
    List all available clients.

    For v0.1, this returns only Open WebUI.
    Status is determined by checking if the container is running.

    Returns:
        list[dict]: List of clients with their status
    """
    # For v0.1, we only have Open WebUI
    # Get actual status from Docker via harbor_ps()
    status = await get_openwebui_status()
    url = get_openwebui_url()

    return [
        {
            "id": "openwebui",
            "name": "Open WebUI",
            "status": status,
            "url": url,
            "binds_to_runner": "ollama",
            "harbor_service": "webui",  # Harbor uses "webui" as service name
            "version": "latest",  # TODO: Get actual version from Harbor
        }
    ]


# ----- Open WebUI Client Endpoints -----


@app.post("/v1/clients/openwebui/install")
async def openwebui_install() -> dict[str, str]:
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
    return await install_openwebui()


@app.post("/v1/clients/openwebui/start")
async def openwebui_start() -> dict[str, str]:
    """
    Start Open WebUI service via Harbor CLI.

    This operation is idempotent - if Open WebUI is already running, it succeeds.
    Harbor automatically binds Open WebUI to Ollama.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails, 504 if timeout
    """
    return await start_openwebui()


@app.post("/v1/clients/openwebui/stop")
async def openwebui_stop() -> dict[str, str]:
    """
    Stop Open WebUI service via Harbor CLI.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails
    """
    return await stop_openwebui()


# ----- Tunnel Endpoints -----


@app.get("/v1/tunnel/status")
async def tunnel_status() -> dict[str, Any]:
    """
    Get tunnel connection status.

    Returns:
        dict: Status with mode, device_id, and connection details
    """
    if tunnel_manager is None:
        return {"mode": "offline", "authenticated": False}

    return tunnel_manager.get_status()


@app.post("/v1/tunnel/enable")
async def tunnel_enable() -> dict[str, str]:
    """
    Enable remote access tunnel.

    Requires user to be logged in via /v1/auth/login first.

    Returns:
        dict: {"status": "ok", "mode": "connecting"}

    Raises:
        HTTPException: 401 if not authenticated
    """
    if tunnel_manager is None:
        raise HTTPException(
            status_code=503,
            detail="TunnelManager not initialized",
        )

    try:
        await tunnel_manager.enable()
        status_dict = tunnel_manager.get_status()
        return {"status": "ok", "mode": status_dict.get("mode", "connecting")}
    except RuntimeError as e:
        raise HTTPException(
            status_code=401,
            detail=str(e),
        ) from e


@app.post("/v1/tunnel/disable")
async def tunnel_disable() -> dict[str, str]:
    """
    Disable remote access tunnel.

    Returns:
        dict: {"status": "ok", "mode": "offline"}
    """
    if tunnel_manager is None:
        return {"status": "ok", "mode": "offline"}

    await tunnel_manager.disable()
    return {"status": "ok", "mode": "offline"}


# ----- Models Endpoints -----


@app.get("/v1/runners/ollama/models")
async def get_ollama_models() -> list[dict[str, Any]]:
    """
    List models available in Ollama.

    Calls Ollama API GET /api/tags to retrieve the list of installed models.

    Returns:
        list[dict]: List of models with their metadata

    Raises:
        HTTPException: 503 if Ollama is not running or API is unavailable
    """
    return await list_ollama_models()


@app.post("/v1/runners/ollama/models/pull")
async def pull_model(request: dict[str, str]) -> dict[str, Any]:
    """
    Pull a model for Ollama.

    Calls Ollama API POST /api/pull to download and install a model.
    This operation can take a long time depending on model size.

    Args:
        request: {"model_ref": "llama3.2:1b"}

    Returns:
        dict: {"status": "ok", "model_ref": "...", "message": "..."}

    Raises:
        HTTPException: 400 if model_ref is invalid, 503 if Ollama unavailable,
                      504 if pull times out
    """
    model_ref = request.get("model_ref", "")
    return await pull_ollama_model(model_ref)
