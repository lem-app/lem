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
 * Tests for tunnel protocol v3 frame serialization.
 *
 * Byte offsets are asserted explicitly, in the structure PR #24 established: a
 * round-trip test alone passes just as happily against a layout both directions
 * get wrong, which is how the v1-to-v2 drift survived for months.
 */

/// <reference types="vitest/globals" />

import { describe, it, expect } from 'vitest'
import {
  FLAG_BODY_FOLLOWS,
  FLAG_FINAL,
  FrameType,
  MAX_CHUNK_BYTES,
  MAX_HEADERS_BYTES,
  MAX_URL_BYTES,
  PROTOCOL_VERSION,
  decodeHeaders,
  deserializeCancel,
  deserializeChunk,
  deserializeHello,
  deserializeRequestHead,
  deserializeResponseHead,
  encodeHeaders,
  peekFrameType,
  peekRequestId,
  serializeCancel,
  serializeHello,
  serializeRequestChunk,
  serializeRequestHead,
  serializeResponseChunk,
  serializeResponseHead,
} from './http-frame'
import { LemProxyError } from './tunnel-errors'

const textEncoder = new TextEncoder()

function view(buffer: ArrayBuffer): DataView {
  return new DataView(buffer)
}

describe('FrameType', () => {
  it('pins every v3 code, with 0x02 reserved for v2 detection', () => {
    expect(FrameType.HELLO).toBe(0x00)
    expect(FrameType.HTTP_REQUEST_HEAD).toBe(0x01)
    expect(FrameType.HTTP_RESPONSE_V2_RESERVED).toBe(0x02)
    expect(FrameType.HTTP_RESPONSE_HEAD).toBe(0x03)
    expect(FrameType.HTTP_RESPONSE_CHUNK).toBe(0x04)
    expect(FrameType.HTTP_CANCEL).toBe(0x05)
    expect(FrameType.HTTP_REQUEST_CHUNK).toBe(0x06)
    expect(FrameType.WS_CONNECT).toBe(0x10)
    expect(FrameType.WS_DATA).toBe(0x11)
    expect(FrameType.WS_CLOSE).toBe(0x12)
    expect(FrameType.WS_CONNECT_ACK).toBe(0x13)
    expect(FrameType.WS_CONNECT_ERROR).toBe(0x14)
  })
})

describe('HELLO', () => {
  it('lays out type(1) version(1) flags(2) chunk(4) body(4) impl_len(2) impl', () => {
    const buffer = serializeHello({
      protocolVersion: PROTOCOL_VERSION,
      flags: 0,
      maxChunkBytes: 49152,
      maxBodyBytes: 33554432,
      impl: 'lem-web/0.1.0',
    })
    const bytes = new Uint8Array(buffer)

    expect(bytes[0]).toBe(FrameType.HELLO)
    expect(bytes[1]).toBe(3)
    expect(view(buffer).getUint16(2, false)).toBe(0)
    expect(view(buffer).getUint32(4, false)).toBe(49152)
    expect(view(buffer).getUint32(8, false)).toBe(33554432)
    expect(view(buffer).getUint16(12, false)).toBe('lem-web/0.1.0'.length)
  })

  it('round-trips', () => {
    const frame = {
      protocolVersion: 3,
      flags: 0,
      maxChunkBytes: 1024,
      maxBodyBytes: 2048,
      impl: 'lem-web/0.1.0',
    }

    expect(deserializeHello(serializeHello(frame))).toEqual(frame)
  })

  it('rejects a truncated HELLO', () => {
    expect(() => deserializeHello(new Uint8Array([0x00, 3, 0, 0]))).toThrow(/Insufficient data/)
  })
})

describe('HTTP_REQUEST_HEAD', () => {
  it('puts request_id at bytes 1..4, after the frame type', () => {
    const buffer = serializeRequestHead({
      requestId: 42,
      method: 'POST',
      path: '/v1/x',
      headers: [['A', 'b']],
      bodyFollows: true,
    })
    const bytes = new Uint8Array(buffer)

    expect(bytes[0]).toBe(FrameType.HTTP_REQUEST_HEAD)
    expect(view(buffer).getUint32(1, false)).toBe(42)
    expect(bytes[5]).toBe(FLAG_BODY_FOLLOWS)
    expect(view(buffer).getUint16(6, false)).toBe(4)
  })

  it('preserves header order and duplicates', () => {
    const frame = {
      requestId: 7,
      method: 'GET',
      path: '/a?b=c',
      headers: [
        ['Cookie', 'a=1'],
        ['Cookie', 'b=2'],
        ['Accept', '*/*'],
      ] as [string, string][],
      bodyFollows: false,
    }

    expect(deserializeRequestHead(serializeRequestHead(frame))).toEqual(frame)
  })

  it('ignores undefined flag bits', () => {
    const bytes = new Uint8Array(
      serializeRequestHead({
        requestId: 1,
        method: 'GET',
        path: '/',
        headers: [],
        bodyFollows: true,
      })
    )
    bytes[5] |= 0b1111_1110

    expect(deserializeRequestHead(bytes).bodyFollows).toBe(true)
  })

  it('rejects request_id 0', () => {
    const bytes = new Uint8Array(
      serializeRequestHead({
        requestId: 1,
        method: 'GET',
        path: '/',
        headers: [],
        bodyFollows: false,
      })
    )
    new DataView(bytes.buffer).setUint32(1, 0, false)

    expect(() => deserializeRequestHead(bytes)).toThrow(/reserved/)
  })

  it('rejects a declared path length over the cap before slicing', () => {
    const prefix = [FrameType.HTTP_REQUEST_HEAD, 0, 0, 0, 1, 0, 0, 3]
    const bytes = new Uint8Array([...prefix, ...textEncoder.encode('GET'), 0xff, 0xff, 0x2f])

    expect(() => deserializeRequestHead(bytes)).toThrow(/Path too large/)
    expect(MAX_URL_BYTES).toBe(8192)
  })
})

describe('HTTP_RESPONSE_HEAD', () => {
  it('lays out type(1) request_id(4) status(2) flags(1) headers_len(4)', () => {
    const buffer = serializeResponseHead({
      requestId: 42,
      statusCode: 404,
      headers: [['Content-Type', 'text/plain']],
      bodyFollows: true,
    })
    const bytes = new Uint8Array(buffer)

    expect(bytes[0]).toBe(FrameType.HTTP_RESPONSE_HEAD)
    expect(view(buffer).getUint32(1, false)).toBe(42)
    expect(view(buffer).getUint16(5, false)).toBe(404)
    expect(bytes[7]).toBe(FLAG_BODY_FOLLOWS)
  })

  it('round-trips duplicate response headers', () => {
    const frame = {
      requestId: 3,
      statusCode: 200,
      headers: [
        ['Link', '<a>'],
        ['Link', '<b>'],
      ] as [string, string][],
      bodyFollows: true,
    }

    expect(deserializeResponseHead(serializeResponseHead(frame))).toEqual(frame)
  })
})

describe('chunks', () => {
  it('lays out type(1) request_id(4) flags(1) payload_len(4) payload', () => {
    const buffer = serializeResponseChunk(42, textEncoder.encode('abc'), true)
    const bytes = new Uint8Array(buffer)

    expect(bytes[0]).toBe(FrameType.HTTP_RESPONSE_CHUNK)
    expect(view(buffer).getUint32(1, false)).toBe(42)
    expect(bytes[5]).toBe(FLAG_FINAL)
    expect(view(buffer).getUint32(6, false)).toBe(3)
  })

  it.each([
    ['empty', new Uint8Array(0)],
    ['nul', new Uint8Array([0x00])],
    ['invalid utf-8', new Uint8Array([0xc3, 0x28])],
    ['all byte values', new Uint8Array(Array.from({ length: 256 }, (_, index) => index))],
    ['png magic', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ])('carries %s byte for byte', (_name, payload) => {
    const decoded = deserializeChunk(serializeResponseChunk(1, payload, false))

    expect(decoded.payload).toEqual(payload)
    expect(decoded.final).toBe(false)
  })

  it('treats a zero-length FINAL chunk as legal', () => {
    const decoded = deserializeChunk(serializeResponseChunk(1, new Uint8Array(0), true))

    expect(decoded.payload.byteLength).toBe(0)
    expect(decoded.final).toBe(true)
  })

  it('reports which kind of chunk it decoded', () => {
    expect(deserializeChunk(serializeRequestChunk(1, new Uint8Array(1), false)).frameType).toBe(
      FrameType.HTTP_REQUEST_CHUNK
    )
    expect(deserializeChunk(serializeResponseChunk(1, new Uint8Array(1), false)).frameType).toBe(
      FrameType.HTTP_RESPONSE_CHUNK
    )
  })

  it('rejects a declared payload over the cap before slicing', () => {
    // A peer may declare 4 GiB in this uint32 and carry ten bytes.
    const forged = new Uint8Array(20)
    forged[0] = FrameType.HTTP_RESPONSE_CHUNK
    new DataView(forged.buffer).setUint32(1, 1, false)
    new DataView(forged.buffer).setUint32(6, 0xffffffff, false)

    expect(() => deserializeChunk(forged)).toThrow(/Chunk too large/)
    try {
      deserializeChunk(forged)
      throw new Error('expected a protocol error')
    } catch (error) {
      expect((error as LemProxyError).code).toBe('E_TOO_LARGE')
    }
  })

  it('enforces the negotiated cap, not only the default', () => {
    const data = serializeResponseChunk(1, new Uint8Array(100), false)

    expect(deserializeChunk(data, 100).payload.byteLength).toBe(100)
    expect(() => deserializeChunk(data, 99)).toThrow(/Chunk too large/)
    expect(MAX_CHUNK_BYTES).toBe(49152)
  })

  it('rejects a chunk that declares more than it carries', () => {
    const forged = new Uint8Array(15)
    forged[0] = FrameType.HTTP_RESPONSE_CHUNK
    new DataView(forged.buffer).setUint32(1, 1, false)
    new DataView(forged.buffer).setUint32(6, 1000, false)

    expect(() => deserializeChunk(forged)).toThrow(/Insufficient data for payload/)
  })
})

describe('HTTP_CANCEL', () => {
  it('is seven bytes: type(1) request_id(4) reason_code(2)', () => {
    const buffer = serializeCancel(42, 1008)

    expect(buffer.byteLength).toBe(7)
    expect(new Uint8Array(buffer)[0]).toBe(FrameType.HTTP_CANCEL)
    expect(view(buffer).getUint32(1, false)).toBe(42)
    expect(view(buffer).getUint16(5, false)).toBe(1008)
  })

  it('round-trips', () => {
    expect(deserializeCancel(serializeCancel(9, 1007))).toEqual({
      requestId: 9,
      reasonCode: 1007,
    })
  })
})

describe('v2 detection', () => {
  const v2Response = new Uint8Array([0x02, 0, 0, 0, 42, 0, 200])

  it.each([
    ['request head', () => deserializeRequestHead(v2Response)],
    ['response head', () => deserializeResponseHead(v2Response)],
    ['chunk', () => deserializeChunk(v2Response)],
    ['cancel', () => deserializeCancel(v2Response)],
  ])('reports a reserved 0x02 frame as E_PROTO_V2_FRAME from %s', (_name, decode) => {
    try {
      decode()
      throw new Error('expected a protocol error')
    } catch (error) {
      expect(error).toBeInstanceOf(LemProxyError)
      expect((error as LemProxyError).code).toBe('E_PROTO_V2_FRAME')
      expect((error as LemProxyError).httpStatus).toBe(502)
    }
  })
})

describe('header encoding', () => {
  it('round-trips duplicates and order', () => {
    const headers: [string, string][] = [
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
      ['X', '1'],
    ]

    expect(decodeHeaders(encodeHeaders(headers))).toEqual(headers)
  })

  it('rejects a v2 JSON object', () => {
    const encoded = textEncoder.encode(JSON.stringify({ Accept: '*/*' }))

    expect(() => decodeHeaders(encoded)).toThrow(/JSON array/)
  })

  it.each([
    '[["a"]]',
    '[["a","b","c"]]',
    '[["a",1]]',
    '[[1,"b"]]',
    '["ab"]',
    '[[["a"],["b"]]]',
    '{oh no',
  ])('rejects malformed header payload %s', (payload) => {
    expect(() => decodeHeaders(textEncoder.encode(payload))).toThrow()
  })

  it('rejects a header block over the cap before slicing', () => {
    const head = new Uint8Array(
      serializeRequestHead({
        requestId: 1,
        method: 'GET',
        path: '/',
        headers: [],
        bodyFollows: false,
      })
    )
    // Overwrite headers_len with an absurd declaration.
    const headersLenOffset = head.byteLength - 4 - 2
    new DataView(head.buffer).setUint32(headersLenOffset, MAX_HEADERS_BYTES + 1, false)

    expect(() => deserializeRequestHead(head)).toThrow(/Headers too large/)
  })
})

describe('peek helpers', () => {
  it('reads request_id from bytes 1..4, not 0..3', () => {
    const buffer = serializeResponseChunk(0x01020304, new Uint8Array(0), true)

    expect(peekRequestId(buffer)).toBe(0x01020304)
    expect(view(buffer).getUint32(0, false)).not.toBe(0x01020304)
  })

  it('returns null for frames too short to carry the field', () => {
    expect(peekRequestId(new Uint8Array([1, 0, 0, 0]))).toBeNull()
    expect(peekFrameType(new Uint8Array(0))).toBeNull()
    expect(peekFrameType(new Uint8Array([3]))).toBe(3)
  })
})
