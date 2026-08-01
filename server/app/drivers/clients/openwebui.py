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
Open WebUI URL discovery for Lem.

Install/start/stop/status for Open WebUI are handled by app.services (the
generic Harbor service path). All that remains here is URL discovery for the
tunnel request router, which needs a synchronous lookup.
"""

from __future__ import annotations

import logging

from app.services.status import get_service_url

logger = logging.getLogger(__name__)

# Harbor's service ID for Open WebUI
OPENWEBUI_SERVICE_ID = "webui"

OPENWEBUI_DEFAULT_URL = "http://127.0.0.1:3000"


def get_openwebui_url() -> str:
    """
    Get the Open WebUI URL with the actual dynamically-mapped port.

    Harbor maps Open WebUI to a dynamic port, so Docker has to be queried for
    it. Falls back to the standard port 3000 if discovery fails.

    Returns:
        str: The Open WebUI URL (e.g., "http://127.0.0.1:33801")
    """
    url = get_service_url(OPENWEBUI_SERVICE_ID)
    if url:
        return url

    logger.warning("Could not discover Open WebUI port, using default 3000")
    return OPENWEBUI_DEFAULT_URL
