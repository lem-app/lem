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
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

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


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Log startup and shutdown.

    Args:
        _app: The application being started.

    Yields:
        None, once startup is complete.
    """
    logger.info("Relay server started")
    yield
    logger.info("Relay server shutting down")


# Create FastAPI app
app = FastAPI(
    title="Lem Relay Server",
    description="WebSocket relay server for fallback connectivity",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS. settings validation rejects an empty list and any "*" entry: this API
# is credentialed, and Starlette answers a wildcard-plus-credentials config by
# reflecting the caller's own Origin, which lets any site call it with the
# user's credentials attached.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(health.router)
app.include_router(relay.router)
