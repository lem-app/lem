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
Authentication proxy endpoints.

These endpoints forward authentication requests to the signaling server
and manage local auth state for TunnelAgent integration.
"""

import logging
import uuid
from typing import TYPE_CHECKING, Any

import aiohttp
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.db import (
    AuthState,
    delete_auth_state,
    get_auth_state,
    get_device,
    register_device,
    set_auth_state,
)

if TYPE_CHECKING:
    from app.tunnel.manager import TunnelManager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Global reference to TunnelManager (set by main.py)
_tunnel_manager: "TunnelManager | None" = None


def set_tunnel_manager(manager: "TunnelManager") -> None:
    """Set the TunnelManager instance for auth endpoints.

    Args:
        manager: TunnelManager instance
    """
    global _tunnel_manager
    _tunnel_manager = manager


class RegisterRequest(BaseModel):
    """Register request model."""

    email: str
    password: str
    signaling_url: str


class LoginRequest(BaseModel):
    """Login request model."""

    email: str
    password: str
    signaling_url: str


class AuthResponse(BaseModel):
    """Auth response model (used for both login and register)."""

    status: str
    device_id: str
    tunnel_status: str


class LogoutResponse(BaseModel):
    """Logout response model."""

    status: str
    tunnel_status: str


class AuthStatusResponse(BaseModel):
    """Auth status response model."""

    authenticated: bool
    email: str | None = None
    device_id: str | None = None
    tunnel_status: str


@router.post("/register", response_model=AuthResponse)
async def register(request: RegisterRequest) -> AuthResponse:
    """
    Register via signaling server proxy.

    This endpoint:
    1. Forwards registration to signaling server
    2. Receives JWT token
    3. Generates local device_id
    4. Registers device with signaling server
    5. Stores auth state in SQLite
    6. Triggers TunnelAgent start

    Args:
        request: Registration credentials and signaling server URL

    Returns:
        Auth response with device_id and tunnel status

    Raises:
        HTTPException: 400 if email already exists, 503 if signaling server unavailable
    """
    signaling_url = request.signaling_url.rstrip("/")

    try:
        # Step 1: Register with signaling server
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{signaling_url}/auth/register",
                json={"email": request.email, "password": request.password},
            ) as resp:
                if resp.status == 400:
                    error_data = await resp.json()
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=error_data.get("detail", "Email already registered"),
                    )
                elif resp.status not in (200, 201):
                    error_text = await resp.text()
                    logger.error(f"Signaling server registration failed: {error_text}")
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=f"Signaling server error: {error_text}",
                    )

                auth_data = await resp.json()
                jwt_token: str = auth_data["access_token"]

            # Step 2: Get or create persistent device_id for this local server
            device = get_device()
            if device is None:
                # First time registration - create persistent device_id
                device_id = f"local-server-{uuid.uuid4().hex[:8]}"
                register_device(device_id=device_id, pubkey="placeholder-pubkey")
                logger.info(f"Created new device_id: {device_id}")
            else:
                # Reuse existing device_id
                device_id = device.id
                logger.info(f"Reusing existing device_id: {device_id}")

            # Step 3: Register device with signaling server
            async with session.post(
                f"{signaling_url}/devices/register",
                headers={"Authorization": f"Bearer {jwt_token}"},
                json={"device_id": device_id, "pubkey": "placeholder-pubkey"},
            ) as resp:
                if resp.status not in (200, 201):
                    error_text = await resp.text()
                    logger.error(f"Device registration failed: {error_text}")
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=f"Device registration failed: {error_text}",
                    )

        # Step 4: Store auth state in SQLite
        auth_state = AuthState(
            email=request.email,
            jwt_token=jwt_token,
            device_id=device_id,
            signaling_url=signaling_url,
        )
        set_auth_state(auth_state)

        logger.info(f"User {request.email} registered, device_id={device_id}")

        # Step 5: Start TunnelAgent via TunnelManager
        if _tunnel_manager:
            try:
                await _tunnel_manager.start()
                tunnel_status = "connecting"
            except Exception as e:
                logger.error(f"Failed to start TunnelAgent: {e}")
                tunnel_status = "failed"
        else:
            logger.warning("TunnelManager not initialized")
            tunnel_status = "offline"

        return AuthResponse(
            status="ok",
            device_id=device_id,
            tunnel_status=tunnel_status,
        )

    except aiohttp.ClientError as e:
        logger.error(f"Failed to connect to signaling server: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Cannot connect to signaling server at {signaling_url}",
        ) from e


@router.post("/login", response_model=AuthResponse)
async def login(request: LoginRequest) -> AuthResponse:
    """
    Login via signaling server proxy.

    This endpoint:
    1. Forwards credentials to signaling server
    2. Receives JWT token
    3. Generates local device_id
    4. Registers device with signaling server
    5. Stores auth state in SQLite
    6. Triggers TunnelAgent start (via TunnelManager in lifespan)

    Args:
        request: Login credentials and signaling server URL

    Returns:
        Login response with device_id and tunnel status

    Raises:
        HTTPException: 401 if credentials invalid, 503 if signaling server unavailable
    """
    signaling_url = request.signaling_url.rstrip("/")

    try:
        # Step 1: Authenticate with signaling server
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{signaling_url}/auth/login",
                json={"email": request.email, "password": request.password},
            ) as resp:
                if resp.status == 401:
                    raise HTTPException(
                        status_code=status.HTTP_401_UNAUTHORIZED,
                        detail="Incorrect email or password",
                    )
                elif resp.status != 200:
                    error_text = await resp.text()
                    logger.error(f"Signaling server auth failed: {error_text}")
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=f"Signaling server error: {error_text}",
                    )

                auth_data = await resp.json()
                jwt_token: str = auth_data["access_token"]

            # Step 2: Get or create persistent device_id for this local server
            device = get_device()
            if device is None:
                # First time login - create persistent device_id
                device_id = f"local-server-{uuid.uuid4().hex[:8]}"
                register_device(device_id=device_id, pubkey="placeholder-pubkey")
                logger.info(f"Created new device_id: {device_id}")
            else:
                # Reuse existing device_id
                device_id = device.id
                logger.info(f"Reusing existing device_id: {device_id}")

            # Step 3: Register device with signaling server
            async with session.post(
                f"{signaling_url}/devices/register",
                headers={"Authorization": f"Bearer {jwt_token}"},
                json={"device_id": device_id, "pubkey": "placeholder-pubkey"},
            ) as resp:
                if resp.status not in (200, 201):
                    error_text = await resp.text()
                    logger.error(f"Device registration failed: {error_text}")
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=f"Device registration failed: {error_text}",
                    )

        # Step 4: Store auth state in SQLite
        auth_state = AuthState(
            email=request.email,
            jwt_token=jwt_token,
            device_id=device_id,
            signaling_url=signaling_url,
        )
        set_auth_state(auth_state)

        logger.info(f"User {request.email} logged in, device_id={device_id}")

        # Step 5: Start TunnelAgent via TunnelManager
        if _tunnel_manager:
            try:
                await _tunnel_manager.start()
                tunnel_status = "connecting"
            except Exception as e:
                logger.error(f"Failed to start TunnelAgent: {e}")
                tunnel_status = "failed"
        else:
            logger.warning("TunnelManager not initialized")
            tunnel_status = "offline"

        return AuthResponse(
            status="ok",
            device_id=device_id,
            tunnel_status=tunnel_status,
        )

    except aiohttp.ClientError as e:
        logger.error(f"Failed to connect to signaling server: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Cannot connect to signaling server at {signaling_url}",
        ) from e


@router.post("/logout", response_model=LogoutResponse)
async def logout() -> LogoutResponse:
    """
    Logout and clear stored credentials.

    This endpoint:
    1. Deletes auth state from SQLite
    2. Triggers TunnelAgent stop (via TunnelManager)

    Returns:
        Logout response with tunnel status
    """
    # Stop TunnelAgent via TunnelManager
    if _tunnel_manager:
        try:
            await _tunnel_manager.stop()
        except Exception as e:
            logger.error(f"Error stopping TunnelAgent: {e}")

    # Delete auth state
    delete_auth_state()

    logger.info("User logged out, auth state cleared")

    return LogoutResponse(
        status="ok",
        tunnel_status="offline",
    )


@router.get("/status", response_model=AuthStatusResponse)
async def get_status() -> AuthStatusResponse:
    """
    Get current authentication status.

    Returns:
        Auth status with email, device_id, and tunnel status
    """
    auth_state = get_auth_state()

    if auth_state is None:
        return AuthStatusResponse(
            authenticated=False,
            tunnel_status="offline",
        )

    # Get tunnel status from TunnelManager
    if _tunnel_manager:
        status_dict = _tunnel_manager.get_status()
        tunnel_status = status_dict.get("mode", "offline")
    else:
        tunnel_status = "offline"

    return AuthStatusResponse(
        authenticated=True,
        email=auth_state.email,
        device_id=auth_state.device_id,
        tunnel_status=tunnel_status,
    )
