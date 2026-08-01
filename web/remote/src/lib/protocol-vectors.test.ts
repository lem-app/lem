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
 * Cross-language golden vectors for tunnel protocol v3.
 *
 * `protocol/tunnel-v3.json` is the contract. This suite and
 * `server/tests/tunnel/test_protocol_vectors.py` decode every vector in it and
 * re-encode it to the identical bytes, so the TypeScript and Python codecs
 * cannot drift apart. They already did once: FrameType diverged between them in
 * v1 to v2, and the suite stayed red for months because each side was
 * internally consistent and wrong about the other.
 */

// The contract lives at the repo root, outside this project, so it is read
// from disk rather than imported: a copy inside web/remote would defeat the
// entire point of a single shared file. `@types/node` is already a
// devDependency; this reference keeps it scoped to this one test file rather
// than handing node globals to the whole app.
/// <reference types="node" />

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as hf from './http-frame'
import * as wf from './ws-frame'
import { HTTP_STATUS_FOR_ERROR, TunnelErrorCode } from './tunnel-errors'

// Relative to the vitest root (web/remote), which is also CI's working
// directory for this project. `import.meta.url` is an http:// URL under Vite,
// so it cannot be used to reach the repo root.
const VECTOR_PATH = resolve(process.cwd(), '../../protocol/tunnel-v3.json')

interface Vector {
  name: string
  kind: string
  hex: string
  frame: Record<string, unknown>
}

interface Contract {
  protocol_version: number
  frame_types: Record<string, number>
  flags: Record<string, number>
  limits: Record<string, number>
  error_codes: Record<string, number>
  http_status_for_error: Record<string, number>
  vectors: Vector[]
}

const CONTRACT = JSON.parse(readFileSync(VECTOR_PATH, 'utf-8')) as Contract

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let index = 0; index < out.length; index += 1) {
    out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return out
}

function bytesToHex(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function pairs(raw: unknown): hf.HeaderList {
  return (raw as [string, string][]).map(([name, value]) => [name, value])
}

function encode(vector: Vector): ArrayBuffer {
  const frame = vector.frame

  switch (vector.kind) {
    case 'hello':
      return hf.serializeHello({
        protocolVersion: frame.protocol_version as number,
        flags: frame.flags as number,
        maxChunkBytes: frame.max_chunk_bytes as number,
        maxBodyBytes: frame.max_body_bytes as number,
        impl: frame.impl as string,
      })
    case 'request_head':
      return hf.serializeRequestHead({
        requestId: frame.request_id as number,
        method: frame.method as string,
        path: frame.path as string,
        headers: pairs(frame.headers),
        bodyFollows: frame.body_follows as boolean,
      })
    case 'response_head':
      return hf.serializeResponseHead({
        requestId: frame.request_id as number,
        statusCode: frame.status_code as number,
        headers: pairs(frame.headers),
        bodyFollows: frame.body_follows as boolean,
      })
    case 'chunk': {
      const payload = hexToBytes(frame.payload_hex as string)
      return frame.frame_type === hf.FrameType.HTTP_REQUEST_CHUNK
        ? hf.serializeRequestChunk(frame.request_id as number, payload, frame.final as boolean)
        : hf.serializeResponseChunk(frame.request_id as number, payload, frame.final as boolean)
    }
    case 'cancel':
      return hf.serializeCancel(frame.request_id as number, frame.reason_code as number)
    case 'ws_connect':
      return wf.serializeWSConnect({
        connectionId: frame.connection_id as number,
        url: frame.url as string,
        headers: pairs(frame.headers),
      })
    case 'ws_data':
      return wf.serializeWSData({
        connectionId: frame.connection_id as number,
        opcode: frame.opcode as wf.WSOpcodeValue,
        payload: hexToBytes(frame.payload_hex as string),
        fin: frame.fin as boolean,
      })
    case 'ws_close':
      return wf.serializeWSClose({
        connectionId: frame.connection_id as number,
        closeCode: frame.close_code as number,
        reason: frame.reason as string,
      })
    case 'ws_connect_ack':
      return wf.serializeWSConnectAck({
        connectionId: frame.connection_id as number,
        protocol: frame.protocol as string,
      })
    case 'ws_connect_error':
      return wf.serializeWSConnectError({
        connectionId: frame.connection_id as number,
        errorCode: frame.error_code as number,
        reason: frame.reason as string,
      })
    default:
      throw new Error(`Unknown vector kind: ${vector.kind}`)
  }
}

function decode(vector: Vector): Record<string, unknown> {
  const data = hexToBytes(vector.hex)

  switch (vector.kind) {
    case 'hello':
      return hf.deserializeHello(data) as unknown as Record<string, unknown>
    case 'request_head':
      return hf.deserializeRequestHead(data) as unknown as Record<string, unknown>
    case 'response_head':
      return hf.deserializeResponseHead(data) as unknown as Record<string, unknown>
    case 'chunk':
      return hf.deserializeChunk(data) as unknown as Record<string, unknown>
    case 'cancel':
      return hf.deserializeCancel(data) as unknown as Record<string, unknown>
    case 'ws_connect':
      return wf.deserializeWSConnect(data) as unknown as Record<string, unknown>
    case 'ws_data':
      return wf.deserializeWSData(data) as unknown as Record<string, unknown>
    case 'ws_close':
      return wf.deserializeWSClose(data) as unknown as Record<string, unknown>
    case 'ws_connect_ack':
      return wf.deserializeWSConnectAck(data) as unknown as Record<string, unknown>
    case 'ws_connect_error':
      return wf.deserializeWSConnectError(data) as unknown as Record<string, unknown>
    default:
      throw new Error(`Unknown vector kind: ${vector.kind}`)
  }
}

/** Map a snake_case contract field to its camelCase codec field. */
const FIELD_ALIASES: Record<string, string> = {
  protocol_version: 'protocolVersion',
  max_chunk_bytes: 'maxChunkBytes',
  max_body_bytes: 'maxBodyBytes',
  request_id: 'requestId',
  body_follows: 'bodyFollows',
  status_code: 'statusCode',
  frame_type: 'frameType',
  reason_code: 'reasonCode',
  connection_id: 'connectionId',
  close_code: 'closeCode',
  error_code: 'errorCode',
}

describe('protocol/tunnel-v3.json contract', () => {
  it('is present where both suites look for it', () => {
    expect(CONTRACT.vectors.length).toBeGreaterThan(0)
  })

  it('pins the protocol version', () => {
    expect(CONTRACT.protocol_version).toBe(hf.PROTOCOL_VERSION)
  })

  // The exact assertion that would have caught the v1-to-v2 drift.
  it('pins every frame type number by name', () => {
    expect(CONTRACT.frame_types).toEqual({
      HELLO: hf.FrameType.HELLO,
      HTTP_REQUEST_HEAD: hf.FrameType.HTTP_REQUEST_HEAD,
      HTTP_RESPONSE_V2_RESERVED: hf.FrameType.HTTP_RESPONSE_V2_RESERVED,
      HTTP_RESPONSE_HEAD: hf.FrameType.HTTP_RESPONSE_HEAD,
      HTTP_RESPONSE_CHUNK: hf.FrameType.HTTP_RESPONSE_CHUNK,
      HTTP_CANCEL: hf.FrameType.HTTP_CANCEL,
      HTTP_REQUEST_CHUNK: hf.FrameType.HTTP_REQUEST_CHUNK,
      WS_CONNECT: hf.FrameType.WS_CONNECT,
      WS_DATA: hf.FrameType.WS_DATA,
      WS_CLOSE: hf.FrameType.WS_CLOSE,
      WS_CONNECT_ACK: hf.FrameType.WS_CONNECT_ACK,
      WS_CONNECT_ERROR: hf.FrameType.WS_CONNECT_ERROR,
    })
  })

  it('pins the flag bits', () => {
    expect(CONTRACT.flags).toEqual({
      BODY_FOLLOWS: hf.FLAG_BODY_FOLLOWS,
      FINAL: hf.FLAG_FINAL,
      FIN: wf.FLAG_FIN,
    })
  })

  it('pins the caps', () => {
    expect(CONTRACT.limits.MAX_BODY_BYTES).toBe(hf.MAX_BODY_BYTES)
    expect(CONTRACT.limits.MAX_HEADERS_BYTES).toBe(hf.MAX_HEADERS_BYTES)
    expect(CONTRACT.limits.MAX_CHUNK_BYTES).toBe(hf.MAX_CHUNK_BYTES)
    expect(CONTRACT.limits.MAX_URL_BYTES).toBe(hf.MAX_URL_BYTES)
    expect(CONTRACT.limits.MAX_INFLIGHT_REQUESTS).toBe(hf.MAX_INFLIGHT_REQUESTS)
    expect(CONTRACT.limits.MAX_WS_MESSAGE_BYTES).toBe(wf.MAX_WS_MESSAGE_BYTES)
  })

  it('pins the error taxonomy shared with the server', () => {
    expect(CONTRACT.error_codes).toEqual(TunnelErrorCode)
    expect(CONTRACT.http_status_for_error).toEqual(HTTP_STATUS_FOR_ERROR)
  })

  it('keeps every cancel reason inside the uint16 field', () => {
    Object.values(CONTRACT.error_codes).forEach((code) => {
      expect(code).toBeGreaterThanOrEqual(0)
      expect(code).toBeLessThanOrEqual(0xffff)
    })
  })
})

describe('golden vectors', () => {
  CONTRACT.vectors.forEach((vector) => {
    it(`${vector.name} encodes to the golden bytes`, () => {
      expect(bytesToHex(encode(vector))).toBe(vector.hex)
    })

    it(`${vector.name} decodes to the declared fields`, () => {
      const decoded = decode(vector)

      Object.entries(vector.frame).forEach(([key, expected]) => {
        if (key === 'payload_hex') {
          expect(bytesToHex(decoded.payload as Uint8Array)).toBe(expected)
          return
        }
        if (key === 'headers') {
          expect(decoded.headers).toEqual(pairs(expected))
          return
        }
        const field = FIELD_ALIASES[key] ?? key
        expect(decoded[field]).toEqual(expected)
      })
    })

    it(`${vector.name} round-trips`, () => {
      const decoded = decode(vector)
      let reencoded: ArrayBuffer

      switch (vector.kind) {
        case 'hello':
          reencoded = hf.serializeHello(decoded as unknown as hf.HelloFrame)
          break
        case 'request_head':
          reencoded = hf.serializeRequestHead(decoded as unknown as hf.HTTPRequestHeadFrame)
          break
        case 'response_head':
          reencoded = hf.serializeResponseHead(decoded as unknown as hf.HTTPResponseHeadFrame)
          break
        case 'chunk': {
          const chunk = decoded as unknown as hf.HTTPChunkFrame
          reencoded =
            chunk.frameType === hf.FrameType.HTTP_REQUEST_CHUNK
              ? hf.serializeRequestChunk(chunk.requestId, chunk.payload, chunk.final)
              : hf.serializeResponseChunk(chunk.requestId, chunk.payload, chunk.final)
          break
        }
        case 'cancel': {
          const cancel = decoded as unknown as hf.HTTPCancelFrame
          reencoded = hf.serializeCancel(cancel.requestId, cancel.reasonCode)
          break
        }
        case 'ws_connect':
          reencoded = wf.serializeWSConnect(decoded as unknown as wf.WSConnectFrame)
          break
        case 'ws_data':
          reencoded = wf.serializeWSData(decoded as unknown as wf.WSDataFrame)
          break
        case 'ws_close':
          reencoded = wf.serializeWSClose(decoded as unknown as wf.WSCloseFrame)
          break
        case 'ws_connect_ack':
          reencoded = wf.serializeWSConnectAck(decoded as unknown as wf.WSConnectAckFrame)
          break
        case 'ws_connect_error':
          reencoded = wf.serializeWSConnectError(decoded as unknown as wf.WSConnectErrorFrame)
          break
        default:
          throw new Error(`Unknown vector kind: ${vector.kind}`)
      }

      expect(bytesToHex(reencoded)).toBe(vector.hex)
    })
  })

  it('covers every frame type that is ever serialized', () => {
    const covered = new Set(CONTRACT.vectors.map((vector) => hexToBytes(vector.hex)[0]))
    const expected = Object.entries(hf.FrameType)
      // 0x02 is reserved and never serialized by design.
      .filter(([name]) => name !== 'HTTP_RESPONSE_V2_RESERVED')
      .map(([, code]) => code)

    expected.forEach((code) => {
      expect(covered.has(code)).toBe(true)
    })
  })
})

describe('header JSON encoding', () => {
  // Python's json.dumps pads separators with a space and escapes non-ASCII as
  // \uXXXX; JSON.stringify does neither. Left at Python's defaults the two
  // codecs emit different bytes for the same headers - still mutually
  // decodable, but no longer byte-identical, which silently voids every golden
  // vector above.
  it('matches the compact, unescaped form the server also emits', () => {
    const encoded = hf.encodeHeaders([
      ['X-Title', 'café ✓'],
      ['Accept', 'application/json'],
    ])
    const text = new TextDecoder().decode(encoded)

    expect(text).toBe('[["X-Title","café ✓"],["Accept","application/json"]]')
    expect(text).not.toContain(', ')
    expect(text).not.toContain('\\u')
  })
})
