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

"""Device registration endpoints."""

import logging
from collections.abc import Iterable

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError

from ..core.config import settings
from ..core.crypto import (
    REGISTER_CONTEXT,
    ChallengeStore,
    InvalidPublicKeyError,
    decode_public_key,
    verify_signature,
)
from ..core.security import decode_access_token
from ..db import USE_POSTGRES, DBConnection, DBRow, as_postgres, as_sqlite, get_db
from ..models import (
    DeviceChallengeRequest,
    DeviceChallengeResponse,
    DeviceRegister,
    DeviceResponse,
)

router = APIRouter(prefix="/devices", tags=["devices"])
security = HTTPBearer()
logger = logging.getLogger(__name__)

# Challenges outstanding for device registration.
registration_challenges = ChallengeStore(settings.challenge_ttl_seconds)


async def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> int:
    """Get current user ID from JWT token.

    Args:
        credentials: HTTP bearer token.

    Returns:
        User ID.

    Raises:
        HTTPException: If token is invalid.
    """
    try:
        payload = decode_access_token(credentials.credentials)
        user_id: int | None = payload.get("user_id")
        if user_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
            )
        return user_id
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )


def registration_challenge_key(user_id: int, device_id: str) -> str:
    """Build the challenge store key for a device registration.

    Args:
        user_id: Owner of the device.
        device_id: Device being registered.

    Returns:
        Opaque store key.
    """
    return f"register:{user_id}:{device_id}"


@router.post("/challenge", response_model=DeviceChallengeResponse)
async def request_device_challenge(
    challenge_request: DeviceChallengeRequest,
    user_id: int = Depends(get_current_user_id),
) -> DeviceChallengeResponse:
    """Issue a challenge the device must sign to register.

    Args:
        challenge_request: Device the challenge is for.
        user_id: Current user ID.

    Returns:
        A single-use challenge and the context string to sign with it.
    """
    challenge = registration_challenges.issue(
        registration_challenge_key(user_id, challenge_request.device_id)
    )
    return DeviceChallengeResponse(
        device_id=challenge_request.device_id,
        challenge=challenge,
        context=REGISTER_CONTEXT.decode("ascii"),
        expires_in=settings.challenge_ttl_seconds,
    )


@router.post("/register", response_model=DeviceResponse)
async def register_device(
    device_data: DeviceRegister,
    db: DBConnection = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
) -> DeviceResponse:
    """Register or update a device (idempotent).

    Uses atomic UPSERT to handle reconnections and pubkey updates.
    Only the device owner can update their device (prevents hijacking), and
    the caller must prove possession of the private key matching ``pubkey``
    by signing a challenge obtained from ``POST /devices/challenge``.

    Args:
        device_data: Device registration data.
        db: Database connection.
        user_id: Current user ID.

    Returns:
        Registered/updated device information.

    Raises:
        HTTPException: If device is owned by another user, the public key is
            malformed, or proof of possession fails.
    """
    try:
        decode_public_key(device_data.pubkey)
    except InvalidPublicKeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid public key: {exc}",
        ) from exc

    # Redeem first: the challenge is single use whether or not the signature
    # verifies, so a failed attempt cannot be retried against the same nonce.
    challenge_key = registration_challenge_key(user_id, device_data.device_id)
    redeemed = registration_challenges.redeem(challenge_key, device_data.challenge)
    if not redeemed or not verify_signature(
        device_data.pubkey,
        REGISTER_CONTEXT,
        device_data.device_id,
        device_data.challenge,
        device_data.signature,
    ):
        logger.warning(
            f"Device registration proof-of-possession failed for "
            f"{device_data.device_id} (user {user_id})"
        )
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid device challenge signature",
        )

    device: DBRow | None
    existing_device: DBRow | None
    if USE_POSTGRES:
        # PostgreSQL syntax
        pg = as_postgres(db)
        existing_device = await pg.fetchrow(
            "SELECT user_id FROM devices WHERE id = $1", device_data.device_id
        )
        if existing_device and existing_device["user_id"] != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Device ID belongs to another user",
            )

        # Atomic upsert: create or update device
        await pg.execute(
            """
            INSERT INTO devices (id, user_id, pubkey, created_at, last_seen)
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                pubkey = excluded.pubkey,
                last_seen = CURRENT_TIMESTAMP
            """,
            device_data.device_id,
            user_id,
            device_data.pubkey,
        )

        # Fetch and return the device
        device = await pg.fetchrow(
            "SELECT id, user_id, pubkey, created_at, last_seen FROM devices WHERE id = $1",
            device_data.device_id,
        )
    else:
        # SQLite syntax
        sqlite = as_sqlite(db)
        async with sqlite.execute(
            "SELECT user_id FROM devices WHERE id = ?", (device_data.device_id,)
        ) as cursor:
            existing_device = await cursor.fetchone()
            if existing_device and existing_device["user_id"] != user_id:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Device ID belongs to another user",
                )

        # Atomic upsert: create or update device
        await sqlite.execute(
            """
            INSERT INTO devices (id, user_id, pubkey, created_at, last_seen)
            VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
                pubkey = excluded.pubkey,
                last_seen = CURRENT_TIMESTAMP
            """,
            (device_data.device_id, user_id, device_data.pubkey),
        )
        await sqlite.commit()

        # Fetch and return the device
        async with sqlite.execute(
            "SELECT id, user_id, pubkey, created_at, last_seen FROM devices WHERE id = ?",
            (device_data.device_id,),
        ) as cursor:
            device = await cursor.fetchone()

    if not device:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create device",
        )

    return DeviceResponse(
        id=device["id"],
        user_id=device["user_id"],
        pubkey=device["pubkey"],
        created_at=device["created_at"],
        last_seen=device["last_seen"],
    )


@router.get("/", response_model=list[DeviceResponse])
async def list_devices(
    db: DBConnection = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
) -> list[DeviceResponse]:
    """List all devices for the current user.

    Args:
        db: Database connection.
        user_id: Current user ID.

    Returns:
        List of user's devices.
    """
    devices: Iterable[DBRow]
    if USE_POSTGRES:
        # PostgreSQL syntax
        devices = await as_postgres(db).fetch(
            "SELECT id, user_id, pubkey, created_at, last_seen FROM devices WHERE user_id = $1",
            user_id,
        )
    else:
        # SQLite syntax
        async with as_sqlite(db).execute(
            "SELECT id, user_id, pubkey, created_at, last_seen FROM devices WHERE user_id = ?",
            (user_id,),
        ) as cursor:
            devices = await cursor.fetchall()

    return [
        DeviceResponse(
            id=device["id"],
            user_id=device["user_id"],
            pubkey=device["pubkey"],
            created_at=device["created_at"],
            last_seen=device["last_seen"],
        )
        for device in devices
    ]
