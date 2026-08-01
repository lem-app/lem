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

"""Verification of relay session grants.

The relay used to accept any JWT whose signature verified. It never checked
who the token was for, and never checked that the bearer had anything to do
with the session named in the URL. Since session ids were derived from device
ids, any account could compute a stranger's session id, connect, and be paired
with that stranger's machine.

A relay session grant fixes both halves. It is minted by the signaling server
only after it has confirmed that both devices belong to the same user, and it
names the session, the bearer, and the single permitted peer. The relay
verifies it offline: no lookup against the signaling server is needed, because
the grant is signed with the secret both services already share.
"""

from dataclasses import dataclass
from typing import Any

from jose import JWTError, jwt

from .config import settings

# Scope claim that distinguishes a session grant from an account access token.
# Without this an ordinary login token would still be accepted here.
RELAY_GRANT_SCOPE = "relay-session"


class InvalidGrantError(ValueError):
    """Raised when a presented token is not a valid grant for this session."""


@dataclass(frozen=True)
class SessionGrant:
    """An authenticated claim to join one relay session as one device."""

    session_id: str
    device_id: str
    peer_device_id: str
    user_id: int
    jti: str

    @property
    def device_pair(self) -> frozenset[str]:
        """The two device ids this session is restricted to.

        Returns:
            Frozen set of both device identifiers.
        """
        return frozenset((self.device_id, self.peer_device_id))


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and verify a JWT.

    Args:
        token: JWT token to decode.

    Returns:
        Decoded token payload.

    Raises:
        JWTError: If token is invalid, expired, or carries no expiry.
    """
    payload: dict[str, Any] = jwt.decode(
        token,
        settings.secret_key,
        algorithms=[settings.algorithm],
        # Without this a token that simply omits "exp" is valid forever.
        # python-jose spells the requirement "require_exp"; the PyJWT-style
        # {"require": ["exp"]} is silently ignored here.
        options={"require_exp": True},
    )
    return payload


def decode_session_grant(token: str, session_id: str) -> SessionGrant:
    """Verify a grant and check that it authorizes this exact session.

    Args:
        token: Grant presented by the client.
        session_id: Session id taken from the request path.

    Returns:
        The verified grant.

    Raises:
        InvalidGrantError: If the token is not a valid grant for this session.
    """
    try:
        payload = decode_access_token(token)
    except JWTError as exc:
        raise InvalidGrantError(f"Token rejected: {exc}") from exc

    if payload.get("scope") != RELAY_GRANT_SCOPE:
        raise InvalidGrantError("Token is not a relay session grant")

    claimed_session = payload.get("sid")
    if not isinstance(claimed_session, str) or claimed_session != session_id:
        # The session id in the URL is attacker-controlled; the one in the
        # signed grant is not. They have to agree.
        raise InvalidGrantError("Grant is not valid for this session")

    device_id = payload.get("device_id")
    peer_device_id = payload.get("peer_device_id")
    user_id = payload.get("user_id")
    jti = payload.get("jti")

    if not isinstance(device_id, str) or not device_id:
        raise InvalidGrantError("Grant is missing device_id")
    if not isinstance(peer_device_id, str) or not peer_device_id:
        raise InvalidGrantError("Grant is missing peer_device_id")
    if not isinstance(user_id, int) or isinstance(user_id, bool):
        raise InvalidGrantError("Grant is missing user_id")
    if not isinstance(jti, str) or not jti:
        raise InvalidGrantError("Grant is missing jti")
    if device_id == peer_device_id:
        raise InvalidGrantError("Grant names the same device on both sides")

    return SessionGrant(
        session_id=session_id,
        device_id=device_id,
        peer_device_id=peer_device_id,
        user_id=user_id,
        jti=jti,
    )
