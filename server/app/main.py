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
- Harbor service catalog (80+ AI services)
- Service lifecycle (install, start, stop, remove)
- Remote access tunneling (P2P/TURN/relay)

Port: 5142 (default)
"""

import asyncio
import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import auth as auth_module
from app.api.v1.auth import router as auth_router
from app.catalog import get_all_services, get_service_definition
from app.catalog.models import ServiceCategory, ServiceStatus
from app.config.platform import ARCH, DOCKER_HOST, IS_WSL, OS_TYPE, PLATFORM
from app.db import DB_PATH, init_db
from app.drivers.clients.openwebui import OPENWEBUI_SERVICE_ID, get_openwebui_url
from app.drivers.harbor_wrapper import HarborError, check_harbor_installed
from app.drivers.runners.ollama import (
    OLLAMA_SERVICE_ID,
    get_ollama_endpoint,
    list_ollama_models,
    pull_ollama_model,
)
from app.jobs import JobStatus, get_job, get_recent_jobs
from app.jobs.queue import init_job_queue, shutdown_job_queue
from app.security import (
    TOKEN_PATH,
    LocalApiSecurityMiddleware,
    ensure_api_token,
    get_allowed_origins,
    get_bind_posture,
)
from app.services import (
    get_all_services_with_status,
    get_service_endpoint,
    get_service_status,
    install_service,
    remove_service,
    start_service,
    stop_service,
)
from app.services.lifecycle import install_service_inline, register_job_handlers
from app.services.status import probe_docker
from app.tunnel.manager import TunnelManager

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

# Browser origins allowed to drive the API (built-ins plus $LEM_ALLOWED_ORIGINS).
BROWSER_ORIGINS = get_allowed_origins()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Lifespan context manager for FastAPI.
    Handles startup and shutdown events.
    """
    global tunnel_manager

    # Startup: Initialize database
    init_db()
    logger.info(f"✓ Database initialized at {DB_PATH}")

    # Startup: Ensure the API token exists (never log the token itself)
    ensure_api_token()
    logger.info(f"✓ API token available at {TOKEN_PATH}")

    # Report what was actually verified about the listening socket and the
    # enforcement decision that follows from it - never a claim we have not
    # checked. app.serve installs this posture before the socket accepts.
    posture = get_bind_posture()
    enforcement = (
        "bearer token REQUIRED on /v1/*"
        if posture.require_token
        else "bearer token accepted but not required on /v1/*"
    )
    if posture.verified and posture.loopback_only:
        logger.info(f"✓ Lem local API {posture.describe()}; {enforcement}")
    elif posture.verified:
        logger.warning(
            f"⚠ Lem local API {posture.describe()}: {enforcement} (token in {TOKEN_PATH})"
        )
    else:
        logger.warning(
            f"⚠ Lem local API {posture.describe()}. Failing closed: {enforcement} "
            f"(token in {TOKEN_PATH})"
        )

    # Startup: Initialize job queue
    await init_job_queue()
    register_job_handlers()
    logger.info("✓ Job queue initialized")

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

    # Shutdown: Stop job queue
    await shutdown_job_queue()
    logger.info("✓ Job queue stopped")

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

# Access control. Added first so the CORS middleware wraps it and can still
# attach CORS headers to rejections. require_token is deliberately left at its
# default: it reads the live, verified bind posture on every request instead of
# a value frozen from an environment variable at import time.
app.add_middleware(
    LocalApiSecurityMiddleware,
    allowed_origins=BROWSER_ORIGINS,
)

# Configure CORS for local development.
# The allowlist is shared with the CSRF middleware so the two cannot drift.
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(BROWSER_ORIGINS),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API routers
app.include_router(auth_router, prefix="/v1")


async def _legacy_status(service_id: str) -> str:
    """
    Map a service's status onto the legacy runner/client vocabulary.

    The legacy endpoints only know "running" | "stopped" | "error", and they
    report rather than raise when Docker is unreachable.

    Args:
        service_id: Harbor service ID

    Returns:
        "running", "stopped" or "error"
    """
    try:
        status = await get_service_status(service_id)
    except HTTPException as e:
        logger.warning(f"Status check for {service_id} failed: {e.detail}")
        return "error"

    if status == ServiceStatus.RUNNING:
        return "running"
    if status == ServiceStatus.ERROR:
        return "error"
    return "stopped"


@app.get("/v1/health")
async def health() -> dict[str, Any]:
    """
    Health check endpoint.

    Actually probes Docker and the Harbor CLI - this used to report
    `"docker": "ok"` unconditionally, including while every Docker call was
    failing.

    Returns:
        dict: Health status with components
    """
    docker_ok, docker_detail = await asyncio.to_thread(probe_docker)

    harbor_detail: str
    try:
        harbor_detail = f"ok (v{await asyncio.to_thread(check_harbor_installed)})"
        harbor_ok = True
    except HarborError as e:
        harbor_detail = str(e)
        harbor_ok = False

    if docker_ok:
        runners = {OLLAMA_SERVICE_ID: await _legacy_status(OLLAMA_SERVICE_ID)}
        clients = {"openwebui": await _legacy_status(OPENWEBUI_SERVICE_ID)}
    else:
        runners = {}
        clients = {}

    if not docker_ok:
        status = "error"
    elif not harbor_ok:
        status = "degraded"
    else:
        status = "ok"

    tunnel_mode = "offline"
    if tunnel_manager is not None:
        tunnel_mode = str(tunnel_manager.get_status().get("mode", "offline"))

    return {
        "status": status,
        "components": {
            "docker": f"ok (v{docker_detail})" if docker_ok else f"unavailable: {docker_detail}",
            "harbor": harbor_detail,
            "runners": runners,
            "clients": clients,
            "tunnel": tunnel_mode,
        },
        "platform": {
            "os": OS_TYPE,
            "arch": ARCH,
            "platform": PLATFORM,
            "wsl": IS_WSL,
            "docker_host": DOCKER_HOST,
        },
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
    status = await _legacy_status(OLLAMA_SERVICE_ID)
    endpoint = await get_ollama_endpoint()

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
    await install_service_inline(OLLAMA_SERVICE_ID)
    return {"status": "ok", "message": "Ollama installed successfully"}


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
    return await start_service(OLLAMA_SERVICE_ID)


@app.post("/v1/runners/ollama/stop")
async def ollama_stop() -> dict[str, str]:
    """
    Stop Ollama service via Harbor CLI.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails
    """
    return await stop_service(OLLAMA_SERVICE_ID)


@app.get("/v1/runners/ollama/health")
async def ollama_health() -> dict[str, Any]:
    """
    Get Ollama service health status.

    Probes the Ollama HTTP API rather than returning a placeholder.

    Returns:
        dict: {"status": "ok", "details": {...}}

    Raises:
        HTTPException: 503 if Ollama is not running or unhealthy
    """
    status = await _legacy_status(OLLAMA_SERVICE_ID)
    endpoint = await get_ollama_endpoint()

    if status != "running":
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-unavailable",
                "title": "Ollama Not Running",
                "detail": f"Ollama container status is '{status}'",
            },
        )

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{endpoint}/api/version")
            response.raise_for_status()
            version = response.json()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=503,
            detail={
                "type": "https://lem.gg/errors/ollama-unavailable",
                "title": "Ollama API Unhealthy",
                "detail": f"Ollama container is running but its API did not respond: {e}",
            },
        ) from e

    return {"status": "ok", "details": {"endpoint": endpoint, "version": version}}


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
    status = await _legacy_status(OPENWEBUI_SERVICE_ID)
    url = await asyncio.to_thread(get_openwebui_url)

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
    await install_service_inline(OPENWEBUI_SERVICE_ID)
    return {"status": "ok", "message": "Open WebUI installed successfully"}


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
    return await start_service(OPENWEBUI_SERVICE_ID)


@app.post("/v1/clients/openwebui/stop")
async def openwebui_stop() -> dict[str, str]:
    """
    Stop Open WebUI service via Harbor CLI.

    Returns:
        dict: {"status": "ok"}

    Raises:
        HTTPException: 503 if Harbor CLI fails
    """
    return await stop_service(OPENWEBUI_SERVICE_ID)


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


# =============================================================================
# NEW: Catalog Endpoints
# =============================================================================


@app.get("/v1/catalog")
async def list_catalog(
    category: ServiceCategory | None = None,
) -> list[dict[str, Any]]:
    """
    List all available services from the Harbor catalog.

    This returns static catalog information (not runtime status).
    Use /v1/services for runtime status.

    Args:
        category: Optional filter by category (backend, frontend, satellite)

    Returns:
        List of service definitions from the catalog
    """
    all_services = get_all_services()

    if category:
        all_services = [s for s in all_services if s.category == category]

    return [s.model_dump() for s in all_services]


@app.get("/v1/catalog/{service_id}")
async def get_catalog_entry(service_id: str) -> dict[str, Any]:
    """
    Get details for a specific service from the catalog.

    Args:
        service_id: Service ID to look up

    Returns:
        Service definition

    Raises:
        HTTPException: 404 if service not found
    """
    service = get_service_definition(service_id)
    if not service:
        raise HTTPException(
            status_code=404,
            detail={
                "type": "https://lem.gg/errors/service-not-found",
                "title": "Service Not Found",
                "detail": f"Service '{service_id}' not found in catalog",
            },
        )
    return service.model_dump()


# =============================================================================
# NEW: Services Endpoints (with runtime status)
# =============================================================================


@app.get("/v1/services")
async def list_services(
    category: ServiceCategory | None = None,
) -> list[dict[str, Any]]:
    """
    List all services with their current runtime status.

    This includes:
    - Service metadata (name, description, category)
    - Runtime status (not_installed, stopped, running, error)
    - Endpoint URL (if running)

    Args:
        category: Optional filter by category

    Returns:
        List of services with status
    """
    all_services = await get_all_services_with_status()

    if category:
        all_services = [s for s in all_services if s.category == category]

    return [s.model_dump() for s in all_services]


@app.get("/v1/services/{service_id}")
async def get_service(service_id: str) -> dict[str, Any]:
    """
    Get a specific service with its runtime status.

    Args:
        service_id: Service ID to look up

    Returns:
        Service with status

    Raises:
        HTTPException: 404 if service not found
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
    endpoint = await get_service_endpoint(service_id)

    return {
        **service_def.model_dump(),
        "status": status.value,
        "endpoint": endpoint,
    }


@app.post("/v1/services/{service_id}/install")
async def install_service_endpoint(service_id: str) -> dict[str, Any]:
    """
    Install a service (async operation).

    Creates a background job that pulls the service image.
    Dependencies are automatically installed first.

    Args:
        service_id: Service ID to install

    Returns:
        {"job_id": "...", "status": "pending", "message": "..."}

    Raises:
        HTTPException: 404 if not found, 409 if job already in progress
    """
    job_id = await install_service(service_id)
    return {
        "job_id": job_id,
        "status": "pending",
        "message": f"Installation of {service_id} queued",
    }


@app.post("/v1/services/{service_id}/start")
async def start_service_endpoint(service_id: str) -> dict[str, str]:
    """
    Start an installed service.

    Args:
        service_id: Service ID to start

    Returns:
        {"status": "ok"}

    Raises:
        HTTPException: 404 if not found, 400 if not installed
    """
    return await start_service(service_id)


@app.post("/v1/services/{service_id}/stop")
async def stop_service_endpoint(service_id: str) -> dict[str, str]:
    """
    Stop a running service.

    Args:
        service_id: Service ID to stop

    Returns:
        {"status": "ok"}

    Raises:
        HTTPException: 404 if not found
    """
    return await stop_service(service_id)


@app.post("/v1/services/{service_id}/remove")
async def remove_service_endpoint(service_id: str) -> dict[str, Any]:
    """
    Remove a service (async operation).

    Creates a background job that stops and removes the service.

    Args:
        service_id: Service ID to remove

    Returns:
        {"job_id": "...", "status": "pending", "message": "..."}

    Raises:
        HTTPException: 404 if not found, 409 if job already in progress
    """
    job_id = await remove_service(service_id)
    return {
        "job_id": job_id,
        "status": "pending",
        "message": f"Removal of {service_id} queued",
    }


# =============================================================================
# NEW: Jobs Endpoints
# =============================================================================


@app.get("/v1/jobs")
async def list_jobs(
    status: JobStatus | None = None,
    service_id: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """
    List recent jobs.

    Args:
        status: Optional filter by status (pending, running, completed, failed)
        service_id: Optional filter by service ID
        limit: Maximum number of jobs to return (default 20)

    Returns:
        List of jobs, most recent first
    """
    jobs = get_recent_jobs(status=status, service_id=service_id, limit=limit)
    return [j.model_dump() for j in jobs]


@app.get("/v1/jobs/{job_id}")
async def get_job_status(job_id: str) -> dict[str, Any]:
    """
    Get the status of a specific job.

    Args:
        job_id: Job ID to look up

    Returns:
        Job details including status, progress, and message

    Raises:
        HTTPException: 404 if job not found
    """
    job = get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=404,
            detail={
                "type": "https://lem.gg/errors/job-not-found",
                "title": "Job Not Found",
                "detail": f"Job '{job_id}' not found",
            },
        )
    return job.model_dump()
