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

import aiosqlite
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError

from ..core.security import decode_access_token
from ..db import get_db
from ..models import DeviceRegister, DeviceResponse

router = APIRouter(prefix="/devices", tags=["devices"])
security = HTTPBearer()


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


@router.post("/register", response_model=DeviceResponse)
async def register_device(
    device_data: DeviceRegister,
    db: aiosqlite.Connection = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
) -> DeviceResponse:
    """Register or update a device (idempotent).

    Uses atomic UPSERT to handle reconnections and pubkey updates.
    Only the device owner can update their device (prevents hijacking).

    Args:
        device_data: Device registration data.
        db: Database connection.
        user_id: Current user ID.

    Returns:
        Registered/updated device information.

    Raises:
        HTTPException: If device is owned by another user.
    """
    # Check if device exists and belongs to a different user
    async with db.execute(
        "SELECT user_id FROM devices WHERE id = ?", (device_data.device_id,)
    ) as cursor:
        existing_device = await cursor.fetchone()
        if existing_device and existing_device["user_id"] != user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Device ID belongs to another user",
            )

    # Atomic upsert: create or update device
    await db.execute(
        """
        INSERT INTO devices (id, user_id, pubkey, created_at, last_seen)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            pubkey = excluded.pubkey,
            last_seen = CURRENT_TIMESTAMP
        """,
        (device_data.device_id, user_id, device_data.pubkey),
    )
    await db.commit()

    # Fetch and return the device
    async with db.execute(
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
    db: aiosqlite.Connection = Depends(get_db),
    user_id: int = Depends(get_current_user_id),
) -> list[DeviceResponse]:
    """List all devices for the current user.

    Args:
        db: Database connection.
        user_id: Current user ID.

    Returns:
        List of user's devices.
    """
    async with db.execute(
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
