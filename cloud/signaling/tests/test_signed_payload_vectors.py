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

"""Cross-language golden vectors for the ed25519 signed payload.

Three implementations must produce byte-identical payloads:

* ``cloud/signaling/app/core/crypto.py`` (this one)
* ``server/app/crypto.py``
* ``web/remote/src/api/device-key.ts``

This module defines the format; the other two must reproduce it. Each suite
asserts a literal signature produced elsewhere, never one it just computed, so
a drifting implementation cannot quietly agree with its own tests while failing
on the wire. The constants below are duplicated verbatim in:

* ``server/tests/test_signed_payload_vectors.py``
* ``web/remote/src/api/device-key.test.ts``

The device id deliberately contains a non-ASCII character and an astral-plane
emoji. JavaScript strings are UTF-16 and Python's are code points; only the
UTF-8 encoding of a surrogate pair pins the two together, and that is exactly
where a cross-language signing bug hides - it verifies in each language's own
tests and fails across the wire.

Ed25519 is deterministic (RFC 8032), so a fixed key over a fixed payload has
exactly one correct signature. Pinning it catches divergence in the payload
*and* in the signing call.
"""

import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.core.crypto import (
    REGISTER_CONTEXT,
    ROTATE_CONTEXT,
    SIGNAL_CONTEXT,
    signed_message,
    verify_signature,
)

# --- Shared vector inputs (keep identical across all three suites) -----------

VECTOR_DEVICE_ID = "device-café-\U0001f511"
VECTOR_CHALLENGE = "Q0hBTExFTkdFLTAxMjM0NTY3ODlhYmNkZWZnaGlqa2w="

# Test-only key: the 32-byte seed 0x00..0x1f. Never use this anywhere real.
VECTOR_SEED_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
VECTOR_PUBKEY_B64 = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="

# --- Expected outputs -------------------------------------------------------

VECTOR_REGISTER_PAYLOAD_HEX = (
    "6c656d2d6465766963652d72656769737465722d7631"
    "3a"
    "6465766963652d636166c3a92df09f9491"
    "3a"
    "5130684254457846546b64464c5441784d6a4d304e5459334f446c68596d4e6b5a575a6e61476c716132773d"
)

VECTOR_REGISTER_SIGNATURE_B64 = (
    "Lzv8ombVVJZLmnvIdQ1LcGJJfaljNrukmUjQDfzDewGnbhqwTHDI2MYOHMUypxG8CC1tv+uzulnLja17u4bRAA=="
)

VECTOR_ROTATE_PAYLOAD_HEX = (
    "6c656d2d6465766963652d726f746174652d7631"
    "3a"
    "6465766963652d636166c3a92df09f9491"
    "3a"
    "5130684254457846546b64464c5441784d6a4d304e5459334f446c68596d4e6b5a575a6e61476c716132773d"
    "3a"
    "41364548762f504f454c3464634e3059353076416d57666b316a436270513166486479475a424a564d62673d"
)


def vector_private_key() -> Ed25519PrivateKey:
    """Load the fixed test key behind the golden vectors.

    Returns:
        The ed25519 private key for VECTOR_SEED_B64.
    """
    return Ed25519PrivateKey.from_private_bytes(base64.b64decode(VECTOR_SEED_B64))


def test_vector_seed_derives_the_expected_public_key() -> None:
    """The pinned public key really is the one behind the pinned seed."""
    raw = (
        vector_private_key()
        .public_key()
        .public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
    )
    assert base64.b64encode(raw).decode("ascii") == VECTOR_PUBKEY_B64


def test_registration_payload_matches_the_golden_bytes() -> None:
    """The registration payload is byte-for-byte what other languages build."""
    payload = signed_message(REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE)
    assert payload.hex() == VECTOR_REGISTER_PAYLOAD_HEX


def test_rotation_payload_matches_the_golden_bytes() -> None:
    """The rotation payload binds the replacement key, in a pinned layout."""
    payload = signed_message(ROTATE_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE, VECTOR_PUBKEY_B64)
    assert payload.hex() == VECTOR_ROTATE_PAYLOAD_HEX


def test_registration_signature_matches_the_golden_signature() -> None:
    """Ed25519 is deterministic, so the signature is a fixed value too."""
    payload = signed_message(REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE)
    signature = base64.b64encode(vector_private_key().sign(payload)).decode("ascii")
    assert signature == VECTOR_REGISTER_SIGNATURE_B64


def test_golden_signature_verifies_through_the_public_api() -> None:
    """A signature produced elsewhere and pasted in still verifies here.

    This is the check that would fail if another language's payload drifted:
    the signature is a literal, not something this module just produced.
    """
    assert verify_signature(
        VECTOR_PUBKEY_B64,
        VECTOR_REGISTER_SIGNATURE_B64,
        signed_message(REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE),
    )
    # And it is bound to its context: the same bytes under SIGNAL fail.
    assert not verify_signature(
        VECTOR_PUBKEY_B64,
        VECTOR_REGISTER_SIGNATURE_B64,
        signed_message(SIGNAL_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE),
    )


def test_variadic_form_is_byte_identical_to_the_shipped_format() -> None:
    """Making signed_message variadic must not have changed the wire format.

    The rotation proof needed a third field, so the function became variadic.
    This reproduces the original fixed-arity expression literally: if the two
    ever diverge, every already-working client breaks.
    """
    original = b":".join(
        (REGISTER_CONTEXT, VECTOR_DEVICE_ID.encode("utf-8"), VECTOR_CHALLENGE.encode("ascii"))
    )
    assert signed_message(REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE) == original
    assert signed_message(SIGNAL_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE) == b":".join(
        (SIGNAL_CONTEXT, VECTOR_DEVICE_ID.encode("utf-8"), VECTOR_CHALLENGE.encode("ascii"))
    )


def test_context_constants_are_pinned() -> None:
    """The domain separation strings are protocol, not implementation detail."""
    assert REGISTER_CONTEXT == b"lem-device-register-v1"
    assert SIGNAL_CONTEXT == b"lem-signaling-connect-v1"
    assert ROTATE_CONTEXT == b"lem-device-rotate-v1"
