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
from typing import Literal, Self

from pydantic import BaseModel, EmailStr, Field, model_validator

from ..core.security import BCRYPT_MAX_PASSWORD_BYTES


class UserCreate(BaseModel):
    """User creation request."""

    email: EmailStr
    # bcrypt hashes only the first 72 bytes of its input. Bound the field so
    # two different long passwords can never collide into the same hash.
    password: str = Field(min_length=8, max_length=BCRYPT_MAX_PASSWORD_BYTES)

    @model_validator(mode="after")
    def validate_password_bytes(self) -> Self:
        """Reject passwords longer than bcrypt's input limit once encoded.

        Returns:
            The validated model.

        Raises:
            ValueError: If the UTF-8 encoding exceeds bcrypt's limit.
        """
        # max_length counts characters; bcrypt counts bytes. Non-ASCII
        # passwords can pass the field constraint and still be too long.
        if len(self.password.encode("utf-8")) > BCRYPT_MAX_PASSWORD_BYTES:
            raise ValueError(
                f"Password must be at most {BCRYPT_MAX_PASSWORD_BYTES} bytes when UTF-8 encoded"
            )
        return self


class UserLogin(BaseModel):
    """User login request."""

    email: EmailStr
    password: str


class Token(BaseModel):
    """JWT token response."""

    access_token: str
    token_type: str = "bearer"


class DeviceChallengeRequest(BaseModel):
    """Request for a device registration challenge."""

    device_id: str = Field(min_length=1, max_length=128)


class DeviceChallengeResponse(BaseModel):
    """Challenge a device must sign to prove it holds its private key."""

    device_id: str
    challenge: str = Field(description="Base64 challenge bytes to sign")
    context: str = Field(description="Domain separation prefix for the signed message")
    expires_in: int = Field(description="Seconds until the challenge stops being redeemable")


class DeviceRegister(BaseModel):
    """Device registration request.

    ``challenge`` and ``signature`` prove possession of the private key that
    matches ``pubkey``. Without them the stored key would be decorative and
    device identity would rest entirely on the account token.
    """

    device_id: str = Field(min_length=1, max_length=128)
    pubkey: str = Field(description="Base64-encoded raw ed25519 public key (32 bytes)")
    challenge: str = Field(description="Challenge issued by POST /devices/challenge")
    signature: str = Field(description="Base64-encoded ed25519 signature over the challenge")
    previous_signature: str | None = Field(
        default=None,
        description=(
            "Required only when replacing the key already registered for this "
            "device: an ed25519 signature by the key on file, over the "
            "rotation payload, authorizing this specific new pubkey."
        ),
    )


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
    """Connection request with transport preference.

    Note that there is no ``relay_session_id`` field. Session ids are minted by
    the server; a client-chosen id let anyone name (and therefore join) a
    session belonging to someone else.
    """

    type: Literal["connect-request"]
    target_device_id: str = Field(description="Target device ID, must be owned by the sender")
    preferred_transport: Literal["webrtc", "relay", "auto"] = Field(
        default="auto", description="Preferred transport mode"
    )


class ConnectRequestSent(BaseModel):
    """Confirmation to the requester, carrying its own relay session grant."""

    type: Literal["connect-request-sent"]
    target_device_id: str = Field(description="Device the request was delivered to")
    relay_session_id: str = Field(description="Server-minted relay session ID")
    relay_url: str | None = Field(default=None, description="Relay server WebSocket URL")
    relay_token: str = Field(description="Single-use grant authorizing this device to join")
    relay_token_expires_in: int = Field(description="Grant lifetime in seconds")


class ConnectRequestReceived(BaseModel):
    """Notification sent to target device about connection request."""

    type: Literal["connect-request-received"]
    from_device_id: str = Field(description="Requesting device ID")
    preferred_transport: Literal["webrtc", "relay", "auto"] = Field(
        description="Preferred transport mode"
    )
    relay_session_id: str = Field(description="Server-minted relay session ID")
    relay_url: str | None = Field(default=None, description="Relay server WebSocket URL")
    relay_token: str = Field(description="Single-use grant authorizing this device to join")
    relay_token_expires_in: int = Field(description="Grant lifetime in seconds")


class ConnectAck(BaseModel):
    """Connection acknowledgment from target device."""

    type: Literal["connect-ack"]
    target_device_id: str = Field(description="Requesting device ID to ack")
    transport: Literal["webrtc", "relay"] = Field(description="Confirmed transport mode")
    relay_session_id: str | None = Field(
        default=None, description="Relay session ID if using relay"
    )
    status: Literal["connecting", "connected", "failed"] = Field(description="Connection status")


class ConnectAckReceived(BaseModel):
    """Acknowledgment notification sent back to requesting device."""

    type: Literal["connect-ack-received"]
    from_device_id: str = Field(description="Target device ID that acknowledged")
    transport: Literal["webrtc", "relay"] = Field(description="Confirmed transport mode")
    relay_session_id: str | None = Field(
        default=None, description="Relay session ID if using relay"
    )
    status: Literal["connecting", "connected", "failed"] = Field(description="Connection status")
