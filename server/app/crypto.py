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
Cryptographic utilities for device identity.

Generates and manages Ed25519 keypairs for device authentication, and signs
the challenges the signaling server issues to prove this machine holds the
private key behind its registered public key.

Signed payload layout
---------------------
The signaling server owns this format; ``cloud/signaling/app/core/crypto.py``
is the definition and this must reproduce it exactly::

    context ":" field_0 ":" field_1 [":" field_2 ...]

with every field UTF-8 encoded. For registration and signaling connect the
fields are ``(device_id, challenge)``. Nothing is JSON-encoded: Python's
``json.dumps`` and JavaScript's ``JSON.stringify`` do not agree at their
defaults, and a signature over a differently-encoded payload fails only on the
wire, never in either language's own tests.

``server/tests/test_signed_payload_vectors.py`` pins the exact bytes against
the same vector the signaling and browser suites use.
"""

import base64
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)

# Domain separation. A signature produced for one purpose must never verify
# for another, so the purpose string is part of the signed message.
REGISTER_CONTEXT = b"lem-device-register-v1"
SIGNAL_CONTEXT = b"lem-signaling-connect-v1"
ROTATE_CONTEXT = b"lem-device-rotate-v1"


@dataclass
class DeviceKeypair:
    """Ed25519 keypair for device identity."""

    private_key: Ed25519PrivateKey
    public_key: Ed25519PublicKey

    @property
    def private_key_bytes(self) -> bytes:
        """Get raw private key bytes (32 bytes)."""
        return self.private_key.private_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PrivateFormat.Raw,
            encryption_algorithm=serialization.NoEncryption(),
        )

    @property
    def public_key_bytes(self) -> bytes:
        """Get raw public key bytes (32 bytes)."""
        return self.public_key.public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )

    @property
    def private_key_b64(self) -> str:
        """Get base64-encoded private key."""
        return base64.b64encode(self.private_key_bytes).decode("ascii")

    @property
    def public_key_b64(self) -> str:
        """Get base64-encoded public key."""
        return base64.b64encode(self.public_key_bytes).decode("ascii")


def signed_message(context: bytes, *fields: str) -> bytes:
    """Build the exact byte string to sign for a proof of possession.

    See the module docstring for the layout.

    Args:
        context: Domain separation constant (REGISTER_CONTEXT, SIGNAL_CONTEXT
            or ROTATE_CONTEXT).
        *fields: Ordered payload fields, encoded as UTF-8. For registration and
            signaling connect these are ``(device_id, challenge)``.

    Returns:
        The message bytes to sign.
    """
    return b":".join((context, *(field.encode("utf-8") for field in fields)))


def sign_challenge(private_key_b64: str, context: bytes, device_id: str, challenge: str) -> str:
    """Answer a server challenge with this device's private key.

    Args:
        private_key_b64: Base64-encoded 32-byte Ed25519 private key.
        context: Domain separation constant for the purpose being proved.
        device_id: This device's identifier, as registered.
        challenge: Challenge string exactly as issued by the server.

    Returns:
        Base64-encoded 64-byte signature.

    Raises:
        ValueError: If the private key is invalid.
    """
    keypair = load_keypair_from_b64(private_key_b64)
    signature = keypair.private_key.sign(signed_message(context, device_id, challenge))
    return base64.b64encode(signature).decode("ascii")


def generate_keypair() -> DeviceKeypair:
    """Generate a new Ed25519 keypair for device identity.

    Returns:
        DeviceKeypair containing the private and public keys.
    """
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    return DeviceKeypair(private_key=private_key, public_key=public_key)


def load_keypair_from_b64(private_key_b64: str) -> DeviceKeypair:
    """Load a keypair from a base64-encoded private key.

    Args:
        private_key_b64: Base64-encoded 32-byte Ed25519 private key.

    Returns:
        DeviceKeypair containing the private and derived public keys.

    Raises:
        ValueError: If the private key is invalid.
    """
    try:
        private_bytes = base64.b64decode(private_key_b64)
        if len(private_bytes) != 32:
            raise ValueError(f"Invalid private key length: {len(private_bytes)}")

        private_key = Ed25519PrivateKey.from_private_bytes(private_bytes)
        public_key = private_key.public_key()
        return DeviceKeypair(private_key=private_key, public_key=public_key)
    except Exception as e:
        raise ValueError(f"Invalid private key: {e}") from e


def public_key_from_b64(public_key_b64: str) -> Ed25519PublicKey:
    """Load a public key from base64.

    Args:
        public_key_b64: Base64-encoded 32-byte Ed25519 public key.

    Returns:
        Ed25519PublicKey instance.

    Raises:
        ValueError: If the public key is invalid.
    """
    try:
        public_bytes = base64.b64decode(public_key_b64)
        if len(public_bytes) != 32:
            raise ValueError(f"Invalid public key length: {len(public_bytes)}")

        return Ed25519PublicKey.from_public_bytes(public_bytes)
    except Exception as e:
        raise ValueError(f"Invalid public key: {e}") from e
