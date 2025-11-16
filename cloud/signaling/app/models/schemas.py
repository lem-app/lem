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

"""Pydantic models for API requests and responses."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field


class UserCreate(BaseModel):
    """User creation request."""

    email: EmailStr
    password: str = Field(min_length=8)


class UserLogin(BaseModel):
    """User login request."""

    email: EmailStr
    password: str


class Token(BaseModel):
    """JWT token response."""

    access_token: str
    token_type: str = "bearer"


class DeviceRegister(BaseModel):
    """Device registration request."""

    device_id: str
    pubkey: str


class DeviceResponse(BaseModel):
    """Device response."""

    id: str
    user_id: int
    pubkey: str
    created_at: datetime
    last_seen: datetime


class SignalingMessage(BaseModel):
    """WebRTC signaling message (SDP/ICE)."""

    type: str = Field(description="Message type: offer, answer, ice-candidate")
    target_device_id: str = Field(description="Target device ID")
    payload: dict[str, object] = Field(description="SDP or ICE candidate data")


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    timestamp: datetime


# Relay Coordination Messages


class ConnectRequest(BaseModel):
    """Connection request with transport preference."""

    type: Literal["connect-request"]
    target_device_id: str = Field(description="Target device ID")
    preferred_transport: Literal["webrtc", "relay", "auto"] = Field(
        default="auto", description="Preferred transport mode"
    )
    relay_session_id: str | None = Field(
        default=None, description="Relay session ID if using relay transport"
    )


class ConnectRequestReceived(BaseModel):
    """Notification sent to target device about connection request."""

    type: Literal["connect-request-received"]
    from_device_id: str = Field(description="Requesting device ID")
    preferred_transport: Literal["webrtc", "relay", "auto"] = Field(
        description="Preferred transport mode"
    )
    relay_session_id: str | None = Field(
        default=None, description="Relay session ID if using relay transport"
    )
    relay_url: str | None = Field(
        default=None, description="Relay server WebSocket URL"
    )


class ConnectAck(BaseModel):
    """Connection acknowledgment from target device."""

    type: Literal["connect-ack"]
    target_device_id: str = Field(description="Requesting device ID to ack")
    transport: Literal["webrtc", "relay"] = Field(
        description="Confirmed transport mode"
    )
    relay_session_id: str | None = Field(
        default=None, description="Relay session ID if using relay"
    )
    status: Literal["connecting", "connected", "failed"] = Field(
        description="Connection status"
    )


class ConnectAckReceived(BaseModel):
    """Acknowledgment notification sent back to requesting device."""

    type: Literal["connect-ack-received"]
    from_device_id: str = Field(description="Target device ID that acknowledged")
    transport: Literal["webrtc", "relay"] = Field(description="Confirmed transport mode")
    relay_session_id: str | None = Field(
        default=None, description="Relay session ID if using relay"
    )
    status: Literal["connecting", "connected", "failed"] = Field(
        description="Connection status"
    )
