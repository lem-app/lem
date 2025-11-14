// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2025 Lem
//
// This file is part of Lem.
//
// Lem is free software: you can redistribute it and/or modify it under
// the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Lem is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General
// Public License for more details.

/**
 * Tests for HTTP frame serialization/deserialization.
 */

/// <reference types="vitest/globals" />

import { describe, it, expect } from 'vitest'
import {
  serializeRequest,
  deserializeRequest,
  serializeResponse,
  deserializeResponse,
  type HTTPRequestFrame,
  type HTTPResponseFrame,
} from './http-frame'

describe('HTTP Frame Serialization', () => {
  describe('Request serialization', () => {
    it('should serialize and deserialize a simple GET request', () => {
      const request: HTTPRequestFrame = {
        requestId: 1,
        method: 'GET',
        path: '/v1/health',
        headers: {
          'Accept': 'application/json',
        },
        body: '',
      }

      const serialized = serializeRequest(request)
      const deserialized = deserializeRequest(serialized)

      expect(deserialized).toEqual(request)
    })

    it('should serialize and deserialize a POST request with body', () => {
      const request: HTTPRequestFrame = {
        requestId: 42,
        method: 'POST',
        path: '/v1/runners/ollama/start',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ timeout: 300 }),
      }

      const serialized = serializeRequest(request)
      const deserialized = deserializeRequest(serialized)

      expect(deserialized).toEqual(request)
    })

    it('should handle empty headers', () => {
      const request: HTTPRequestFrame = {
        requestId: 100,
        method: 'GET',
        path: '/',
        headers: {},
        body: '',
      }

      const serialized = serializeRequest(request)
      const deserialized = deserializeRequest(serialized)

      expect(deserialized).toEqual(request)
    })

    it('should handle UTF-8 characters in path and body', () => {
      const request: HTTPRequestFrame = {
        requestId: 999,
        method: 'POST',
        path: '/v1/models/pull',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'llama3:8b-中文' }),
      }

      const serialized = serializeRequest(request)
      const deserialized = deserializeRequest(serialized)

      expect(deserialized).toEqual(request)
    })

    it('should handle large request bodies', () => {
      const largeBody = 'x'.repeat(10000)
      const request: HTTPRequestFrame = {
        requestId: 123,
        method: 'POST',
        path: '/v1/upload',
        headers: {
          'Content-Type': 'text/plain',
        },
        body: largeBody,
      }

      const serialized = serializeRequest(request)
      const deserialized = deserializeRequest(serialized)

      expect(deserialized).toEqual(request)
    })
  })

  describe('Response serialization', () => {
    it('should serialize and deserialize a 200 OK response', () => {
      const response: HTTPResponseFrame = {
        requestId: 1,
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'ok' }),
      }

      const serialized = serializeResponse(response)
      const deserialized = deserializeResponse(serialized)

      expect(deserialized).toEqual(response)
    })

    it('should serialize and deserialize a 404 error response', () => {
      const response: HTTPResponseFrame = {
        requestId: 42,
        statusCode: 404,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ error: 'Not found' }),
      }

      const serialized = serializeResponse(response)
      const deserialized = deserializeResponse(serialized)

      expect(deserialized).toEqual(response)
    })

    it('should handle empty response body', () => {
      const response: HTTPResponseFrame = {
        requestId: 100,
        statusCode: 204,
        headers: {},
        body: '',
      }

      const serialized = serializeResponse(response)
      const deserialized = deserializeResponse(serialized)

      expect(deserialized).toEqual(response)
    })

    it('should handle multiple response headers', () => {
      const response: HTTPResponseFrame = {
        requestId: 1,
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'X-Custom-Header': 'custom-value',
        },
        body: '{"data": "test"}',
      }

      const serialized = serializeResponse(response)
      const deserialized = deserializeResponse(serialized)

      expect(deserialized).toEqual(response)
    })
  })

  describe('Binary format validation', () => {
    it('should produce correct binary layout for request', () => {
      const request: HTTPRequestFrame = {
        requestId: 1,
        method: 'GET',
        path: '/test',
        headers: {},
        body: '',
      }

      const buffer = serializeRequest(request)
      const view = new DataView(buffer)

      // Check request_id (4 bytes)
      expect(view.getUint32(0, false)).toBe(1)

      // Check method_len (2 bytes)
      const methodLen = view.getUint16(4, false)
      expect(methodLen).toBe(3) // "GET" = 3 bytes

      // Check method string
      const methodBytes = new Uint8Array(buffer, 6, methodLen)
      const method = new TextDecoder().decode(methodBytes)
      expect(method).toBe('GET')
    })

    it('should produce correct binary layout for response', () => {
      const response: HTTPResponseFrame = {
        requestId: 42,
        statusCode: 200,
        headers: {},
        body: 'OK',
      }

      const buffer = serializeResponse(response)
      const view = new DataView(buffer)

      // Check request_id (4 bytes)
      expect(view.getUint32(0, false)).toBe(42)

      // Check status_code (2 bytes)
      expect(view.getUint16(4, false)).toBe(200)
    })
  })

  describe('Edge cases', () => {
    it('should handle request_id = 0', () => {
      const request: HTTPRequestFrame = {
        requestId: 0,
        method: 'GET',
        path: '/',
        headers: {},
        body: '',
      }

      const serialized = serializeRequest(request)
      const deserialized = deserializeRequest(serialized)

      expect(deserialized.requestId).toBe(0)
    })

    it('should handle maximum uint32 request_id', () => {
      const maxUint32 = 4294967295
      const request: HTTPRequestFrame = {
        requestId: maxUint32,
        method: 'GET',
        path: '/',
        headers: {},
        body: '',
      }

      const serialized = serializeRequest(request)
      const deserialized = deserializeRequest(serialized)

      expect(deserialized.requestId).toBe(maxUint32)
    })

    it('should handle status code 500+', () => {
      const response: HTTPResponseFrame = {
        requestId: 1,
        statusCode: 503,
        headers: {},
        body: 'Service Unavailable',
      }

      const serialized = serializeResponse(response)
      const deserialized = deserializeResponse(serialized)

      expect(deserialized.statusCode).toBe(503)
    })
  })
})
