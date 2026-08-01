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

"""Request routing for the tunnel's HTTP proxy.

The target service travels in the ``X-Lem-Service`` request header, and the
header is consumed here and stripped before anything is forwarded. It is
deliberately *not* a query parameter: v2 injected ``?client=`` into arbitrary
URLs, which mutated the URL the upstream app saw and produced a class of bugs
where routing metadata leaked into application state.

Two rules make this a security boundary rather than a convenience:

- No header means the local Lem server. That is the only implicit target.
- A header naming a service that does not resolve **exactly** raises
  :class:`UnknownServiceError`, which the proxy renders as
  ``E_UNKNOWN_SERVICE``. It never falls through to the local server: falling
  through means a typo in a service id reaches the privileged local API with the
  local server's own credentials attached.
"""

import logging
import re
from collections.abc import Callable, Iterable

logger = logging.getLogger(__name__)

# Wire name of the service selector. Compared case-insensitively; kept in the
# proxy's PROXY_CONTROLLED_HEADERS so a peer's value never reaches upstream.
SERVICE_HEADER = "x-lem-service"

# Same shape the Service Worker's path grammar accepts, so a service id that
# survives the URL cannot be rejected here (or vice versa).
_SERVICE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class UnknownServiceError(LookupError):
    """The request named a service that could not be positively resolved.

    Raised for an unknown id, a not-running service, a service whose published
    ports do not map its catalog container port, a malformed id, and a request
    carrying more than one ``X-Lem-Service`` header. Every one of those is a
    case where continuing would mean guessing where to send an authenticated
    request.
    """

    def __init__(self, service_id: str) -> None:
        """Initialize the error.

        Args:
            service_id: The unresolvable service id, for the local log only
        """
        super().__init__(service_id)
        self.service_id = service_id


def extract_service_id(headers: Iterable[tuple[str, str]]) -> str | None:
    """Read the service selector out of a peer's request headers.

    Args:
        headers: Peer-supplied header pairs, in order

    Returns:
        The service id, or None when the request targets the local server

    Raises:
        UnknownServiceError: If the header appears more than once or its value
            is not a well-formed service id
    """
    values = [value for name, value in headers if name.lower() == SERVICE_HEADER]
    if not values:
        return None
    if len(values) > 1:
        # Two selectors is not a choice to make on the peer's behalf.
        raise UnknownServiceError(values[0])
    service_id = values[0].strip()
    if not _SERVICE_ID_RE.match(service_id):
        raise UnknownServiceError(service_id)
    return service_id


class RequestRouter:
    """Routes tunnel HTTP requests to the local server or a running service."""

    def __init__(
        self,
        local_server_url: str = "http://localhost:5142",
        get_service_url: Callable[[str], str | None] | None = None,
    ) -> None:
        """Initialize request router.

        Args:
            local_server_url: Base URL of local Lem server
            get_service_url: Strict resolver from service id to base URL
                (e.g. "webui" -> "http://127.0.0.1:33801"), returning None when
                the service is not running or cannot be resolved exactly
        """
        self.local_server_url = local_server_url.rstrip("/")
        self.get_service_url = get_service_url or self._default_service_url_resolver

    def _default_service_url_resolver(self, service_id: str) -> str | None:
        """Resolve nothing.

        Args:
            service_id: Service identifier

        Returns:
            None (no resolver configured)
        """
        logger.warning(f"No service URL resolver configured, cannot resolve '{service_id}'")
        return None

    def route(self, path: str, headers: Iterable[tuple[str, str]] | None = None) -> str:
        """Determine the target base URL for one request.

        Args:
            path: HTTP request path (unused for target selection; logged only)
            headers: Peer-supplied header pairs

        Returns:
            Target base URL to proxy to

        Raises:
            UnknownServiceError: If ``X-Lem-Service`` names nothing resolvable

        Examples:
            >>> router.route("/v1/health")
            "http://localhost:5142"

            >>> router.route("/api/models", [("X-Lem-Service", "webui")])
            "http://127.0.0.1:33801"
        """
        service_id = extract_service_id(headers or ())

        if service_id is None:
            logger.debug(f"Routing {path} to the local server: {self.local_server_url}")
            return self.local_server_url

        service_url = self.get_service_url(service_id)
        if service_url is None:
            # No fall-through. See the module docstring.
            logger.warning(f"Refusing to route {path}: service '{service_id}' did not resolve")
            raise UnknownServiceError(service_id)

        logger.debug(f"Routed {path} to service '{service_id}': {service_url}")
        return service_url


def create_router_with_client_discovery(
    local_server_url: str = "http://localhost:5142",
) -> RequestRouter:
    """Create a router backed by the catalog's strict port resolution.

    Args:
        local_server_url: Base URL of local Lem server

    Returns:
        Configured RequestRouter
    """
    from app.services.status import get_service_url

    return RequestRouter(
        local_server_url=local_server_url,
        get_service_url=get_service_url,
    )
