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
 * Tests for the proxied WebSocket shim (F-COR-9 event timing, ordered sends).
 */

import { describe, it, expect, vi } from 'vitest'
import { WSProxyManager } from './ws-proxy'
import type { Transport } from './proxy-fetch'
import { deserializeWSData, WSOpcode } from './ws-frame'

class StubTransport implements Transport {
  open = true
  readonly sent: ArrayBuffer[] = []

  sendData(data: ArrayBuffer): void {
    this.sent.push(data)
  }

  isOpen(): boolean {
    return this.open
  }
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
    expect(transport.sent).toHaveLength(1)
  })

  it('keeps Blob and string sends in call order', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket')

    await Promise.resolve()
    manager.handleConnectionOpened(1)
    transport.sent.length = 0

    // A Blob has to be read asynchronously; the string that follows must not
    // overtake it on the wire.
    ws.send(new Blob([new Uint8Array([1, 2, 3])]))
    ws.send('after-the-blob')

    await vi.waitFor(() => {
      expect(transport.sent).toHaveLength(2)
    })

    const frames = transport.sent.map(deserializeWSData)
    expect(frames[0].opcode).toBe(WSOpcode.BINARY)
    expect(new Uint8Array(frames[0].payload)).toEqual(new Uint8Array([1, 2, 3]))
    expect(frames[1].opcode).toBe(WSOpcode.TEXT)
    expect(new TextDecoder().decode(frames[1].payload)).toBe('after-the-blob')
  })

  it('rejects sends before the connection opens', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const ws = manager.createConnection('ws://localhost:3000/socket')
    await Promise.resolve()

    expect(() => ws.send('nope')).toThrow('WebSocket is not open')
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
    manager.handleConnectionOpened(1)

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
    manager.handleConnectionOpened(1)

    ws.binaryType = 'arraybuffer'
    const received: unknown[] = []
    ws.onmessage = (event) => received.push(event.data)

    transport.sent.length = 0
    ws.send('echo')
    manager.handleDataFrame(transport.sent[0])

    expect(received).toEqual(['echo'])
  })
})
