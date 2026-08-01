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

"""Ed25519 proof-of-possession for device identities.

The signaling server stores one ed25519 public key per device. Before this
module existed the key was decorative: it was stored and never used, so
"device authentication" was really just the account JWT. A stolen or forged
token was therefore enough to impersonate any device.

Two places now require the device to prove it holds the matching private key:

* ``POST /devices/register`` — binds a public key to a device id.
* The ``/signal`` WebSocket handshake — binds a live connection to a device.

Both use the same shape: the server issues a random challenge, the client
signs a domain-separated message over it, and the server verifies the
signature against the public key. Challenges are single use and expire.

Signed payload layout
---------------------
This module defines the wire format. Two client implementations must reproduce
these bytes exactly: ``server/app/crypto.py`` and
``web/remote/src/api/device-key.ts``. Anything encoded differently by Python
and JavaScript is a trap - ``json.dumps`` and ``JSON.stringify`` do not agree
at their defaults - so the payload is a plain concatenation with no encoder in
the loop::

    context ":" field_0 ":" field_1 [":" field_2 ...]

with every field UTF-8 encoded. For registration and signaling connect the
fields are ``(device_id, challenge)``; a key rotation proof appends the
replacement public key.

Why this stays unambiguous: every field after ``device_id`` is base64 of a
fixed 32 bytes - 44 characters, and base64 contains no ``:``. Two different
field splits would have to be the same length overall, which forces the
device ids to be the same length, which forces them to be equal. The
separator is therefore load-bearing only in combination with those fixed
lengths, so **do not add a variable-length trailing field** without switching
to explicit length prefixes.

``tests/test_signed_payload_vectors.py`` pins the exact bytes, and the two
client suites assert the same vector.
"""

import base64
import secrets
import time
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

# Domain separation. A signature produced for one purpose must never verify
# for another, so the purpose string is part of the signed message.
REGISTER_CONTEXT = b"lem-device-register-v1"
SIGNAL_CONTEXT = b"lem-signaling-connect-v1"
# Signed by the key a device is rotating *away from*, authorizing one specific
# replacement key. Distinct from REGISTER_CONTEXT so a captured registration
# proof can never be presented as authorization to replace a key.
ROTATE_CONTEXT = b"lem-device-rotate-v1"

# Raw ed25519 key and signature sizes.
_PUBLIC_KEY_BYTES = 32
_SIGNATURE_BYTES = 64

# Bytes of entropy in an issued challenge.
_CHALLENGE_BYTES = 32


class InvalidPublicKeyError(ValueError):
    """Raised when a supplied public key is not a valid ed25519 key."""


def decode_public_key(pubkey_b64: str) -> Ed25519PublicKey:
    """Decode a base64-encoded raw ed25519 public key.

    Args:
        pubkey_b64: Base64 encoding of the 32 raw public key bytes.

    Returns:
        The decoded public key.

    Raises:
        InvalidPublicKeyError: If the value is not a valid ed25519 public key.
    """
    try:
        raw = base64.b64decode(pubkey_b64, validate=True)
    except (ValueError, TypeError) as exc:
        raise InvalidPublicKeyError("Public key is not valid base64") from exc

    if len(raw) != _PUBLIC_KEY_BYTES:
        raise InvalidPublicKeyError(
            f"Public key must be {_PUBLIC_KEY_BYTES} raw bytes, got {len(raw)}"
        )

    try:
        return Ed25519PublicKey.from_public_bytes(raw)
    except ValueError as exc:
        raise InvalidPublicKeyError("Public key is not a valid ed25519 key") from exc


def signed_message(context: bytes, *fields: str) -> bytes:
    """Build the exact byte string a client must sign.

    See the module docstring for the layout. For the two-field cases this is
    byte-identical to the original fixed-arity implementation, so the wire
    format is unchanged; the extra fields exist for the rotation proof.

    Args:
        context: Domain separation constant (REGISTER_CONTEXT, SIGNAL_CONTEXT
            or ROTATE_CONTEXT).
        *fields: Ordered payload fields, encoded as UTF-8. For registration and
            signaling connect these are ``(device_id, challenge)``; for a key
            rotation proof they are ``(device_id, challenge, new_pubkey)``.

    Returns:
        The message bytes to sign or verify.
    """
    return b":".join((context, *(field.encode("utf-8") for field in fields)))


def verify_signature(pubkey_b64: str, signature_b64: str, message: bytes) -> bool:
    """Verify an ed25519 signature over a signed-payload message.

    Args:
        pubkey_b64: Base64-encoded raw ed25519 public key.
        signature_b64: Base64-encoded 64-byte signature.
        message: Message bytes, as built by :func:`signed_message`.

    Returns:
        True if the signature is valid for this key and message. False for any
        malformed input, so callers never have to distinguish "bad signature"
        from "unparseable signature" - both are refusals.
    """
    try:
        public_key = decode_public_key(pubkey_b64)
    except InvalidPublicKeyError:
        return False

    try:
        signature = base64.b64decode(signature_b64, validate=True)
    except (ValueError, TypeError):
        return False

    if len(signature) != _SIGNATURE_BYTES:
        return False

    try:
        public_key.verify(signature, message)
    except InvalidSignature:
        return False
    return True


def new_challenge() -> str:
    """Mint a fresh random challenge.

    Returns:
        Base64-encoded challenge bytes.
    """
    return base64.b64encode(secrets.token_bytes(_CHALLENGE_BYTES)).decode("ascii")


@dataclass(frozen=True)
class _PendingChallenge:
    """A challenge that has been issued but not yet redeemed."""

    challenge: str
    expires_at: float


class ChallengeStore:
    """Single-use, expiring challenges keyed by purpose and subject.

    State is per process. That is correct only while the servers run with a
    single worker (see deploy/), which is enforced for the same reason the
    connection registry is: there is no shared store yet.
    """

    def __init__(self, ttl_seconds: int) -> None:
        """Initialize the store.

        Args:
            ttl_seconds: How long an issued challenge stays redeemable.
        """
        self._ttl = ttl_seconds
        self._pending: dict[str, _PendingChallenge] = {}

    def issue(self, key: str) -> str:
        """Issue a fresh challenge for a subject, replacing any previous one.

        Args:
            key: Opaque subject key, e.g. "register:42:device-abc".

        Returns:
            The base64-encoded challenge to send to the client.
        """
        self._purge_expired()
        challenge = new_challenge()
        self._pending[key] = _PendingChallenge(
            challenge=challenge, expires_at=time.monotonic() + self._ttl
        )
        return challenge

    def redeem(self, key: str, challenge: str) -> bool:
        """Consume a challenge, returning whether it was valid.

        A challenge can only be redeemed once, so a captured signature cannot
        be replayed.

        Args:
            key: The same subject key the challenge was issued for.
            challenge: The challenge string presented by the client.

        Returns:
            True if the challenge was outstanding, unexpired and matching.
        """
        self._purge_expired()
        pending = self._pending.pop(key, None)
        if pending is None:
            return False
        if pending.expires_at < time.monotonic():
            return False
        # Constant-time compare: the challenge is server-issued randomness, so
        # this is belt and braces, but comparison of secrets should not leak.
        return secrets.compare_digest(pending.challenge, challenge)

    def clear(self) -> None:
        """Forget every outstanding challenge. Used by tests."""
        self._pending.clear()

    def _purge_expired(self) -> None:
        """Drop challenges that are past their expiry, bounding memory use."""
        now = time.monotonic()
        expired = [key for key, pending in self._pending.items() if pending.expires_at < now]
        for key in expired:
            del self._pending[key]
