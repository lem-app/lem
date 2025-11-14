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

"""Health check endpoint."""

from fastapi import APIRouter

from ..core.session_manager import session_manager

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check() -> dict[str, str | int]:
    """Health check endpoint.

    Returns:
        Health status and active session count.
    """
    return {
        "status": "healthy",
        "service": "relay",
        "active_sessions": session_manager.get_session_count(),
    }
