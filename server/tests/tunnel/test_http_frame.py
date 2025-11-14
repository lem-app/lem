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

"""Tests for HTTP frame serialization/deserialization."""

import json

import pytest

from app.tunnel.http_frame import (
    HTTPRequestFrame,
    HTTPResponseFrame,
    deserialize_request,
    deserialize_response,
    serialize_request,
    serialize_response,
)


class TestRequestSerialization:
    """Tests for HTTP request frame serialization."""

    def test_serialize_and_deserialize_simple_get_request(self) -> None:
        """Test serialization of a simple GET request."""
        request: HTTPRequestFrame = {
            "request_id": 1,
            "method": "GET",
            "path": "/v1/health",
            "headers": {"Accept": "application/json"},
            "body": "",
        }

        serialized = serialize_request(request)
        deserialized = deserialize_request(serialized)

        assert deserialized == request

    def test_serialize_and_deserialize_post_request_with_body(self) -> None:
        """Test serialization of a POST request with body."""
        request: HTTPRequestFrame = {
            "request_id": 42,
            "method": "POST",
            "path": "/v1/runners/ollama/start",
            "headers": {
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            "body": json.dumps({"timeout": 300}),
        }

        serialized = serialize_request(request)
        deserialized = deserialize_request(serialized)

        assert deserialized == request

    def test_handle_empty_headers(self) -> None:
        """Test serialization with empty headers."""
        request: HTTPRequestFrame = {
            "request_id": 100,
            "method": "GET",
            "path": "/",
            "headers": {},
            "body": "",
        }

        serialized = serialize_request(request)
        deserialized = deserialize_request(serialized)

        assert deserialized == request

    def test_handle_utf8_characters(self) -> None:
        """Test serialization with UTF-8 characters in path and body."""
        request: HTTPRequestFrame = {
            "request_id": 999,
            "method": "POST",
            "path": "/v1/models/pull",
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"model": "llama3:8b-中文"}),
        }

        serialized = serialize_request(request)
        deserialized = deserialize_request(serialized)

        assert deserialized == request

    def test_handle_large_request_bodies(self) -> None:
        """Test serialization with large request body."""
        large_body = "x" * 10000
        request: HTTPRequestFrame = {
            "request_id": 123,
            "method": "POST",
            "path": "/v1/upload",
            "headers": {"Content-Type": "text/plain"},
            "body": large_body,
        }

        serialized = serialize_request(request)
        deserialized = deserialize_request(serialized)

        assert deserialized == request


class TestResponseSerialization:
    """Tests for HTTP response frame serialization."""

    def test_serialize_and_deserialize_200_ok_response(self) -> None:
        """Test serialization of a 200 OK response."""
        response: HTTPResponseFrame = {
            "request_id": 1,
            "status_code": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"status": "ok"}),
        }

        serialized = serialize_response(response)
        deserialized = deserialize_response(serialized)

        assert deserialized == response

    def test_serialize_and_deserialize_404_error_response(self) -> None:
        """Test serialization of a 404 error response."""
        response: HTTPResponseFrame = {
            "request_id": 42,
            "status_code": 404,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": "Not found"}),
        }

        serialized = serialize_response(response)
        deserialized = deserialize_response(serialized)

        assert deserialized == response

    def test_handle_empty_response_body(self) -> None:
        """Test serialization with empty response body."""
        response: HTTPResponseFrame = {
            "request_id": 100,
            "status_code": 204,
            "headers": {},
            "body": "",
        }

        serialized = serialize_response(response)
        deserialized = deserialize_response(serialized)

        assert deserialized == response

    def test_handle_multiple_response_headers(self) -> None:
        """Test serialization with multiple response headers."""
        response: HTTPResponseFrame = {
            "request_id": 1,
            "status_code": 200,
            "headers": {
                "Content-Type": "application/json",
                "Cache-Control": "no-cache",
                "X-Custom-Header": "custom-value",
            },
            "body": '{"data": "test"}',
        }

        serialized = serialize_response(response)
        deserialized = deserialize_response(serialized)

        assert deserialized == response


class TestBinaryFormatValidation:
    """Tests for binary format validation."""

    def test_correct_binary_layout_for_request(self) -> None:
        """Test that request binary layout is correct."""
        import struct

        request: HTTPRequestFrame = {
            "request_id": 1,
            "method": "GET",
            "path": "/test",
            "headers": {},
            "body": "",
        }

        data = serialize_request(request)

        # Check request_id (4 bytes, big-endian)
        request_id = struct.unpack(">I", data[:4])[0]
        assert request_id == 1

        # Check method_len (2 bytes, big-endian)
        method_len = struct.unpack(">H", data[4:6])[0]
        assert method_len == 3  # "GET" = 3 bytes

        # Check method string
        method = data[6 : 6 + method_len].decode("utf-8")
        assert method == "GET"

    def test_correct_binary_layout_for_response(self) -> None:
        """Test that response binary layout is correct."""
        import struct

        response: HTTPResponseFrame = {
            "request_id": 42,
            "status_code": 200,
            "headers": {},
            "body": "OK",
        }

        data = serialize_response(response)

        # Check request_id (4 bytes, big-endian)
        request_id = struct.unpack(">I", data[:4])[0]
        assert request_id == 42

        # Check status_code (2 bytes, big-endian)
        status_code = struct.unpack(">H", data[4:6])[0]
        assert status_code == 200


class TestEdgeCases:
    """Tests for edge cases."""

    def test_handle_request_id_zero(self) -> None:
        """Test serialization with request_id = 0."""
        request: HTTPRequestFrame = {
            "request_id": 0,
            "method": "GET",
            "path": "/",
            "headers": {},
            "body": "",
        }

        serialized = serialize_request(request)
        deserialized = deserialize_request(serialized)

        assert deserialized["request_id"] == 0

    def test_handle_maximum_uint32_request_id(self) -> None:
        """Test serialization with maximum uint32 request_id."""
        max_uint32 = 4294967295
        request: HTTPRequestFrame = {
            "request_id": max_uint32,
            "method": "GET",
            "path": "/",
            "headers": {},
            "body": "",
        }

        serialized = serialize_request(request)
        deserialized = deserialize_request(serialized)

        assert deserialized["request_id"] == max_uint32

    def test_handle_status_code_500_plus(self) -> None:
        """Test serialization with status code 500+."""
        response: HTTPResponseFrame = {
            "request_id": 1,
            "status_code": 503,
            "headers": {},
            "body": "Service Unavailable",
        }

        serialized = serialize_response(response)
        deserialized = deserialize_response(serialized)

        assert deserialized["status_code"] == 503


class TestErrorHandling:
    """Tests for error handling."""

    def test_deserialize_request_with_insufficient_data(self) -> None:
        """Test that deserialization fails with insufficient data."""
        with pytest.raises(ValueError, match="Insufficient data"):
            deserialize_request(b"\x00\x00")

    def test_deserialize_response_with_insufficient_data(self) -> None:
        """Test that deserialization fails with insufficient data."""
        with pytest.raises(ValueError, match="Insufficient data"):
            deserialize_response(b"\x00\x00")

    def test_deserialize_request_with_truncated_method(self) -> None:
        """Test that deserialization fails with truncated method."""
        import struct

        # Create frame with method_len = 10 but only 3 bytes following
        data = struct.pack(">I", 1)  # request_id
        data += struct.pack(">H", 10)  # method_len = 10
        data += b"GET"  # only 3 bytes

        with pytest.raises(ValueError, match="Insufficient data"):
            deserialize_request(data)
