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
 * Tests for the proxied WebSocket shim.
 *
 * The v3 defect these close: nothing ever called `handleConnectionOpened()`,
 * there was no ack frame, `readyState` stayed CONNECTING forever and every
 * `send()` threw. Anything waiting on `onopen` - socket.io, Ollama streaming -
 * hung indefinitely.
 *
 * F-COR-9 (event timing) and F-STD-5 (transport swap) are still asserted here.
 */

/// <reference types="vitest/globals" />

import { describe, it, expect, vi } from 'vitest'
import { WSProxyManager } from './ws-proxy'
import type { Transport } from './proxy-fetch'
import {
  MAX_WS_MESSAGE_BYTES,
  WSOpcode,
  deserializeWSData,
  serializeWSClose,
  serializeWSConnectAck,
  serializeWSConnectError,
  serializeWSData,
} from './ws-frame'
import { FrameType } from './http-frame'

class StubTransport implements Transport {
  open = true
  readonly sent: ArrayBuffer[] = []

  sendData(data: ArrayBuffer): void {
    this.sent.push(data)
  }

  isOpen(): boolean {
    return this.open
  }

  frameTypes(): number[] {
    return this.sent.map((frame) => new Uint8Array(frame)[0])
  }
}

function ack(connectionId: number, protocol = ''): ArrayBuffer {
  return serializeWSConnectAck({ connectionId, protocol })
}

describe('ProxiedWebSocket', () => {
  // F-COR-9: the constructor used to dispatch error/close synchronously, so a
  // handler assigned on the very next line could never see them.
  it('delivers a connect-time error to a handler assigned after construction', async () => {
    const transport = new StubTransport()
    transport.open = false
    const manager = new WSProxyManager(transport)

    const seen: string[] = []
    const ws = manager.createConnection('ws://localhost:3000/socket')
    ws.onerror = () => seen.push('error')
    ws.onclose = () => seen.push('close')

    expect(seen).toEqual([])
    await Promise.resolve()

    expect(seen).toEqual(['error', 'close'])
    expect(ws.readyState).toBe(3)
  })

  it('sends a WS_CONNECT frame once the microtask runs', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)

    manager.createConnection('ws://localhost:3000/socket')
    expect(transport.sent).toHaveLength(0)

    await Promise.resolve()
    expect(transport.frameTypes()).toEqual([FrameType.WS_CONNECT])
  })

  // The headline fix: this is what "onopen never fires" looked like.
  it('reaches OPEN and fires onopen when the ack arrives', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket', 'chat')
    await Promise.resolve()

    expect(ws.readyState).toBe(0)
    let opened = false
    ws.onopen = () => {
      opened = true
    }

    manager.handleFrame(ack(1, 'chat'))

    expect(opened).toBe(true)
    expect(ws.readyState).toBe(1)
    expect(ws.protocol).toBe('chat')
  })

  // Real apps call send() in the same turn as the constructor.
  it('buffers sends made before the ack and flushes them after', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()

    expect(() => ws.send('early-1')).not.toThrow()
    ws.send('early-2')
    expect(transport.frameTypes()).toEqual([FrameType.WS_CONNECT])

    manager.handleFrame(ack(1))

    const dataFrames = transport.sent.slice(1).map((frame) => deserializeWSData(frame))
    expect(dataFrames.map((frame) => new TextDecoder().decode(frame.payload))).toEqual([
      'early-1',
      'early-2',
    ])
  })

  it('fails fast on WS_CONNECT_ERROR instead of waiting out the timeout', async () => {
    vi.useFakeTimers()
    try {
      const transport = new StubTransport()
      const manager = new WSProxyManager(transport)
      const ws = manager.createConnection('ws://localhost:3000/socket')
      await Promise.resolve()

      const events: string[] = []
      let closeCode = 0
      ws.onerror = () => events.push('error')
      ws.onclose = (event) => {
        events.push('close')
        closeCode = event.code
      }

      manager.handleFrame(
        serializeWSConnectError({ connectionId: 1, errorCode: 1011, reason: 'Connection failed' })
      )

      expect(events).toEqual(['error', 'close'])
      expect(closeCode).toBe(1011)
      expect(ws.readyState).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes with 4003 when no ack arrives in time', async () => {
    vi.useFakeTimers()
    try {
      const transport = new StubTransport()
      const manager = new WSProxyManager(transport)
      const ws = manager.createConnection('ws://localhost:3000/socket')
      await Promise.resolve()

      let closeCode = 0
      ws.onclose = (event) => {
        closeCode = event.code
      }

      await vi.advanceTimersByTimeAsync(10_000)

      expect(closeCode).toBe(4003)
      expect(ws.readyState).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps Blob and string sends in call order', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket')

    await Promise.resolve()
    manager.handleFrame(ack(1))
    transport.sent.length = 0

    // A Blob has to be read asynchronously; the string that follows must not
    // overtake it on the wire.
    ws.send(new Blob([new Uint8Array([1, 2, 3])]))
    ws.send('after-the-blob')

    await vi.waitFor(() => {
      expect(transport.sent).toHaveLength(2)
    })

    const frames = transport.sent.map((frame) => deserializeWSData(frame))
    expect(frames[0].opcode).toBe(WSOpcode.BINARY)
    expect(frames[0].payload).toEqual(new Uint8Array([1, 2, 3]))
    expect(frames[1].opcode).toBe(WSOpcode.TEXT)
    expect(new TextDecoder().decode(frames[1].payload)).toBe('after-the-blob')
  })

  it('throws on send after close, matching the platform WebSocket', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()
    manager.handleFrame(ack(1))

    ws.close()

    expect(() => ws.send('too late')).toThrow(/CLOSING or CLOSED/)
  })

  // v2 synthesised the close event locally and immediately, telling the app the
  // socket was closed while the upstream was still being torn down.
  it('waits for the peer WS_CLOSE rather than synthesising one', async () => {
    vi.useFakeTimers()
    try {
      const transport = new StubTransport()
      const manager = new WSProxyManager(transport)
      const ws = manager.createConnection('ws://localhost:3000/socket')
      await Promise.resolve()
      manager.handleFrame(ack(1))

      let closed = false
      ws.onclose = () => {
        closed = true
      }

      ws.close(1000, 'bye')
      expect(closed).toBe(false)
      expect(ws.readyState).toBe(2)

      manager.handleFrame(serializeWSClose({ connectionId: 1, closeCode: 1000, reason: 'bye' }))
      expect(closed).toBe(true)
      expect(ws.readyState).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up waiting for the peer close after the timeout', async () => {
    vi.useFakeTimers()
    try {
      const transport = new StubTransport()
      const manager = new WSProxyManager(transport)
      const ws = manager.createConnection('ws://localhost:3000/socket')
      await Promise.resolve()
      manager.handleFrame(ack(1))

      ws.close()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(ws.readyState).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fragments an outbound message larger than the negotiated chunk size', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    manager.setNegotiatedLimits(16)
    const ws = manager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()
    manager.handleFrame(ack(1))
    transport.sent.length = 0

    ws.send('x'.repeat(40))

    const frames = transport.sent.map((frame) => deserializeWSData(frame, 16))
    expect(frames.length).toBe(3)
    expect(frames[0].opcode).toBe(WSOpcode.TEXT)
    expect(frames[0].fin).toBe(false)
    expect(frames[1].opcode).toBe(WSOpcode.CONTINUATION)
    expect(frames[2].fin).toBe(true)
    expect(frames.reduce((sum, frame) => sum + frame.payload.byteLength, 0)).toBe(40)
  })

  it('reassembles a fragmented inbound message', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()
    manager.handleFrame(ack(1))

    const received: unknown[] = []
    ws.onmessage = (event) => received.push(event.data)

    const encoder = new TextEncoder()
    manager.handleFrame(
      serializeWSData({
        connectionId: 1,
        opcode: WSOpcode.TEXT,
        payload: encoder.encode('hel'),
        fin: false,
      })
    )
    expect(received).toEqual([])

    manager.handleFrame(
      serializeWSData({
        connectionId: 1,
        opcode: WSOpcode.CONTINUATION,
        payload: encoder.encode('lo '),
        fin: false,
      })
    )
    manager.handleFrame(
      serializeWSData({
        connectionId: 1,
        opcode: WSOpcode.CONTINUATION,
        payload: encoder.encode('there'),
        fin: true,
      })
    )

    expect(received).toEqual(['hello there'])
  })

  it('bounds reassembly and closes with 4005', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()
    manager.handleFrame(ack(1))

    let closeCode = 0
    ws.onclose = (event) => {
      closeCode = event.code
    }

    const chunkBytes = new Uint8Array(40 * 1024)
    manager.handleFrame(
      serializeWSData({ connectionId: 1, opcode: WSOpcode.BINARY, payload: chunkBytes, fin: false })
    )
    for (let sent = chunkBytes.byteLength; sent <= MAX_WS_MESSAGE_BYTES; sent += 40 * 1024) {
      manager.handleFrame(
        serializeWSData({
          connectionId: 1,
          opcode: WSOpcode.CONTINUATION,
          payload: chunkBytes,
          fin: false,
        })
      )
      if (closeCode !== 0) break
    }

    expect(closeCode).toBe(4005)
  })
})

describe('WSProxyManager', () => {
  // F-STD-5: this used to force a RelayClient into a WebRTC-typed field and
  // write another object's private property behind two @ts-expect-errors.
  it('repoints live connections at a new transport', async () => {
    const webrtc = new StubTransport()
    const relay = new StubTransport()
    const manager = new WSProxyManager(webrtc)

    const ws = manager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()
    manager.handleFrame(ack(1))

    manager.updateTransport(relay)
    ws.send('over-the-relay')

    expect(relay.sent).toHaveLength(1)
    expect(webrtc.sent).toHaveLength(1) // only the original WS_CONNECT
  })

  it('routes data frames to the matching connection', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()
    manager.handleFrame(ack(1))

    ws.binaryType = 'arraybuffer'
    const received: unknown[] = []
    ws.onmessage = (event) => received.push(event.data)

    transport.sent.length = 0
    ws.send('echo')
    manager.handleFrame(transport.sent[0])

    expect(received).toEqual(['echo'])
  })

  it('does not claim frames that belong to the HTTP proxy', () => {
    const manager = new WSProxyManager(new StubTransport())
    const httpFrame = new Uint8Array([FrameType.HTTP_RESPONSE_HEAD, 0, 0, 0, 1])

    expect(manager.handleFrame(httpFrame.buffer)).toBe(false)
  })
})
