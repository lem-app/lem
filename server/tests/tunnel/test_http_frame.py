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

"""Tests for tunnel protocol v3 frame serialization.

Byte offsets are asserted explicitly, in the structure PR #24 established: a
round-trip test alone passes just as happily against a layout both directions
get wrong, which is how the v1-to-v2 drift survived for months.
"""

import json
import struct
from collections.abc import Callable
from typing import Any

import pytest

from app.tunnel.errors import TunnelErrorCode, TunnelProtocolError
from app.tunnel.http_frame import (
    FLAG_BODY_FOLLOWS,
    FLAG_FINAL,
    MAX_CHUNK_BYTES,
    MAX_HEADERS_BYTES,
    MAX_URL_BYTES,
    PROTOCOL_VERSION,
    FrameType,
    HelloFrame,
    HTTPRequestHeadFrame,
    HTTPResponseHeadFrame,
    decode_headers,
    deserialize_cancel,
    deserialize_chunk,
    deserialize_hello,
    deserialize_request_head,
    deserialize_response_head,
    encode_headers,
    peek_frame_type,
    peek_request_id,
    serialize_cancel,
    serialize_hello,
    serialize_request_chunk,
    serialize_request_head,
    serialize_response_chunk,
    serialize_response_head,
)


class TestFrameTypes:
    """Frame type numbering is protocol surface, not an implementation detail."""

    def test_v3_frame_type_values(self) -> None:
        """Every code is pinned; 0x02 stays reserved for v2 detection."""
        assert FrameType.HELLO == 0x00
        assert FrameType.HTTP_REQUEST_HEAD == 0x01
        assert FrameType.HTTP_RESPONSE_V2_RESERVED == 0x02
        assert FrameType.HTTP_RESPONSE_HEAD == 0x03
        assert FrameType.HTTP_RESPONSE_CHUNK == 0x04
        assert FrameType.HTTP_CANCEL == 0x05
        assert FrameType.HTTP_REQUEST_CHUNK == 0x06
        assert FrameType.WS_CONNECT == 0x10
        assert FrameType.WS_DATA == 0x11
        assert FrameType.WS_CLOSE == 0x12
        assert FrameType.WS_CONNECT_ACK == 0x13
        assert FrameType.WS_CONNECT_ERROR == 0x14


class TestHello:
    """HELLO carries the version and the negotiated limits."""

    def test_hello_byte_layout(self) -> None:
        """type(1) version(1) flags(2) chunk(4) body(4) impl_len(2) impl."""
        frame: HelloFrame = {
            "protocol_version": PROTOCOL_VERSION,
            "flags": 0,
            "max_chunk_bytes": 49152,
            "max_body_bytes": 33554432,
            "impl": "lem-server/0.1.0",
        }

        data = serialize_hello(frame)

        assert data[0] == FrameType.HELLO
        assert data[1] == 3
        assert struct.unpack(">H", data[2:4])[0] == 0
        assert struct.unpack(">I", data[4:8])[0] == 49152
        assert struct.unpack(">I", data[8:12])[0] == 33554432
        assert struct.unpack(">H", data[12:14])[0] == len(b"lem-server/0.1.0")
        assert data[14:] == b"lem-server/0.1.0"

    def test_hello_round_trips(self) -> None:
        """Decoding returns exactly what was encoded."""
        frame: HelloFrame = {
            "protocol_version": 3,
            "flags": 0,
            "max_chunk_bytes": 1024,
            "max_body_bytes": 2048,
            "impl": "lem-web/0.1.0",
        }

        assert deserialize_hello(serialize_hello(frame)) == frame

    def test_hello_rejects_truncation(self) -> None:
        """A short HELLO is malformed, not a partially-trusted HELLO."""
        with pytest.raises(TunnelProtocolError, match="Insufficient data"):
            deserialize_hello(bytes([FrameType.HELLO, 3, 0, 0]))


class TestRequestHead:
    """HTTP_REQUEST_HEAD carries no body; chunks follow."""

    def test_request_head_byte_layout(self) -> None:
        """request_id is at bytes 1..4, after the frame type."""
        frame: HTTPRequestHeadFrame = {
            "request_id": 42,
            "method": "POST",
            "path": "/v1/x",
            "headers": [("A", "b")],
            "body_follows": True,
        }

        data = serialize_request_head(frame)

        assert data[0] == FrameType.HTTP_REQUEST_HEAD
        assert struct.unpack(">I", data[1:5])[0] == 42
        assert data[5] == FLAG_BODY_FOLLOWS
        assert struct.unpack(">H", data[6:8])[0] == 4
        assert data[8:12] == b"POST"

    def test_request_head_round_trips(self) -> None:
        """Order and duplicates survive, which a JSON object would not."""
        frame: HTTPRequestHeadFrame = {
            "request_id": 7,
            "method": "GET",
            "path": "/a?b=c",
            "headers": [("Cookie", "a=1"), ("Cookie", "b=2"), ("Accept", "*/*")],
            "body_follows": False,
        }

        assert deserialize_request_head(serialize_request_head(frame)) == frame

    def test_body_follows_flag_round_trips(self) -> None:
        """The flag is what tells the receiver to expect chunks."""
        base: HTTPRequestHeadFrame = {
            "request_id": 1,
            "method": "GET",
            "path": "/",
            "headers": [],
            "body_follows": False,
        }

        assert deserialize_request_head(serialize_request_head(base))["body_follows"] is False
        base["body_follows"] = True
        assert deserialize_request_head(serialize_request_head(base))["body_follows"] is True

    def test_undefined_flag_bits_are_ignored(self) -> None:
        """Undefined bits MUST be ignored on receipt, not rejected."""
        frame: HTTPRequestHeadFrame = {
            "request_id": 1,
            "method": "GET",
            "path": "/",
            "headers": [],
            "body_follows": True,
        }
        data = bytearray(serialize_request_head(frame))
        data[5] |= 0b1111_1110

        assert deserialize_request_head(bytes(data))["body_follows"] is True

    def test_request_id_zero_is_rejected(self) -> None:
        """0 is reserved; accepting it makes correlation ambiguous."""
        data = bytearray(
            serialize_request_head(
                {
                    "request_id": 1,
                    "method": "GET",
                    "path": "/",
                    "headers": [],
                    "body_follows": False,
                }
            )
        )
        data[1:5] = struct.pack(">I", 0)

        with pytest.raises(TunnelProtocolError, match="reserved"):
            deserialize_request_head(bytes(data))

    def test_wrong_frame_type_is_rejected(self) -> None:
        """A response head is not a request head."""
        with pytest.raises(TunnelProtocolError, match="Expected frame 0x01"):
            deserialize_request_head(
                serialize_response_head(
                    {
                        "request_id": 1,
                        "status_code": 200,
                        "headers": [],
                        "body_follows": False,
                    }
                )
            )


class TestResponseHead:
    """HTTP_RESPONSE_HEAD is what makes a streamed response resolvable early."""

    def test_response_head_byte_layout(self) -> None:
        """type(1) request_id(4) status(2) flags(1) headers_len(4) headers."""
        frame: HTTPResponseHeadFrame = {
            "request_id": 42,
            "status_code": 404,
            "headers": [("Content-Type", "text/plain")],
            "body_follows": True,
        }

        data = serialize_response_head(frame)

        assert data[0] == FrameType.HTTP_RESPONSE_HEAD
        assert struct.unpack(">I", data[1:5])[0] == 42
        assert struct.unpack(">H", data[5:7])[0] == 404
        assert data[7] == FLAG_BODY_FOLLOWS

    def test_response_head_round_trips(self) -> None:
        """Duplicate response headers survive the codec."""
        frame: HTTPResponseHeadFrame = {
            "request_id": 3,
            "status_code": 200,
            "headers": [("Link", "<a>"), ("Link", "<b>")],
            "body_follows": True,
        }

        assert deserialize_response_head(serialize_response_head(frame)) == frame


class TestChunks:
    """Chunks carry raw bytes. This is what v2 could not do."""

    def test_chunk_byte_layout(self) -> None:
        """type(1) request_id(4) flags(1) payload_len(4) payload."""
        data = serialize_response_chunk(42, b"abc", final=True)

        assert data[0] == FrameType.HTTP_RESPONSE_CHUNK
        assert struct.unpack(">I", data[1:5])[0] == 42
        assert data[5] == FLAG_FINAL
        assert struct.unpack(">I", data[6:10])[0] == 3
        assert data[10:] == b"abc"

    @pytest.mark.parametrize(
        "payload",
        [
            b"",
            b"\x00",
            bytes([0xC3, 0x28]),  # invalid UTF-8
            bytes(range(256)),
            b"\x89PNG\r\n\x1a\n",
            "héllo ✓".encode(),
        ],
        ids=["empty", "nul", "invalid-utf8", "all-bytes", "png-magic", "utf8"],
    )
    def test_binary_payloads_survive_byte_for_byte(self, payload: bytes) -> None:
        """v2 round-tripped bodies through UTF-8 and corrupted every one of these."""
        decoded = deserialize_chunk(serialize_response_chunk(1, payload, final=False))

        assert decoded["payload"] == payload
        assert decoded["final"] is False

    def test_zero_length_final_chunk_is_legal(self) -> None:
        """How a streaming source with no trailing bytes ends."""
        decoded = deserialize_chunk(serialize_response_chunk(1, b"", final=True))

        assert decoded["payload"] == b""
        assert decoded["final"] is True

    def test_request_and_response_chunks_are_distinguishable(self) -> None:
        """One decoder serves both; the type is reported, not guessed."""
        request = deserialize_chunk(serialize_request_chunk(1, b"x", final=False))
        response = deserialize_chunk(serialize_response_chunk(1, b"x", final=False))

        assert request["frame_type"] == FrameType.HTTP_REQUEST_CHUNK
        assert response["frame_type"] == FrameType.HTTP_RESPONSE_CHUNK

    def test_chunk_payload_over_the_cap_is_rejected_before_slicing(self) -> None:
        """A peer may declare 4 GiB in this uint32."""
        forged = b"".join(
            [
                struct.pack(">B", FrameType.HTTP_RESPONSE_CHUNK),
                struct.pack(">I", 1),
                struct.pack(">B", 0),
                struct.pack(">I", 0xFFFFFFFF),
                b"0123456789",
            ]
        )

        with pytest.raises(TunnelProtocolError, match="Chunk too large") as excinfo:
            deserialize_chunk(forged)

        assert excinfo.value.code == TunnelErrorCode.E_TOO_LARGE

    def test_negotiated_chunk_cap_is_enforced(self) -> None:
        """The effective cap is the negotiated one, not the default."""
        data = serialize_response_chunk(1, b"x" * 100, final=False)

        assert deserialize_chunk(data, 100)["payload"] == b"x" * 100
        with pytest.raises(TunnelProtocolError, match="Chunk too large"):
            deserialize_chunk(data, 99)


class TestCancel:
    """HTTP_CANCEL is how either side abandons an exchange."""

    def test_cancel_byte_layout(self) -> None:
        """type(1) request_id(4) reason_code(2)."""
        data = serialize_cancel(42, TunnelErrorCode.E_TOO_LARGE)

        assert len(data) == 7
        assert data[0] == FrameType.HTTP_CANCEL
        assert struct.unpack(">I", data[1:5])[0] == 42
        assert struct.unpack(">H", data[5:7])[0] == int(TunnelErrorCode.E_TOO_LARGE)

    def test_cancel_round_trips(self) -> None:
        """The reason survives so the peer can report it."""
        decoded = deserialize_cancel(serialize_cancel(9, TunnelErrorCode.E_TIMEOUT_STREAM))

        assert decoded == {
            "request_id": 9,
            "reason_code": int(TunnelErrorCode.E_TIMEOUT_STREAM),
        }


class TestV2Detection:
    """A v2 peer must be diagnosable, never misparsed."""

    @pytest.mark.parametrize(
        "decoder",
        [
            deserialize_request_head,
            deserialize_response_head,
            deserialize_chunk,
            deserialize_cancel,
        ],
        ids=["request_head", "response_head", "chunk", "cancel"],
    )
    def test_reserved_v2_response_frame_is_reported_as_such(
        self, decoder: Callable[[bytes], Any]
    ) -> None:
        """0x02 gets its own code rather than a generic parse failure."""
        v2_response = bytes([0x02]) + struct.pack(">I", 42) + b"rest"

        with pytest.raises(TunnelProtocolError) as excinfo:
            decoder(v2_response)

        assert excinfo.value.code == TunnelErrorCode.E_PROTO_V2_FRAME
        assert excinfo.value.http_status == 502


class TestHeaderEncoding:
    """Headers are an ordered array of pairs, validated on receipt."""

    def test_headers_round_trip_with_duplicates_and_order(self) -> None:
        """The reason the encoding changed from a JSON object."""
        headers = [("Set-Cookie", "a=1"), ("Set-Cookie", "b=2"), ("X", "1")]

        assert decode_headers(encode_headers(headers)) == headers

    def test_v2_header_object_is_rejected(self) -> None:
        """A v2 peer's JSON object must not be silently accepted."""
        with pytest.raises(TunnelProtocolError, match="JSON array"):
            decode_headers(json.dumps({"Accept": "*/*"}).encode())

    @pytest.mark.parametrize(
        "payload",
        ['[["a"]]', '[["a","b","c"]]', '[["a",1]]', '[[1,"b"]]', '["ab"]', '[[["a"],["b"]]]'],
    )
    def test_malformed_header_shapes_are_rejected(self, payload: str) -> None:
        """The peer chooses these bytes; the shape is checked, not trusted."""
        with pytest.raises(TunnelProtocolError):
            decode_headers(payload.encode())

    def test_invalid_json_is_rejected(self) -> None:
        """Not JSON at all is a malformed frame."""
        with pytest.raises(TunnelProtocolError, match="not valid JSON"):
            decode_headers(b"{oh no")

    def test_headers_over_the_cap_are_rejected_before_slicing(self) -> None:
        """PR #25's cap, kept verbatim, on the v3 layout."""
        forged = b"".join(
            [
                struct.pack(">B", FrameType.HTTP_REQUEST_HEAD),
                struct.pack(">I", 1),
                struct.pack(">B", 0),
                struct.pack(">H", 3),
                b"GET",
                struct.pack(">H", 1),
                b"/",
                struct.pack(">I", MAX_HEADERS_BYTES + 1),
                b"[]",
            ]
        )

        with pytest.raises(TunnelProtocolError, match="Headers too large"):
            deserialize_request_head(forged)

    def test_path_over_the_cap_is_rejected_before_slicing(self) -> None:
        """path_len is a uint16, so the cap is what actually bounds it."""
        forged = b"".join(
            [
                struct.pack(">B", FrameType.HTTP_REQUEST_HEAD),
                struct.pack(">I", 1),
                struct.pack(">B", 0),
                struct.pack(">H", 3),
                b"GET",
                struct.pack(">H", MAX_URL_BYTES + 1),
                b"/",
            ]
        )

        with pytest.raises(TunnelProtocolError, match="Path too large"):
            deserialize_request_head(forged)


class TestPeekHelpers:
    """The helpers the error path uses when the frame will not decode."""

    def test_peek_request_id_reads_bytes_one_to_four(self) -> None:
        """Reading data[:4] instead puts the frame type in the top octet."""
        data = serialize_response_chunk(0x01020304, b"", final=True)

        assert peek_request_id(data) == 0x01020304
        assert struct.unpack(">I", data[:4])[0] != 0x01020304

    def test_peek_helpers_handle_short_frames(self) -> None:
        """A frame too short to carry a field yields None, not a guess."""
        assert peek_request_id(b"\x01\x00\x00\x00") is None
        assert peek_frame_type(b"") is None
        assert peek_frame_type(b"\x03") == 3


class TestTruncation:
    """Every length field is checked before it is used to slice."""

    @pytest.mark.parametrize("length", list(range(0, 12)))
    def test_truncated_request_head_is_a_protocol_error(self, length: int) -> None:
        """Truncation raises TunnelProtocolError, never IndexError or struct.error."""
        full = serialize_request_head(
            {
                "request_id": 1,
                "method": "GET",
                "path": "/v1/health",
                "headers": [("A", "b")],
                "body_follows": False,
            }
        )

        with pytest.raises(TunnelProtocolError):
            deserialize_request_head(full[:length])

    def test_chunk_declaring_more_than_it_carries_is_rejected(self) -> None:
        """Declared length must be backed by real bytes."""
        forged = b"".join(
            [
                struct.pack(">B", FrameType.HTTP_RESPONSE_CHUNK),
                struct.pack(">I", 1),
                struct.pack(">B", 0),
                struct.pack(">I", MAX_CHUNK_BYTES),
                b"short",
            ]
        )

        with pytest.raises(TunnelProtocolError, match="Insufficient data for payload"):
            deserialize_chunk(forged)
