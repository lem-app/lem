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

"""Request routing logic for HTTP proxy.

Routes HTTP requests to appropriate targets based on query parameters:
- ?client=openwebui → Dynamic port for Open WebUI
- Default → Local Lem server (localhost:5142)
"""

import logging
from typing import Callable
from urllib.parse import parse_qs, urlparse

logger = logging.getLogger(__name__)


class RequestRouter:
    """Routes HTTP requests to appropriate backend services."""

    def __init__(
        self,
        local_server_url: str = "http://localhost:5142",
        get_client_url: Callable[[str], str | None] | None = None,
    ) -> None:
        """Initialize request router.

        Args:
            local_server_url: Base URL of local Lem server
            get_client_url: Function to get client URL by ID (e.g., "openwebui" → "http://127.0.0.1:33801")
        """
        self.local_server_url = local_server_url.rstrip("/")
        self.get_client_url = get_client_url or self._default_client_url_resolver

    def _default_client_url_resolver(self, client_id: str) -> str | None:
        """Default client URL resolver (no-op).

        Args:
            client_id: Client identifier

        Returns:
            None (client not found)
        """
        logger.warning(f"No client URL resolver configured, cannot resolve client '{client_id}'")
        return None

    def route(self, path: str) -> str:
        """Determine target URL for given request path.

        Args:
            path: HTTP request path (may include query string)

        Returns:
            Target base URL for proxying

        Examples:
            >>> router.route("/v1/health")
            "http://localhost:5142"

            >>> router.route("/index.html?client=openwebui")
            "http://127.0.0.1:33801"

            >>> router.route("/v1/runners?client=unknown")
            "http://localhost:5142"
        """
        # Parse query parameters
        parsed = urlparse(path)
        query_params = parse_qs(parsed.query)

        # Check for ?client= parameter
        client_ids = query_params.get("client", [])
        if client_ids:
            client_id = client_ids[0]  # Take first value
            logger.debug(f"Routing request to client: {client_id}")

            # Resolve client URL
            client_url = self.get_client_url(client_id)
            if client_url:
                logger.info(f"Routed to client '{client_id}': {client_url}")
                return client_url
            else:
                logger.warning(
                    f"Client '{client_id}' not found or not running, falling back to local server"
                )

        # Default: route to local Lem server
        logger.debug(f"Routing to local server: {self.local_server_url}")
        return self.local_server_url


def create_router_with_client_discovery(
    local_server_url: str = "http://localhost:5142",
) -> RequestRouter:
    """Create router with dynamic client URL discovery.

    This function integrates with the Lem drivers to discover running client ports.

    Args:
        local_server_url: Base URL of local Lem server

    Returns:
        Configured RequestRouter
    """
    from app.drivers.clients.openwebui import get_openwebui_url

    def get_client_url(client_id: str) -> str | None:
        """Resolve client ID to URL using driver discovery.

        Args:
            client_id: Client identifier (e.g., "openwebui")

        Returns:
            Client URL if found and running, None otherwise
        """
        if client_id == "openwebui":
            try:
                url = get_openwebui_url()
                # Validate URL is not the fallback
                if url and url != "http://127.0.0.1:3000":
                    return url
            except Exception as e:
                logger.error(f"Error discovering Open WebUI URL: {e}")
                return None

        # Unknown client
        return None

    return RequestRouter(
        local_server_url=local_server_url,
        get_client_url=get_client_url,
    )
