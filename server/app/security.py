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

2. Bearer token (enforced unless the server has *verified* that it listens on
   loopback only). The token lives in ``~/.lem/api_token`` with mode 0600, so
   only the local user can read it. On a verified loopback bind the token is
   accepted but not required - reaching the socket at all already requires
   local access. A short-lived session token (see :mod:`app.sessions`) is
   accepted anywhere the root token is, so a browser never has to hold the
   permanent credential.

The two defenses are not redundant. A raw bearer holder - curl, a script, a
compromised host on the LAN - has no ``Origin`` to spoof and never trips the
CSRF check; the token is what stops it. A browser, conversely, will happily be
driven cross-origin by a hostile page that has no token at all; ``X-Lem-Client``
plus the origin allowlist is what stops *that*. Each layer covers the path the
other one cannot see.

The second defense used to be derived from ``$LEM_HOST`` alone, which is a
different value from the address uvicorn is actually told to bind. When the two
diverged the server published a Docker control plane to the network while
logging that it was loopback-only. The posture is now derived from
``socket.getsockname()`` on the real listening socket (see
:func:`verify_bind_posture`, called by ``app.serve``), and it fails closed: if
the bound address cannot be verified, the token is required.

One shape the process genuinely cannot observe: a reverse proxy (or
``vite --host``) in front of a *verified loopback* bind republishes the API to
the network while ``getsockname()`` still, correctly, reports 127.0.0.1.
``$LEM_REQUIRE_TOKEN`` is the operator's answer - see
:func:`token_required_override`.
"""

import ipaddress
import logging
import os
import secrets
import socket
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from app.db import FILE_MODE, LEM_HOME, secure_lem_home
from app.sessions import verify_session

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

# Extra browser origins, for the LAN opt-in: the built-in allowlist is
# localhost-only, so a dashboard served from another host would be refused.
ORIGINS_ENV_VAR = "LEM_ALLOWED_ORIGINS"

# Methods that cannot change server state, and so need no CSRF proof.
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# Custom header required on every state-changing request (see module docstring).
CLIENT_HEADER = "x-lem-client"

# Default bind address. LAN exposure is opt-in via LEM_HOST.
DEFAULT_HOST = "127.0.0.1"
HOST_ENV_VAR = "LEM_HOST"

# Default listen port.
DEFAULT_PORT = 5142
PORT_ENV_VAR = "LEM_PORT"

# Bearer token for non-loopback binds.
TOKEN_PATH = LEM_HOME / "api_token"
TOKEN_BYTES = 32

# Operator override: require the bearer token even on a verified loopback bind.
REQUIRE_TOKEN_ENV_VAR = "LEM_REQUIRE_TOKEN"

# Values accepted as "yes" for LEM_REQUIRE_TOKEN. Anything else is false, so a
# typo can only ever fail towards *not* claiming protection that is not there.
TRUTHY = frozenset({"1", "true", "yes", "on"})

_cached_token: str | None = None


# ============================================================================
# Bind address
# ============================================================================


def get_bind_host() -> str:
    """
    Resolve the address the server binds to.

    This is only a *request*: what the process ends up listening on is settled
    by :func:`verify_bind_posture` once the socket exists.

    Returns:
        Value of $LEM_HOST, or 127.0.0.1 when unset/empty
    """
    return os.environ.get(HOST_ENV_VAR, "").strip() or DEFAULT_HOST


def get_bind_port() -> int:
    """
    Resolve the port the server binds to.

    Returns:
        Value of $LEM_PORT, or 5142 when unset/empty/invalid
    """
    raw = os.environ.get(PORT_ENV_VAR, "").strip()
    if not raw:
        return DEFAULT_PORT
    try:
        return int(raw)
    except ValueError:
        logger.warning(f"Ignoring invalid {PORT_ENV_VAR}={raw!r}; using {DEFAULT_PORT}")
        return DEFAULT_PORT


def get_allowed_origins() -> tuple[str, ...]:
    """
    Build the browser origin allowlist, including the $LEM_ALLOWED_ORIGINS opt-in.

    ``LEM_HOST`` lets the API be served on the LAN, but the built-in allowlist
    only names localhost, so a dashboard loaded from another host would have
    every state-changing request refused with ``origin-not-allowed``. This is
    the knob that makes LAN mode usable. A wildcard is refused: it would turn
    the Origin half of the CSRF check off entirely.

    Returns:
        Allowlisted origins, built-ins first, duplicates removed
    """
    raw = os.environ.get(ORIGINS_ENV_VAR, "")
    extra: list[str] = []
    for candidate in raw.split(","):
        origin = candidate.strip().rstrip("/")
        if not origin:
            continue
        if origin == "*":
            logger.warning(f"Ignoring '*' in {ORIGINS_ENV_VAR}: a wildcard origin is not allowed")
            continue
        if not origin.startswith(("http://", "https://")):
            logger.warning(f"Ignoring {ORIGINS_ENV_VAR} entry {origin!r}: must be a full origin")
            continue
        extra.append(origin)

    if extra:
        logger.info(f"{ORIGINS_ENV_VAR} adds {len(extra)} browser origin(s): {', '.join(extra)}")
    return tuple(dict.fromkeys((*ALLOWED_ORIGINS, *extra)))


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
# Bind posture (derived from the real listening socket)
# ============================================================================


@dataclass(frozen=True)
class BindPosture:
    """What the process has actually established about the socket it listens on.

    Attributes:
        verified: True only when a real bound address was read successfully
        loopback_only: True when every verified address stays on this machine
        addresses: Human-readable bound addresses (empty when unverified)
        reason: Why the posture is what it is, for logging
    """

    verified: bool
    loopback_only: bool
    addresses: tuple[str, ...]
    reason: str

    @property
    def require_token(self) -> bool:
        """Whether /v1/* must carry a bearer token.

        Fails closed: anything other than a *verified* loopback bind requires
        the token, including a bind we could not determine at all.
        """
        return not (self.verified and self.loopback_only)

    def describe(self) -> str:
        """Render the posture for a startup log line.

        Returns:
            One-line summary naming the verified address or the lack of one
        """
        if not self.verified:
            return f"bind address NOT verified ({self.reason})"
        where = ", ".join(self.addresses)
        scope = "loopback only" if self.loopback_only else "network-reachable"
        return f"verified listening on {where} ({scope})"


# Startup default: nothing has been verified yet, so the token is required.
UNVERIFIED_BIND = BindPosture(
    verified=False,
    loopback_only=False,
    addresses=(),
    reason=(
        "the server was not started through Lem's own entrypoint, so it never "
        "saw the listening socket - run 'uv run lem-serve' (or "
        "'python -m app.serve')"
    ),
)

_bind_posture: BindPosture = UNVERIFIED_BIND


def get_bind_posture() -> BindPosture:
    """
    Return the current bind posture.

    Returns:
        The posture established at startup (unverified until then)
    """
    return _bind_posture


def set_bind_posture(posture: BindPosture) -> BindPosture:
    """
    Install a bind posture.

    Args:
        posture: Posture to install

    Returns:
        The installed posture
    """
    global _bind_posture
    _bind_posture = posture
    return posture


def reset_bind_posture() -> None:
    """Restore the fail-closed default (used by tests)."""
    set_bind_posture(UNVERIFIED_BIND)


def token_required_override() -> bool:
    """
    Whether ``$LEM_REQUIRE_TOKEN`` asks for the token unconditionally.

    The bind posture is read from the real socket, which makes it honest about
    everything the *process* can see - and blind to everything in front of it.
    Put nginx, Caddy, an SSH tunnel or ``vite --host`` ahead of a loopback bind
    and the API is on the network while ``getsockname()`` still says 127.0.0.1;
    the server would then correctly report "loopback only" and correctly require
    no credential, and be wrong about the thing that matters.

    Only the operator knows what is in front of the socket, so this is the knob
    they use to say so. It can only ever *add* the requirement: there is
    deliberately no value that switches the token off on a network-reachable
    bind.

    Kept as an environment read alongside ``LEM_HOST``/``LEM_PORT``/
    ``LEM_ALLOWED_ORIGINS`` rather than a pydantic-settings object, because this
    module is already the one place the local API's security environment is
    resolved and a second config path is exactly the drift that put the bind
    posture and the auth gate on different values once before.

    Returns:
        True when $LEM_REQUIRE_TOKEN is set to 1/true/yes/on (case-insensitive)
    """
    return os.environ.get(REQUIRE_TOKEN_ENV_VAR, "").strip().lower() in TRUTHY


def token_required() -> bool:
    """
    Whether the bearer token is enforced right now.

    Returns:
        True unless a loopback-only bind has been positively verified and the
        operator has not overridden that with $LEM_REQUIRE_TOKEN
    """
    return _bind_posture.require_token or token_required_override()


def _sockname_host(sock: socket.socket) -> str | None:
    """
    Extract the host part of a socket's bound address.

    Args:
        sock: A bound socket

    Returns:
        Host as a string, or None if the family is not IP (so: undeterminable)
    """
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return None
    sockname = sock.getsockname()
    if not isinstance(sockname, tuple) or len(sockname) < 2:
        return None
    host = sockname[0]
    return host if isinstance(host, str) else None


def verify_bind_posture(sockets: Iterable[socket.socket]) -> BindPosture:
    """
    Derive and install the security posture from the real listening sockets.

    ``getsockname()`` is authoritative: it is what the kernel bound, not what
    some environment variable asked for. Anything we cannot read is treated as
    remotely reachable.

    Args:
        sockets: The sockets the server will accept connections on

    Returns:
        The installed posture
    """
    addresses: list[str] = []
    loopback = True

    for sock in sockets:
        try:
            host = _sockname_host(sock)
        except OSError as e:
            return set_bind_posture(
                BindPosture(False, False, (), f"could not read the bound address: {e}")
            )
        if host is None:
            return set_bind_posture(
                BindPosture(False, False, (), f"unsupported socket family {sock.family!r}")
            )
        try:
            port = int(sock.getsockname()[1])
        except (OSError, IndexError, TypeError, ValueError) as e:
            return set_bind_posture(
                BindPosture(False, False, (), f"could not read the bound port: {e}")
            )
        addresses.append(f"{host}:{port}")
        loopback = loopback and is_loopback_host(host)

    if not addresses:
        return set_bind_posture(BindPosture(False, False, (), "no listening socket was reported"))

    return set_bind_posture(
        BindPosture(
            verified=True,
            loopback_only=loopback,
            addresses=tuple(addresses),
            reason="read from the bound socket",
        )
    )


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


def extract_bearer(authorization: str | None) -> str | None:
    """
    Pull the credential out of an ``Authorization`` header.

    Args:
        authorization: Raw header value, or None when absent

    Returns:
        The token, or None if the header is missing, empty, or not Bearer
    """
    if not authorization:
        return None
    scheme, _, presented = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return presented.strip() or None


def tokens_match(presented: str, expected: str) -> bool:
    """
    Compare a presented credential against the expected one, in constant time.

    Args:
        presented: Value from the request (attacker-controlled)
        expected: Value the server holds

    Returns:
        True when the two are equal
    """
    # secrets.compare_digest raises TypeError on non-ASCII str arguments, and
    # `presented` comes straight off the wire. Nothing we mint is non-ASCII, so
    # such a value is a non-match rather than a 500.
    if not presented.isascii() or not expected.isascii():
        return False
    return secrets.compare_digest(presented, expected)


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


def _as_provider(value: bool | Callable[[], bool]) -> Callable[[], bool]:
    """
    Normalize a fixed flag or a live callable into a callable.

    Args:
        value: A constant, or a function evaluated per request

    Returns:
        A zero-argument callable returning the flag
    """
    if isinstance(value, bool):
        return lambda: value
    return value


class LocalApiSecurityMiddleware:
    """
    Enforce CSRF protection and (optionally) bearer-token auth on the local API.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_origins: Sequence[str] = ALLOWED_ORIGINS,
        require_token: bool | Callable[[], bool] = token_required,
        token_provider: Callable[[], str | None] = get_api_token,
        session_verifier: Callable[[str], bool] = verify_session,
        protected_prefix: str = "/v1/",
    ) -> None:
        """
        Args:
            app: Downstream ASGI application
            allowed_origins: Origins accepted on state-changing requests
            require_token: Require ``Authorization: Bearer`` on protected paths.
                Defaults to the live bind posture, which fails closed until a
                loopback-only bind has been verified.
            token_provider: Returns the expected root token (None disables the
                check)
            session_verifier: Returns True for a live session token minted by
                ``POST /v1/auth/session``
            protected_prefix: Path prefix the token requirement applies to
        """
        self.app = app
        self.allowed_origins = frozenset(allowed_origins)
        self.token_required = _as_provider(require_token)
        self.token_provider = token_provider
        self.session_verifier = session_verifier
        self.protected_prefix = protected_prefix

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Reject unauthenticated or cross-site requests before they reach a route."""
        # The local API serves no WebSocket routes today. If one is ever added,
        # this passthrough would silently exempt it - the checks below read an
        # HTTP method and path, so they need a WebSocket equivalent first.
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

        Either credential is accepted: the root token from ``~/.lem/api_token``,
        or a live session token traded for it at ``POST /v1/auth/session``. The
        session token is what a browser holds, so the permanent secret never has
        to reach one. The exchange endpoint itself accepts *only* the root token
        (see :mod:`app.api.v1.session`), which is why a session cannot renew
        itself into a second permanent credential.

        Args:
            method: HTTP method
            path: Request path
            headers: Request headers

        Returns:
            A 401 problem response, or None if the request may proceed
        """
        if not self.token_required() or method == "OPTIONS":
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

        presented = extract_bearer(headers.get("authorization"))
        if presented is None or not (
            tokens_match(presented, expected) or self.session_verifier(presented)
        ):
            # Method and path only - never the presented value, not even a
            # prefix of it. A rejected request may well carry a *valid*
            # credential for another server, and logs are not 0600.
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
