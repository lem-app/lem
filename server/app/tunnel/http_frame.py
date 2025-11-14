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

"""HTTP-over-DataChannel frame serialization/deserialization.

Binary frame format (version 2 - with frame type):
- 1 byte: frame_type (uint8)
  - 0x01 = HTTP_REQUEST
  - 0x02 = HTTP_RESPONSE
  - 0x10 = WS_CONNECT (future)
  - 0x11 = WS_DATA (future)
  - 0x12 = WS_CLOSE (future)

Binary frame format for HTTP requests:
- 1 byte: frame_type (0x01)
- 4 bytes: request_id (uint32)
- 2 bytes: method_len (uint16)
- method_len bytes: HTTP method (GET, POST, etc.)
- 2 bytes: path_len (uint16)
- path_len bytes: HTTP path
- 4 bytes: headers_len (uint32)
- headers_len bytes: JSON headers
- 4 bytes: body_len (uint32)
- body_len bytes: HTTP body

Binary frame format for HTTP responses:
- 1 byte: frame_type (0x02)
- 4 bytes: request_id (uint32)
- 2 bytes: status_code (uint16)
- 4 bytes: headers_len (uint32)
- headers_len bytes: JSON headers
- 4 bytes: body_len (uint32)
- body_len bytes: HTTP body
"""

import json
import struct
from enum import IntEnum
from typing import TypedDict


class FrameType(IntEnum):
    """Frame type constants."""

    HTTP_REQUEST = 0x01
    HTTP_RESPONSE = 0x02
    WS_CONNECT = 0x10
    WS_DATA = 0x11
    WS_CLOSE = 0x12


class HTTPRequestFrame(TypedDict):
    """HTTP request frame."""

    request_id: int
    method: str
    path: str
    headers: dict[str, str]
    body: str


class HTTPResponseFrame(TypedDict):
    """HTTP response frame."""

    request_id: int
    status_code: int
    headers: dict[str, str]
    body: str


def serialize_request(frame: HTTPRequestFrame) -> bytes:
    """Serialize HTTP request to binary frame.

    Args:
        frame: Request frame to serialize

    Returns:
        Binary frame as bytes
    """
    # Encode strings to UTF-8
    method_bytes = frame["method"].encode("utf-8")
    path_bytes = frame["path"].encode("utf-8")
    headers_bytes = json.dumps(frame["headers"]).encode("utf-8")
    body_bytes = frame["body"].encode("utf-8")

    # Pack binary frame
    # Format: >B = big-endian unsigned byte (1 byte)
    #         >I = big-endian unsigned int (4 bytes)
    #         >H = big-endian unsigned short (2 bytes)
    parts = [
        struct.pack(">B", FrameType.HTTP_REQUEST),  # frame_type (uint8)
        struct.pack(">I", frame["request_id"]),  # request_id (uint32)
        struct.pack(">H", len(method_bytes)),  # method_len (uint16)
        method_bytes,  # method
        struct.pack(">H", len(path_bytes)),  # path_len (uint16)
        path_bytes,  # path
        struct.pack(">I", len(headers_bytes)),  # headers_len (uint32)
        headers_bytes,  # headers
        struct.pack(">I", len(body_bytes)),  # body_len (uint32)
        body_bytes,  # body
    ]

    return b"".join(parts)


def deserialize_request(data: bytes) -> HTTPRequestFrame:
    """Deserialize binary frame to HTTP request.

    Args:
        data: Binary frame

    Returns:
        Request frame

    Raises:
        ValueError: If frame is malformed
    """
    offset = 0

    # Read frame_type (uint8) and validate
    if len(data) < offset + 1:
        raise ValueError("Insufficient data for frame_type")
    (frame_type,) = struct.unpack(">B", data[offset : offset + 1])
    offset += 1

    if frame_type != FrameType.HTTP_REQUEST:
        raise ValueError(f"Expected HTTP_REQUEST frame (0x01), got 0x{frame_type:02x}")

    # Read request_id (uint32)
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for request_id")
    (request_id,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    # Read method_len (uint16) and method
    if len(data) < offset + 2:
        raise ValueError("Insufficient data for method_len")
    (method_len,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2

    if len(data) < offset + method_len:
        raise ValueError("Insufficient data for method")
    method = data[offset : offset + method_len].decode("utf-8")
    offset += method_len

    # Read path_len (uint16) and path
    if len(data) < offset + 2:
        raise ValueError("Insufficient data for path_len")
    (path_len,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2

    if len(data) < offset + path_len:
        raise ValueError("Insufficient data for path")
    path = data[offset : offset + path_len].decode("utf-8")
    offset += path_len

    # Read headers_len (uint32) and headers
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for headers_len")
    (headers_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    if len(data) < offset + headers_len:
        raise ValueError("Insufficient data for headers")
    headers_json = data[offset : offset + headers_len].decode("utf-8")
    headers: dict[str, str] = json.loads(headers_json)
    offset += headers_len

    # Read body_len (uint32) and body
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for body_len")
    (body_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    if len(data) < offset + body_len:
        raise ValueError("Insufficient data for body")
    body = data[offset : offset + body_len].decode("utf-8")

    return {
        "request_id": request_id,
        "method": method,
        "path": path,
        "headers": headers,
        "body": body,
    }


def serialize_response(frame: HTTPResponseFrame) -> bytes:
    """Serialize HTTP response to binary frame.

    Args:
        frame: Response frame to serialize

    Returns:
        Binary frame as bytes
    """
    # Encode strings to UTF-8
    headers_bytes = json.dumps(frame["headers"]).encode("utf-8")
    body_bytes = frame["body"].encode("utf-8")

    # Pack binary frame
    parts = [
        struct.pack(">B", FrameType.HTTP_RESPONSE),  # frame_type (uint8)
        struct.pack(">I", frame["request_id"]),  # request_id (uint32)
        struct.pack(">H", frame["status_code"]),  # status_code (uint16)
        struct.pack(">I", len(headers_bytes)),  # headers_len (uint32)
        headers_bytes,  # headers
        struct.pack(">I", len(body_bytes)),  # body_len (uint32)
        body_bytes,  # body
    ]

    return b"".join(parts)


def deserialize_response(data: bytes) -> HTTPResponseFrame:
    """Deserialize binary frame to HTTP response.

    Args:
        data: Binary frame

    Returns:
        Response frame

    Raises:
        ValueError: If frame is malformed
    """
    offset = 0

    # Read frame_type (uint8) and validate
    if len(data) < offset + 1:
        raise ValueError("Insufficient data for frame_type")
    (frame_type,) = struct.unpack(">B", data[offset : offset + 1])
    offset += 1

    if frame_type != FrameType.HTTP_RESPONSE:
        raise ValueError(f"Expected HTTP_RESPONSE frame (0x02), got 0x{frame_type:02x}")

    # Read request_id (uint32)
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for request_id")
    (request_id,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    # Read status_code (uint16)
    if len(data) < offset + 2:
        raise ValueError("Insufficient data for status_code")
    (status_code,) = struct.unpack(">H", data[offset : offset + 2])
    offset += 2

    # Read headers_len (uint32) and headers
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for headers_len")
    (headers_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    if len(data) < offset + headers_len:
        raise ValueError("Insufficient data for headers")
    headers_json = data[offset : offset + headers_len].decode("utf-8")
    headers: dict[str, str] = json.loads(headers_json)
    offset += headers_len

    # Read body_len (uint32) and body
    if len(data) < offset + 4:
        raise ValueError("Insufficient data for body_len")
    (body_len,) = struct.unpack(">I", data[offset : offset + 4])
    offset += 4

    if len(data) < offset + body_len:
        raise ValueError("Insufficient data for body")
    body = data[offset : offset + body_len].decode("utf-8")

    return {
        "request_id": request_id,
        "status_code": status_code,
        "headers": headers,
        "body": body,
    }
