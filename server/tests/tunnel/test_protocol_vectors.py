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

"""Cross-language golden vectors for tunnel protocol v3.

``protocol/tunnel-v3.json`` is the contract. This suite and
``web/remote/src/lib/protocol-vectors.test.ts`` decode every vector in it and
re-encode it to the identical bytes, so the Python and TypeScript codecs cannot
drift apart. They already did once - FrameType diverged between them in v1 to
v2, and the test suite stayed red for months because each side was internally
consistent and wrong about the other.

The vector file also pins the frame-type numbers, the caps, and the error-code
table, which is the other half of the same problem.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from app.tunnel import http_frame as hf
from app.tunnel import ws_frame as wf
from app.tunnel.errors import HTTP_STATUS_FOR_ERROR, TunnelErrorCode

VECTOR_FILE = Path(__file__).resolve().parents[3] / "protocol" / "tunnel-v3.json"


def _load() -> dict[str, Any]:
    """Read the shared vector file.

    Returns:
        Parsed contract document
    """
    with VECTOR_FILE.open(encoding="utf-8") as handle:
        document: dict[str, Any] = json.load(handle)
    return document


CONTRACT = _load()
VECTORS: list[dict[str, Any]] = CONTRACT["vectors"]


def _pairs(raw: list[list[str]]) -> hf.HeaderList:
    """Convert the file's header arrays to the codec's pair list.

    Args:
        raw: Header pairs as JSON arrays

    Returns:
        Header pairs as tuples
    """
    return [(name, value) for name, value in raw]


def test_vector_file_exists_where_both_suites_look_for_it() -> None:
    """A missing fixture must fail loudly, not silently skip the contract."""
    assert VECTOR_FILE.is_file(), f"{VECTOR_FILE} is missing"
    assert VECTORS, "the contract carries no vectors"


def test_protocol_version_matches() -> None:
    """The advertised version is part of the contract."""
    assert CONTRACT["protocol_version"] == hf.PROTOCOL_VERSION


def test_frame_types_match() -> None:
    """Every frame type number is pinned by name.

    This is the exact assertion that would have caught the v1-to-v2 drift.
    """
    assert CONTRACT["frame_types"] == {member.name: int(member.value) for member in hf.FrameType}


def test_flag_bits_match() -> None:
    """Flag bits are pinned too; they are one-bit fields and easy to swap."""
    assert CONTRACT["flags"] == {
        "BODY_FOLLOWS": hf.FLAG_BODY_FOLLOWS,
        "FINAL": hf.FLAG_FINAL,
        "FIN": wf.FLAG_FIN,
    }


def test_limits_match() -> None:
    """Caps are part of the contract: a peer sizes its frames from them."""
    assert CONTRACT["limits"] == {
        "MAX_BODY_BYTES": hf.MAX_BODY_BYTES,
        "MAX_HEADERS_BYTES": hf.MAX_HEADERS_BYTES,
        "MAX_CHUNK_BYTES": hf.MAX_CHUNK_BYTES,
        "MAX_URL_BYTES": hf.MAX_URL_BYTES,
        "MAX_INFLIGHT_REQUESTS": hf.MAX_INFLIGHT_REQUESTS,
        "MAX_WS_MESSAGE_BYTES": wf.MAX_WS_MESSAGE_BYTES,
        "POST_CANCEL_DRAIN_BYTES": hf.POST_CANCEL_DRAIN_BYTES,
    }


def test_error_codes_match() -> None:
    """The error taxonomy is shared with the browser, so it is pinned."""
    assert CONTRACT["error_codes"] == {member.name: int(member.value) for member in TunnelErrorCode}
    assert CONTRACT["http_status_for_error"] == {
        code.name: status for code, status in HTTP_STATUS_FOR_ERROR.items()
    }


def test_cancel_reason_codes_fit_the_uint16_field() -> None:
    """reason_code is a uint16 on the wire; the table must fit it."""
    for code in TunnelErrorCode:
        assert 0 <= int(code) <= 0xFFFF


def _decode(vector: dict[str, Any]) -> Any:
    """Decode one vector with the codec under test.

    Args:
        vector: Vector entry from the contract

    Returns:
        The decoded frame
    """
    data = bytes.fromhex(vector["hex"])
    kind = vector["kind"]

    if kind == "hello":
        return hf.deserialize_hello(data)
    if kind == "request_head":
        return hf.deserialize_request_head(data)
    if kind == "response_head":
        return hf.deserialize_response_head(data)
    if kind == "chunk":
        return hf.deserialize_chunk(data)
    if kind == "cancel":
        return hf.deserialize_cancel(data)
    if kind == "ws_connect":
        return wf.deserialize_ws_connect(data)
    if kind == "ws_data":
        return wf.deserialize_ws_data(data)
    if kind == "ws_close":
        return wf.deserialize_ws_close(data)
    if kind == "ws_connect_ack":
        return wf.deserialize_ws_connect_ack(data)
    if kind == "ws_connect_error":
        return wf.deserialize_ws_connect_error(data)
    raise AssertionError(f"Unknown vector kind: {kind}")


def _encode(vector: dict[str, Any]) -> bytes:
    """Encode one vector's declared fields with the codec under test.

    Args:
        vector: Vector entry from the contract

    Returns:
        Serialized frame bytes
    """
    kind = vector["kind"]
    frame = vector["frame"]

    if kind == "hello":
        return hf.serialize_hello(
            {
                "protocol_version": frame["protocol_version"],
                "flags": frame["flags"],
                "max_chunk_bytes": frame["max_chunk_bytes"],
                "max_body_bytes": frame["max_body_bytes"],
                "impl": frame["impl"],
            }
        )
    if kind == "request_head":
        return hf.serialize_request_head(
            {
                "request_id": frame["request_id"],
                "method": frame["method"],
                "path": frame["path"],
                "headers": _pairs(frame["headers"]),
                "body_follows": frame["body_follows"],
            }
        )
    if kind == "response_head":
        return hf.serialize_response_head(
            {
                "request_id": frame["request_id"],
                "status_code": frame["status_code"],
                "headers": _pairs(frame["headers"]),
                "body_follows": frame["body_follows"],
            }
        )
    if kind == "chunk":
        payload = bytes.fromhex(frame["payload_hex"])
        if frame["frame_type"] == hf.FrameType.HTTP_REQUEST_CHUNK:
            return hf.serialize_request_chunk(frame["request_id"], payload, final=frame["final"])
        return hf.serialize_response_chunk(frame["request_id"], payload, final=frame["final"])
    if kind == "cancel":
        return hf.serialize_cancel(frame["request_id"], frame["reason_code"])
    if kind == "ws_connect":
        return wf.serialize_ws_connect(
            {
                "connection_id": frame["connection_id"],
                "url": frame["url"],
                "headers": _pairs(frame["headers"]),
            }
        )
    if kind == "ws_data":
        return wf.serialize_ws_data(
            {
                "connection_id": frame["connection_id"],
                "opcode": frame["opcode"],
                "payload": bytes.fromhex(frame["payload_hex"]),
                "fin": frame["fin"],
            }
        )
    if kind == "ws_close":
        return wf.serialize_ws_close(
            {
                "connection_id": frame["connection_id"],
                "close_code": frame["close_code"],
                "reason": frame["reason"],
            }
        )
    if kind == "ws_connect_ack":
        return wf.serialize_ws_connect_ack(
            {"connection_id": frame["connection_id"], "protocol": frame["protocol"]}
        )
    if kind == "ws_connect_error":
        return wf.serialize_ws_connect_error(
            {
                "connection_id": frame["connection_id"],
                "error_code": frame["error_code"],
                "reason": frame["reason"],
            }
        )
    raise AssertionError(f"Unknown vector kind: {kind}")


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_vector_encodes_to_the_golden_bytes(vector: dict[str, Any]) -> None:
    """Serializing the declared fields reproduces the fixture's bytes exactly."""
    assert _encode(vector).hex() == vector["hex"]


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_vector_decodes_to_the_declared_fields(vector: dict[str, Any]) -> None:
    """Deserializing the fixture's bytes yields the declared fields."""
    decoded = _decode(vector)
    expected = vector["frame"]

    for key, value in expected.items():
        if key == "payload_hex":
            assert decoded["payload"].hex() == value
        elif key == "headers":
            assert decoded["headers"] == _pairs(value)
        else:
            assert decoded[key] == value, f"{key} mismatch"


@pytest.mark.parametrize("vector", VECTORS, ids=[v["name"] for v in VECTORS])
def test_vector_round_trips(vector: dict[str, Any]) -> None:
    """Decode then re-encode is the identity on every vector."""
    data = bytes.fromhex(vector["hex"])
    decoded = _decode(vector)
    kind = vector["kind"]

    if kind == "hello":
        assert hf.serialize_hello(decoded) == data
    elif kind == "request_head":
        assert hf.serialize_request_head(decoded) == data
    elif kind == "response_head":
        assert hf.serialize_response_head(decoded) == data
    elif kind == "chunk":
        if decoded["frame_type"] == hf.FrameType.HTTP_REQUEST_CHUNK:
            assert (
                hf.serialize_request_chunk(
                    decoded["request_id"], decoded["payload"], final=decoded["final"]
                )
                == data
            )
        else:
            assert (
                hf.serialize_response_chunk(
                    decoded["request_id"], decoded["payload"], final=decoded["final"]
                )
                == data
            )
    elif kind == "cancel":
        assert hf.serialize_cancel(decoded["request_id"], decoded["reason_code"]) == data
    elif kind == "ws_connect":
        assert wf.serialize_ws_connect(decoded) == data
    elif kind == "ws_data":
        assert wf.serialize_ws_data(decoded) == data
    elif kind == "ws_close":
        assert wf.serialize_ws_close(decoded) == data
    elif kind == "ws_connect_ack":
        assert wf.serialize_ws_connect_ack(decoded) == data
    elif kind == "ws_connect_error":
        assert wf.serialize_ws_connect_error(decoded) == data
    else:  # pragma: no cover - guarded by _decode
        raise AssertionError(f"Unknown vector kind: {kind}")


def test_header_json_is_encoded_the_way_json_stringify_encodes_it() -> None:
    """Python's json defaults do not match JSON.stringify, and that matters.

    ``json.dumps`` pads separators with a space and escapes non-ASCII as
    ``\\uXXXX``. ``JSON.stringify`` does neither. Left at the defaults the two
    codecs emit different bytes for the same headers - still mutually
    decodable, but no longer byte-identical, which silently voids every golden
    vector above.
    """
    encoded = hf.encode_headers([("X-Title", "café ✓"), ("Accept", "application/json")])

    assert encoded == '[["X-Title","café ✓"],["Accept","application/json"]]'.encode()
    assert b", " not in encoded
    assert b"\\u" not in encoded


def test_every_frame_type_has_at_least_one_vector() -> None:
    """A frame type nobody pinned is a frame type free to drift."""
    covered = {
        bytes.fromhex(vector["hex"])[0]
        for vector in VECTORS
        # Chunk vectors record their own type in the frame body.
    }
    expected = {
        int(member)
        for member in hf.FrameType
        # 0x02 is reserved and never serialized by design.
        if member != hf.FrameType.HTTP_RESPONSE_V2_RESERVED
    }

    assert expected <= covered, f"no vector for {sorted(expected - covered)}"
