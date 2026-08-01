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
Short-lived session tokens for browser clients of the local API.

The root credential is ``~/.lem/api_token``: a 0600 file, stable across
restarts, granting full Docker control. A browser cannot read it, and shipping
it into a bundle is how the previous attempt at LAN access failed - Vite inlines
``VITE_*`` values as plaintext literals, so the credential landed in
``dist/assets/*.js`` for exactly the LAN population it exists to keep out.

So the operator pastes the root token once, at runtime, and trades it here for a
session token. What then lives in the browser is a *derived* credential:

* **Memory only.** The store below is a module-level dict. Nothing is written to
  disk or to the database. A server restart therefore invalidates every session
  and the browser re-prompts. That is intended, not a gap to be closed with
  persistence: the sessions are cheap to re-mint and impossible to steal from a
  file that does not exist.
* **Fixed TTL, no refresh.** Twelve hours, no sliding window, no refresh
  endpoint. An abandoned tab stops working by itself.
* **Not privilege-preserving.** A session token cannot mint another session
  token - see :mod:`app.api.v1.session`. Only the root token can, so a leaked
  session expires into nothing instead of renewing itself forever.

Tokens are never logged, at any level, in any truncated form.
"""

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

# How long a minted session stays valid. Deliberately not configurable: a knob
# here is a knob for making the credential longer-lived, which is the wrong
# direction, and nobody has asked for a shorter one.
SESSION_TTL = timedelta(hours=12)

# Entropy per session token, in bytes, before URL-safe encoding.
SESSION_TOKEN_BYTES = 32


@dataclass(frozen=True)
class Session:
    """A minted session credential.

    Attributes:
        token: The bearer value handed to the browser
        expires_at: Timezone-aware UTC instant after which the token is dead
    """

    token: str
    expires_at: datetime


# token -> expiry. Process memory only; see the module docstring.
_sessions: dict[str, datetime] = {}


def _utcnow() -> datetime:
    """
    Current time, timezone-aware.

    Returns:
        The current instant in UTC
    """
    return datetime.now(UTC)


def _find(token: str) -> str | None:
    """
    Locate a stored token equal to ``token``, comparing in constant time.

    A plain ``dict`` lookup would compare with ``==``, which returns as soon as
    two bytes differ. The scan is O(number of live sessions), which is a handful
    for a single-operator machine.

    Args:
        token: Candidate token from a request

    Returns:
        The matching stored key, or None
    """
    # compare_digest raises TypeError on non-ASCII str inputs, and the value
    # arrives from an Authorization header an attacker controls. Nothing we
    # ever mint is non-ASCII, so a non-ASCII candidate is simply not a match.
    if not token or not token.isascii():
        return None

    matched: str | None = None
    for candidate in _sessions:
        # No early break: returning on the first hit would leak, through timing,
        # roughly where in the store a guessed token sits.
        if secrets.compare_digest(candidate, token):
            matched = candidate
    return matched


def reap_expired() -> int:
    """
    Drop every expired session from the store.

    Called on each mint and each verification, which is enough to keep the dict
    bounded without a background task: an expired entry cannot outlive the next
    request that touches the store.

    Returns:
        Number of sessions removed
    """
    now = _utcnow()
    dead = [token for token, expires_at in _sessions.items() if expires_at <= now]
    for token in dead:
        del _sessions[token]
    return len(dead)


def mint_session(ttl: timedelta = SESSION_TTL) -> Session:
    """
    Create a session token.

    Args:
        ttl: Lifetime of the session (tests pass a negative value to build an
            already-expired session without sleeping)

    Returns:
        The minted session
    """
    reap_expired()

    token = secrets.token_urlsafe(SESSION_TOKEN_BYTES)
    expires_at = _utcnow() + ttl
    _sessions[token] = expires_at
    return Session(token=token, expires_at=expires_at)


def verify_session(token: str) -> bool:
    """
    Check whether a token names a live session.

    Args:
        token: Bearer value presented by the client

    Returns:
        True if the token is known and unexpired
    """
    reap_expired()
    return _find(token) is not None


def revoke_session(token: str) -> bool:
    """
    Invalidate a session token immediately.

    Args:
        token: Bearer value presented by the client

    Returns:
        True if a session was removed, False if the token was already unknown
    """
    matched = _find(token)
    if matched is None:
        return False
    del _sessions[matched]
    return True


def session_count() -> int:
    """
    Number of sessions currently held, expired ones included.

    Returns:
        Size of the store (used by tests to prove reaping happens)
    """
    return len(_sessions)


def clear_sessions() -> None:
    """Drop every session (used by tests and on shutdown)."""
    _sessions.clear()
