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
Access control for the local server API.

The local API drives Docker (install/start/stop/remove services), so it is a
privileged surface. Two independent defenses guard it:

1. CSRF middleware (always on). Every state-changing request must carry the
   custom ``X-Lem-Client`` header, and any ``Origin`` it does send must be on
   the localhost allowlist. A browser cannot attach a custom header to a
   cross-origin request without first passing a CORS preflight, so this kills
   the "simple request" attack where a malicious page POSTs to
   http://localhost:5142 with ``mode: 'no-cors'``.

2. Bearer token (enforced when the server is not bound to loopback). The token
   lives in ``~/.lem/api_token`` with mode 0600, so only the local user can read
   it. On a loopback bind the token is accepted but not required - reaching the
   socket at all already requires local access.
"""

import ipaddress
import logging
import os
import secrets
from collections.abc import Callable, Sequence

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.db import FILE_MODE, LEM_HOME, secure_lem_home

logger = logging.getLogger(__name__)

# Origins allowed to drive the API from a browser. Shared by the CORS config and
# the CSRF middleware so the two can never drift apart.
ALLOWED_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",  # Vite dev server (web/remote)
    "http://127.0.0.1:5173",
    "http://localhost:5174",  # Vite dev server (web/local)
    "http://127.0.0.1:5174",
    "http://localhost:3000",  # Future: served by FastAPI
    "http://127.0.0.1:3000",
)

# Methods that cannot change server state, and so need no CSRF proof.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Custom header required on every state-changing request (see module docstring).
CLIENT_HEADER = "x-lem-client"

# Default bind address. LAN exposure is opt-in via LEM_HOST.
DEFAULT_HOST = "127.0.0.1"
HOST_ENV_VAR = "LEM_HOST"

# Bearer token for non-loopback binds.
TOKEN_PATH = LEM_HOME / "api_token"
TOKEN_BYTES = 32

_cached_token: str | None = None


# ============================================================================
# Bind address
# ============================================================================


def get_bind_host() -> str:
    """
    Resolve the address the server binds to.

    Returns:
        Value of $LEM_HOST, or 127.0.0.1 when unset/empty
    """
    return os.environ.get(HOST_ENV_VAR, "").strip() or DEFAULT_HOST


def is_loopback_host(host: str) -> bool:
    """
    Check whether a bind address only accepts connections from this machine.

    Args:
        host: Hostname or IP literal (IPv6 may be bracketed)

    Returns:
        True for localhost and loopback IP literals, False otherwise
        (including 0.0.0.0 and ::, which accept every interface)
    """
    cleaned = host.strip().strip("[]").lower()
    if cleaned in ("localhost", "localhost.localdomain"):
        return True
    try:
        return ipaddress.ip_address(cleaned).is_loopback
    except ValueError:
        # Any other hostname could resolve anywhere - treat as remotely reachable.
        return False


# ============================================================================
# API token
# ============================================================================


def ensure_api_token() -> str:
    """
    Load the API token, creating it on first run.

    The token file is written with mode 0600 inside the owner-only ~/.lem
    directory. The token itself is never logged.

    Returns:
        The API token
    """
    global _cached_token

    existing = _read_token_file()
    if existing is not None:
        _cached_token = existing
        return existing

    token = secrets.token_urlsafe(TOKEN_BYTES)
    secure_lem_home(TOKEN_PATH.parent)
    # os.open with an explicit mode avoids the window where the file exists
    # with umask-derived (world-readable) permissions.
    fd = os.open(TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(token)
    logger.info(f"Generated API token at {TOKEN_PATH}")

    _cached_token = token
    return token


def get_api_token() -> str | None:
    """
    Return the API token without creating one.

    Returns:
        The API token, or None if it has not been generated yet
    """
    global _cached_token

    if _cached_token is None:
        _cached_token = _read_token_file()
    return _cached_token


def _read_token_file() -> str | None:
    """
    Read the token from disk and re-assert its permissions.

    Returns:
        Token contents, or None if the file is missing/empty/unreadable
    """
    try:
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return None

    if not token:
        return None

    try:
        TOKEN_PATH.chmod(FILE_MODE)
    except OSError as e:
        logger.warning(f"Could not restrict permissions on {TOKEN_PATH}: {e}")
    return token


def reset_token_cache() -> None:
    """Drop the in-memory token cache (used by tests)."""
    global _cached_token
    _cached_token = None


# ============================================================================
# Middleware
# ============================================================================


def problem_response(status_code: int, error_type: str, title: str, detail: str) -> JSONResponse:
    """
    Build an RFC 7807 problem+json response.

    Args:
        status_code: HTTP status code
        error_type: Problem type URI suffix (e.g. "csrf-blocked")
        title: Short, human-readable summary
        detail: Explanation specific to this occurrence

    Returns:
        JSONResponse with media type application/problem+json
    """
    return JSONResponse(
        status_code=status_code,
        media_type="application/problem+json",
        content={
            "type": f"https://lem.gg/errors/{error_type}",
            "title": title,
            "status": status_code,
            "detail": detail,
        },
    )


class LocalApiSecurityMiddleware:
    """
    Enforce CSRF protection and (optionally) bearer-token auth on the local API.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_origins: Sequence[str] = ALLOWED_ORIGINS,
        require_token: bool = False,
        token_provider: Callable[[], str | None] = get_api_token,
        protected_prefix: str = "/v1/",
    ) -> None:
        """
        Args:
            app: Downstream ASGI application
            allowed_origins: Origins accepted on state-changing requests
            require_token: Require ``Authorization: Bearer`` on protected paths
            token_provider: Returns the expected token (None disables the check)
            protected_prefix: Path prefix the token requirement applies to
        """
        self.app = app
        self.allowed_origins = frozenset(allowed_origins)
        self.require_token = require_token
        self.token_provider = token_provider
        self.protected_prefix = protected_prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Reject unauthenticated or cross-site requests before they reach a route."""
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        method: str = scope["method"].upper()
        path: str = scope.get("path", "")

        rejection = self._check_token(method, path, headers) or self._check_csrf(method, headers)
        if rejection is not None:
            await rejection(scope, receive, send)
            return

        await self.app(scope, receive, send)

    def _check_token(self, method: str, path: str, headers: Headers) -> JSONResponse | None:
        """
        Validate the bearer token on protected paths.

        Args:
            method: HTTP method
            path: Request path
            headers: Request headers

        Returns:
            A 401 problem response, or None if the request may proceed
        """
        if not self.require_token or method == "OPTIONS":
            return None
        if not path.startswith(self.protected_prefix):
            return None

        expected = self.token_provider()
        if expected is None:
            logger.error("Token auth is required but no API token is available")
            return problem_response(
                503,
                "token-unavailable",
                "Service Unavailable",
                "The server could not load its API token.",
            )

        authorization = headers.get("authorization", "")
        scheme, _, presented = authorization.partition(" ")
        if scheme.lower() != "bearer" or not secrets.compare_digest(presented.strip(), expected):
            logger.warning(f"Rejected unauthenticated request: {method} {path}")
            return problem_response(
                401,
                "unauthorized",
                "Unauthorized",
                "A valid API token is required. See ~/.lem/api_token.",
            )
        return None

    def _check_csrf(self, method: str, headers: Headers) -> JSONResponse | None:
        """
        Require a custom header (and an allowlisted Origin) on unsafe methods.

        Args:
            method: HTTP method
            headers: Request headers

        Returns:
            A 403 problem response, or None if the request may proceed
        """
        if method in SAFE_METHODS:
            return None

        if CLIENT_HEADER not in headers:
            logger.warning(f"Rejected request without {CLIENT_HEADER} header: {method}")
            return problem_response(
                403,
                "csrf-blocked",
                "Forbidden",
                f"State-changing requests must send the {CLIENT_HEADER} header.",
            )

        origin = headers.get("origin")
        if origin is not None and origin not in self.allowed_origins:
            logger.warning(f"Rejected request from disallowed origin: {origin}")
            return problem_response(
                403,
                "origin-not-allowed",
                "Forbidden",
                "This origin is not allowed to call the Lem local API.",
            )
        return None
