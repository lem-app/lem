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

"""Authorization gate for tunnel peers.

The tunnel's HTTP proxy presents the local server's *own* credentials to the
local API, so whoever gets a DataChannel open gets authenticated Docker
control. That is only sound if the peer on the other end has been established
as one of this account's devices first. Nothing did that: an ``offer`` from any
``sender_device_id`` was answered, and neither the signaling server nor the
relay server scopes a session to a single account.

This module is the gate. Peers are denied unless a verifier positively
authorizes them.

Verification backends
---------------------
:class:`PeerVerifier` is the seam. Today :class:`RegisteredDeviceVerifier`
answers "is this device registered to my account?" by asking the signaling
server, which is only as strong as the signaling server's own word.

The endgame is Ed25519 proof-of-possession: the peer signs a fresh challenge
with the private key behind the public key registered for its device. This
module is shaped to take that verifier - :func:`build_peer_verifier` is the
single seam, :attr:`PeerIdentity.proof` carries a signaling-layer proof payload
through untouched, and any verifier returns the same :class:`PeerDecision`, so
no call site in ``webrtc_client``/``relay_client`` changes.

Be precise about how much of that is already available, though:

* A *stronger registration check* is close at hand. ``GET /devices/`` already
  returns each device's ``pubkey``, so a verifier could require the peer's
  pubkey to match the registered one as well as its id.
* An actual ``SignedChallengeVerifier`` is **not** close at hand, and no open
  work delivers it. ``fix/cloud-authz`` hardens each device's *own* link to the
  signaling server (it must prove key possession to connect and to register)
  and scopes routing server-side. Neither gives *this* process a way to check a
  peer's identity without taking the signaling server's word for it. A real
  peer-to-peer challenge needs a challenge issued to an as-yet-unconnected
  peer, a wire format for the response, and somewhere to attach it before a
  DataChannel exists. That protocol does not exist yet, and designing it spans
  ``server/``, ``cloud/signaling/`` and ``web/remote/``.
* ``app.crypto.public_key_from_b64`` is the verification primitive it would
  need. It has no call sites today.

Escape hatch
------------
``LEM_TUNNEL_ALLOW_UNVERIFIED_PEERS=1`` restores the old permissive behavior
for anyone who knowingly wants it. It is off by default and logs loudly.
"""

import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Protocol

import aiohttp

from app.db import AuthState, get_auth_state

logger = logging.getLogger(__name__)

# Opt back in to the pre-gate behavior: trust every peer. Default off.
ALLOW_UNVERIFIED_ENV_VAR = "LEM_TUNNEL_ALLOW_UNVERIFIED_PEERS"

# Label recorded as the "authorized peer" when the escape hatch is on, so logs
# never suggest a real device was verified.
UNVERIFIED_PEER_LABEL = "<unverified-peer>"

# How long a device list from the signaling server stays usable *for denials*.
# It is never used to authorize - see RegisteredDeviceVerifier.verify.
DEVICE_CACHE_TTL_SECONDS = 30.0

# Cap on how long the signaling lookup may block the offer path.
DEVICE_LOOKUP_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class PeerIdentity:
    """Everything the signaling layer told us about the peer.

    Attributes:
        device_id: Device ID the signaling server attributed to the sender
        proof: Opaque proof payload carried on the signaling message, reserved
            for the Ed25519 challenge/response backend
    """

    device_id: str
    proof: dict[str, Any] | None = None


@dataclass(frozen=True)
class PeerDecision:
    """Outcome of a peer authorization check.

    Attributes:
        authorized: Whether the peer may use the tunnel
        reason: Human-readable justification, for the server log
    """

    authorized: bool
    reason: str


class PeerVerifier(Protocol):
    """Decides whether a tunnel peer may be granted local-API access."""

    async def verify(self, peer: PeerIdentity) -> PeerDecision:
        """Authorize or deny a peer.

        Args:
            peer: Identity claimed for the peer by the signaling layer

        Returns:
            The decision, denied by default
        """
        ...


class RegisteredDeviceVerifier:
    """Allow only devices registered to this machine's Lem account.

    The signaling server authenticates each device with a JWT before it stamps
    ``sender_device_id`` on a relayed message, but it will relay between
    *different* accounts. This asks the signaling server for the device list
    belonging to the account this machine is logged in as, and requires the
    peer to be on it.
    """

    def __init__(self, cache_ttl: float = DEVICE_CACHE_TTL_SECONDS) -> None:
        """
        Args:
            cache_ttl: Seconds a fetched device list stays usable for denials
        """
        self.cache_ttl = cache_ttl
        self._cached_ids: frozenset[str] = frozenset()
        self._cached_key: tuple[str, str] | None = None
        self._cached_at: float = 0.0

    async def verify(self, peer: PeerIdentity) -> PeerDecision:
        """Check the peer against the account's registered devices.

        The cached device list is consulted only to *deny*. A peer that the
        cache would authorize is always re-checked against the registry, so a
        device deregistered a moment ago cannot be waved through on stale data
        for the rest of the cache TTL. Denying on a slightly stale list is
        safe - the worst case is that a just-registered device waits out the
        TTL - while authorizing on one is not.

        Args:
            peer: Identity claimed for the peer

        Returns:
            Authorized only when the device is registered to this account
        """
        if not peer.device_id:
            return PeerDecision(False, "the signaling message carried no sender_device_id")

        auth_state = get_auth_state()
        if auth_state is None:
            return PeerDecision(False, "this machine is not logged in to a Lem account")

        cached = self._cached_device_ids(auth_state)
        if cached is not None and peer.device_id not in cached:
            return PeerDecision(False, "device is not registered to this account")

        try:
            known = await self._registered_device_ids(auth_state)
        except (aiohttp.ClientError, TimeoutError, ValueError) as e:
            # Fail closed: an unreachable device registry is not permission.
            return PeerDecision(False, f"could not load this account's devices: {e}")

        if peer.device_id in known:
            return PeerDecision(True, "device is registered to this account")
        return PeerDecision(False, "device is not registered to this account")

    def _cached_device_ids(self, auth_state: AuthState) -> frozenset[str] | None:
        """Return the cached device list for this account, if still fresh.

        Args:
            auth_state: Stored account credentials

        Returns:
            The cached device IDs, or None when there is no usable cache entry
        """
        key = (auth_state.signaling_url, auth_state.device_id)
        if self._cached_key == key and time.monotonic() - self._cached_at < self.cache_ttl:
            return self._cached_ids
        return None

    async def _registered_device_ids(self, auth_state: AuthState) -> frozenset[str]:
        """Fetch the device IDs registered to this account from signaling.

        Args:
            auth_state: Stored account credentials

        Returns:
            Device IDs belonging to this account

        Raises:
            aiohttp.ClientError: If the signaling server cannot be reached
            TimeoutError: If the lookup takes too long
            ValueError: If the signaling server answers with an error or junk
        """
        url = f"{auth_state.signaling_url.rstrip('/')}/devices/"
        timeout = aiohttp.ClientTimeout(total=DEVICE_LOOKUP_TIMEOUT_SECONDS)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                url, headers={"Authorization": f"Bearer {auth_state.jwt_token}"}
            ) as response:
                if response.status != 200:
                    raise ValueError(f"signaling server returned HTTP {response.status}")
                payload = await response.json()

        if not isinstance(payload, list):
            raise ValueError("signaling server returned a malformed device list")

        ids = {
            str(entry["id"])
            for entry in payload
            if isinstance(entry, dict) and entry.get("id") is not None
        }
        # This machine's own device is always part of its account.
        ids.add(auth_state.device_id)

        self._cached_ids = frozenset(ids)
        self._cached_key = (auth_state.signaling_url, auth_state.device_id)
        self._cached_at = time.monotonic()
        logger.info(f"Loaded {len(self._cached_ids)} registered device(s) for peer authorization")
        return self._cached_ids


class AllowAllVerifier:
    """The escape hatch: authorize every peer, loudly.

    Only reachable when the operator sets ``LEM_TUNNEL_ALLOW_UNVERIFIED_PEERS``.
    """

    async def verify(self, peer: PeerIdentity) -> PeerDecision:
        """Authorize unconditionally.

        Args:
            peer: Identity claimed for the peer

        Returns:
            Always authorized
        """
        logger.warning(
            f"⚠ Granting local-API access to UNVERIFIED peer {peer.device_id!r}: "
            f"{ALLOW_UNVERIFIED_ENV_VAR} is set"
        )
        return PeerDecision(True, f"peer verification disabled by {ALLOW_UNVERIFIED_ENV_VAR}")


def unverified_peers_allowed() -> bool:
    """
    Whether the operator opted out of peer verification.

    Returns:
        True only when $LEM_TUNNEL_ALLOW_UNVERIFIED_PEERS is a truthy value
    """
    value = os.environ.get(ALLOW_UNVERIFIED_ENV_VAR, "").strip().lower()
    return value in ("1", "true", "yes", "on")


def build_peer_verifier() -> PeerVerifier:
    """
    Build the verifier the tunnel should gate peers with.

    This is the single wiring seam: the cloud-authz Ed25519 backend replaces or
    chains onto the verifier returned here.

    Returns:
        A verifier; registration-checking unless the escape hatch is set
    """
    if unverified_peers_allowed():
        logger.warning(
            f"⚠ {ALLOW_UNVERIFIED_ENV_VAR} is set: ANY peer that reaches this device over "
            f"the tunnel will be handed the local API's credentials, which control Docker. "
            f"Unset it to restore peer verification."
        )
        return AllowAllVerifier()
    return RegisteredDeviceVerifier()
