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

"""Main FastAPI application for relay server."""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import health, relay
from .core.config import settings

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)

logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="Lem Relay Server",
    description="WebSocket relay server for fallback connectivity",
    version="0.1.0",
)

# Parse CORS origins from settings
cors_origins = (
    ["*"] if settings.cors_origins == "*" else settings.cors_origins.split(",")
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router)
app.include_router(relay.router)


@app.on_event("startup")
async def startup_event() -> None:
    """Initialize on startup."""
    logger.info("Relay server started")


@app.on_event("shutdown")
async def shutdown_event() -> None:
    """Cleanup on shutdown."""
    logger.info("Relay server shutting down")
