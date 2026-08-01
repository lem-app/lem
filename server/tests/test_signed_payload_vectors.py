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

The signaling server owns the format; this client must reproduce it exactly.
The pinned signature below was produced by the signaling server's own code, not
by this module, so a drift in either direction fails loudly here rather than
silently on the wire.

The constants below are duplicated verbatim in:

* ``cloud/signaling/tests/test_signed_payload_vectors.py``
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

from app.crypto import (
    REGISTER_CONTEXT,
    ROTATE_CONTEXT,
    SIGNAL_CONTEXT,
    load_keypair_from_b64,
    sign_challenge,
    signed_message,
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


def test_vector_seed_derives_the_expected_public_key() -> None:
    """The pinned public key really is the one behind the pinned seed."""
    keypair = load_keypair_from_b64(VECTOR_SEED_B64)
    raw = keypair.public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    assert base64.b64encode(raw).decode("ascii") == VECTOR_PUBKEY_B64
    assert keypair.public_key_b64 == VECTOR_PUBKEY_B64


def test_registration_payload_matches_the_golden_bytes() -> None:
    """The registration payload is byte-for-byte what other languages build."""
    payload = signed_message(REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE)
    assert payload.hex() == VECTOR_REGISTER_PAYLOAD_HEX


def test_rotation_payload_matches_the_golden_bytes() -> None:
    """The rotation payload binds the replacement key, in a pinned layout."""
    payload = signed_message(ROTATE_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE, VECTOR_PUBKEY_B64)
    assert payload.hex() == VECTOR_ROTATE_PAYLOAD_HEX


def test_sign_challenge_matches_the_golden_signature() -> None:
    """The signing helper the local server uses produces the pinned signature."""
    signature = sign_challenge(
        VECTOR_SEED_B64, REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE
    )
    assert signature == VECTOR_REGISTER_SIGNATURE_B64


def test_signal_context_produces_a_different_signature() -> None:
    """Domain separation is real, not just a constant nobody reads."""
    register = sign_challenge(VECTOR_SEED_B64, REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE)
    signal = sign_challenge(VECTOR_SEED_B64, SIGNAL_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE)
    assert register != signal


def test_context_constants_are_pinned() -> None:
    """The domain separation strings are protocol, not implementation detail."""
    assert REGISTER_CONTEXT == b"lem-device-register-v1"
    assert SIGNAL_CONTEXT == b"lem-signaling-connect-v1"
    assert ROTATE_CONTEXT == b"lem-device-rotate-v1"
