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

"""WebSocket-over-DataChannel frame serialization/deserialization.

Binary frame format for WebSocket CONNECT:
- 1 byte: frame_type (0x10)
- 4 bytes: connection_id (uint32)
- 2 bytes: url_len (uint16)
- url_len bytes: WebSocket URL (UTF-8)
- 4 bytes: headers_len (uint32)
- headers_len bytes: JSON headers

Binary frame format for WebSocket DATA:
- 1 byte: frame_type (0x11)
- 4 bytes: connection_id (uint32)
- 1 byte: opcode (0=continuation, 1=text, 2=binary, 8=close, 9=ping, 10=pong)
- 4 bytes: payload_len (uint32)
- payload_len bytes: WebSocket payload (raw bytes)

Binary frame format for WebSocket CLOSE:
- 1 byte: frame_type (0x12)
- 4 bytes: connection_id (uint32)
- 2 bytes: close_code (uint16)
- 2 bytes: reason_len (uint16)
- reason_len bytes: close reason (UTF-8)
"""

import json
import struct
from enum import IntEnum
from typing import TypedDict

from .http_frame import FrameType


class WSOpcode(IntEnum):
    """WebSocket opcode constants (from RFC 6455)."""

    CONTINUATION = 0x00
    TEXT = 0x01
    BINARY = 0x02
    CLOSE = 0x08
    PING = 0x09
    PONG = 0x0A


class WSConnectFrame(TypedDict):
    """WebSocket CONNECT frame."""

    connection_id: int
    url: str
    headers: dict[str, str]


class WSDataFrame(TypedDict):
    """WebSocket DATA frame."""

    connection_id: int
    opcode: int
    payload: bytes


class WSCloseFrame(TypedDict):
    """WebSocket CLOSE frame."""

    connection_id: int
    close_code: int
    reason: str


def serialize_ws_connect(frame: WSConnectFrame) -> bytes:
    """Serialize WebSocket CONNECT frame to binary.

    Args:
        frame: CONNECT frame to serialize

    Returns:
        Binary frame as bytes
    """
    # Encode strings to UTF-8
    url_bytes = frame["url"].encode("utf-8")
    headers_bytes = json.dumps(frame["headers"]).encode("utf-8")

    # Pack binary frame
    # Format: >B = big-endian unsigned byte (1 byte)
    #         >I = big-endian unsigned int (4 bytes)
    #         >H = big-endian unsigned short (2 bytes)
    parts = [
        struct.pack(">B", FrameType.WS_CONNECT),  # frame_type (uint8)
        struct.pack(">I", frame["connection_id"]),  # connection_id (uint32)
        struct.pack(">H", len(url_bytes)),  # url_len (uint16)
        url_bytes,  # url
        struct.pack(">I", len(headers_bytes)),  # headers_len (uint32)
        headers_bytes,  # headers
    ]

    return b"".join(parts)


def deserialize_ws_connect(data: bytes) -> WSConnectFrame:
    """Deserialize binary frame to WebSocket CONNECT.

    Args:
        data: Binary frame

    Returns:
        CONNECT frame

    Raises:
        ValueError: If frame is malformed
    """
    offset = 0

    # Read frame_type (uint8) and validate
    if len(data) < offset + 1:
        raise ValueError("Insufficient data for frame_type")
    (frame_type,) = struct.unpack(">B", data[offset : offset + 1])
    offset += 1

    if frame_type != FrameType.WS_CONNECT:
        raise ValueError(f"Expected WS_CONNECT frame (0x10), got 0x{frame_type:02x}")

    # Read connection_id (uint32)
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for connection_id")
    (connection_id,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    # Read url_len (uint16) and url
    if len(data) < offset + 2:
        raise ValueError("Insufficient data for url_len")
    (url_len,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2

    if len(data) < offset + url_len:
        raise ValueError("Insufficient data for url")
    url = data[offset : offset + url_len].decode("utf-8")
    offset += url_len

    # Read headers_len (uint32) and headers
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for headers_len")
    (headers_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    if len(data) < offset + headers_len:
        raise ValueError("Insufficient data for headers")
    headers_json = data[offset : offset + headers_len].decode("utf-8")
    headers: dict[str, str] = json.loads(headers_json)

    return {
        "connection_id": connection_id,
        "url": url,
        "headers": headers,
    }


def serialize_ws_data(frame: WSDataFrame) -> bytes:
    """Serialize WebSocket DATA frame to binary.

    Args:
        frame: DATA frame to serialize

    Returns:
        Binary frame as bytes
    """
    payload_bytes = frame["payload"]

    # Pack binary frame
    parts = [
        struct.pack(">B", FrameType.WS_DATA),  # frame_type (uint8)
        struct.pack(">I", frame["connection_id"]),  # connection_id (uint32)
        struct.pack(">B", frame["opcode"]),  # opcode (uint8)
        struct.pack(">I", len(payload_bytes)),  # payload_len (uint32)
        payload_bytes,  # payload
    ]

    return b"".join(parts)


def deserialize_ws_data(data: bytes) -> WSDataFrame:
    """Deserialize binary frame to WebSocket DATA.

    Args:
        data: Binary frame

    Returns:
        DATA frame

    Raises:
        ValueError: If frame is malformed
    """
    offset = 0

    # Read frame_type (uint8) and validate
    if len(data) < offset + 1:
        raise ValueError("Insufficient data for frame_type")
    (frame_type,) = struct.unpack(">B", data[offset : offset + 1])
    offset += 1

    if frame_type != FrameType.WS_DATA:
        raise ValueError(f"Expected WS_DATA frame (0x11), got 0x{frame_type:02x}")

    # Read connection_id (uint32)
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for connection_id")
    (connection_id,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    # Read opcode (uint8)
    if len(data) < offset + 1:
        raise ValueError("Insufficient data for opcode")
    (opcode,) = struct.unpack(">B", data[offset : offset + 1])
    offset += 1

    # Read payload_len (uint32) and payload
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for payload_len")
    (payload_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    if len(data) < offset + payload_len:
        raise ValueError("Insufficient data for payload")
    payload = data[offset : offset + payload_len]

    return {
        "connection_id": connection_id,
        "opcode": opcode,
        "payload": payload,
    }


def serialize_ws_close(frame: WSCloseFrame) -> bytes:
    """Serialize WebSocket CLOSE frame to binary.

    Args:
        frame: CLOSE frame to serialize

    Returns:
        Binary frame as bytes
    """
    # Encode reason to UTF-8
    reason_bytes = frame["reason"].encode("utf-8")

    # Pack binary frame
    parts = [
        struct.pack(">B", FrameType.WS_CLOSE),  # frame_type (uint8)
        struct.pack(">I", frame["connection_id"]),  # connection_id (uint32)
        struct.pack(">H", frame["close_code"]),  # close_code (uint16)
        struct.pack(">H", len(reason_bytes)),  # reason_len (uint16)
        reason_bytes,  # reason
    ]

    return b"".join(parts)


def deserialize_ws_close(data: bytes) -> WSCloseFrame:
    """Deserialize binary frame to WebSocket CLOSE.

    Args:
        data: Binary frame

    Returns:
        CLOSE frame

    Raises:
        ValueError: If frame is malformed
    """
    offset = 0

    # Read frame_type (uint8) and validate
    if len(data) < offset + 1:
        raise ValueError("Insufficient data for frame_type")
    (frame_type,) = struct.unpack(">B", data[offset : offset + 1])
    offset += 1

    if frame_type != FrameType.WS_CLOSE:
        raise ValueError(f"Expected WS_CLOSE frame (0x12), got 0x{frame_type:02x}")

    # Read connection_id (uint32)
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for connection_id")
    (connection_id,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    # Read close_code (uint16)
    if len(data) < offset + 2:
        raise ValueError("Insufficient data for close_code")
    (close_code,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2

    # Read reason_len (uint16) and reason
    if len(data) < offset + 2:
        raise ValueError("Insufficient data for reason_len")
    (reason_len,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2

    if len(data) < offset + reason_len:
        raise ValueError("Insufficient data for reason")
    reason = data[offset : offset + reason_len].decode("utf-8")

    return {
        "connection_id": connection_id,
        "close_code": close_code,
        "reason": reason,
    }
