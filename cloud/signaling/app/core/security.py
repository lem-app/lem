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

"""Security utilities for authentication and authorization."""

import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
from jose import jwt

from .config import settings

# bcrypt hashes at most 72 bytes of input and silently ignores the rest, which
# would make "correct horse battery staple..." and a 200-byte variant of it the
# same password. Inputs are rejected rather than truncated; the API schema
# enforces the same bound so callers get a 422 instead of a 500.
BCRYPT_MAX_PASSWORD_BYTES = 72

# Scope claim identifying a short-lived relay session grant. A grant is not an
# account token: it authorizes exactly one device to join exactly one relay
# session with exactly one peer.
RELAY_GRANT_SCOPE = "relay-session"


class PasswordTooLongError(ValueError):
    """Raised when a password exceeds what bcrypt can hash without truncation."""


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against a hash.

    Args:
        plain_password: Plain text password.
        hashed_password: Hashed password.

    Returns:
        True if password matches, False otherwise.
    """
    password_bytes = plain_password.encode("utf-8")
    if len(password_bytes) > BCRYPT_MAX_PASSWORD_BYTES:
        # Never silently truncate on the verify path either: an over-long
        # password can only be wrong, because it could never have been hashed.
        return False
    try:
        return bcrypt.checkpw(password_bytes, hashed_password.encode("utf-8"))
    except ValueError:
        # Malformed stored hash. Treat as a failed login rather than a 500.
        return False


def get_password_hash(password: str) -> str:
    """Hash a password with bcrypt.

    Args:
        password: Plain text password.

    Returns:
        Hashed password.

    Raises:
        PasswordTooLongError: If the password exceeds bcrypt's 72-byte input.
    """
    password_bytes = password.encode("utf-8")
    if len(password_bytes) > BCRYPT_MAX_PASSWORD_BYTES:
        raise PasswordTooLongError(
            f"Password must be at most {BCRYPT_MAX_PASSWORD_BYTES} bytes when UTF-8 encoded"
        )
    return bcrypt.hashpw(password_bytes, bcrypt.gensalt()).decode("utf-8")


def create_access_token(data: dict[str, Any], expires_delta: timedelta | None = None) -> str:
    """Create a JWT access token.

    Args:
        data: Data to encode in the token.
        expires_delta: Token expiration time delta.

    Returns:
        Encoded JWT token.
    """
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.now(UTC) + expires_delta
    else:
        expire = datetime.now(UTC) + timedelta(
            minutes=settings.access_token_expire_minutes
        )
    to_encode.update({"exp": expire})
    encoded_jwt: str = jwt.encode(to_encode, settings.secret_key, algorithm=settings.algorithm)
    return encoded_jwt


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and verify a JWT access token.

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


def new_relay_session_id() -> str:
    """Mint an unguessable relay session identifier.

    Session ids used to be derived from device ids, which are neither secret
    nor unpredictable, so anyone could compute another user's session id.

    Returns:
        A URL-safe random session identifier.
    """
    return secrets.token_urlsafe(32)


def create_relay_grant(
    session_id: str, device_id: str, peer_device_id: str, user_id: int
) -> str:
    """Mint a short-lived token authorizing one device to join one relay session.

    The relay verifies this instead of accepting any signed account token, so
    it can enforce *who* may join a session without querying the signaling
    server on every connection.

    Args:
        session_id: Relay session the grant is valid for.
        device_id: Device permitted to present this grant.
        peer_device_id: The only device permitted on the other side.
        user_id: Owner of both devices.

    Returns:
        Encoded JWT grant.
    """
    expire = datetime.now(UTC) + timedelta(seconds=settings.relay_grant_ttl_seconds)
    claims: dict[str, Any] = {
        "scope": RELAY_GRANT_SCOPE,
        "sid": session_id,
        "device_id": device_id,
        "peer_device_id": peer_device_id,
        "user_id": user_id,
        # Unique id so the relay can refuse to redeem the same grant twice.
        "jti": secrets.token_urlsafe(16),
        "exp": expire,
    }
    grant: str = jwt.encode(claims, settings.secret_key, algorithm=settings.algorithm)
    return grant
