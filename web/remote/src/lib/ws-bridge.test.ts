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
 * `window.__lemWsBridge`: the object a framed app's shim calls into.
 *
 * The shim's side of this contract is exercised in a real second realm in
 * `sw-shim.test.ts`. What is asserted here is the bridge's own lifecycle -
 * install, uninstall, and the belt-and-braces push into a frame - and the
 * mapping from `ProxiedWebSocket` events onto the sink the shim registers.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { attachWsBridgeToFrame, createWsBridge, installWsBridge } from './ws-bridge'
import type { WsBridgeSink } from './ws-bridge'
import { WSProxyManager } from './ws-proxy'
import type { Transport } from './proxy-fetch'
import { WSOpcode, serializeWSClose, serializeWSConnectAck, serializeWSData } from './ws-frame'
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

function recordingSink(): { sink: WsBridgeSink; events: string[] } {
  const events: string[] = []
  return {
    events,
    sink: {
      open: (protocol) => events.push(`open:${protocol}`),
      message: (data) => events.push(`message:${typeof data === 'string' ? data : 'binary'}`),
      error: () => events.push('error'),
      close: (code, reason, wasClean) => events.push(`close:${code}:${reason}:${String(wasClean)}`),
    },
  }
}

afterEach(() => {
  delete window.__lemWsBridge
})

describe('installWsBridge', () => {
  it('publishes the bridge and takes it away again', () => {
    const manager = new WSProxyManager(new StubTransport())

    const uninstall = installWsBridge(manager, window)
    expect(typeof window.__lemWsBridge?.connect).toBe('function')

    uninstall()
    expect(window.__lemWsBridge).toBeUndefined()
  })

  it('does not remove a bridge a later install replaced it with', () => {
    const first = installWsBridge(new WSProxyManager(new StubTransport()), window)
    installWsBridge(new WSProxyManager(new StubTransport()), window)

    first()

    expect(window.__lemWsBridge).toBeDefined()
  })
})

describe('the bridge connection', () => {
  it('opens a proxied socket and reports the negotiated protocol', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const bridge = createWsBridge(manager)
    const { sink, events } = recordingSink()

    bridge.connect('wss://dashboard.lem.test/socket', 'chat', sink)
    await Promise.resolve()

    expect(transport.frameTypes()).toEqual([FrameType.WS_CONNECT])
    manager.handleFrame(serializeWSConnectAck({ connectionId: 1, protocol: 'chat' }))

    expect(events).toEqual(['open:chat'])
  })

  it('hands inbound binary to the shim as an ArrayBuffer, never a Blob', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const bridge = createWsBridge(manager)
    const seen: unknown[] = []

    bridge.connect('wss://dashboard.lem.test/socket', undefined, {
      open: () => undefined,
      message: (data) => seen.push(data),
      error: () => undefined,
      close: () => undefined,
    })
    await Promise.resolve()
    manager.handleFrame(serializeWSConnectAck({ connectionId: 1, protocol: '' }))
    manager.handleFrame(
      serializeWSData({
        connectionId: 1,
        opcode: WSOpcode.BINARY,
        payload: new Uint8Array([1, 2, 3]),
        fin: true,
      })
    )

    // A Blob built here carries this realm's constructor, and an app in the
    // frame that checks `data instanceof Blob` would say no. The frame wraps
    // it in its own Blob instead.
    expect(seen).toHaveLength(1)
    expect(seen[0] instanceof ArrayBuffer).toBe(true)
    expect([...new Uint8Array(seen[0] as ArrayBuffer)]).toEqual([1, 2, 3])
  })

  it('relays close code, reason and cleanliness', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const bridge = createWsBridge(manager)
    const { sink, events } = recordingSink()

    bridge.connect('wss://dashboard.lem.test/socket', undefined, sink)
    await Promise.resolve()
    manager.handleFrame(serializeWSConnectAck({ connectionId: 1, protocol: '' }))
    manager.handleFrame(serializeWSClose({ connectionId: 1, closeCode: 1000, reason: 'bye' }))

    expect(events).toEqual(['open:', 'close:1000:bye:true'])
  })

  it('sends and closes through the handle it returns', async () => {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    const bridge = createWsBridge(manager)
    const { sink } = recordingSink()

    const handle = bridge.connect('wss://dashboard.lem.test/socket', undefined, sink)
    await Promise.resolve()
    manager.handleFrame(serializeWSConnectAck({ connectionId: 1, protocol: '' }))
    handle.send('hello')
    handle.close(1000, 'done')

    expect(transport.frameTypes()).toEqual([
      FrameType.WS_CONNECT,
      FrameType.WS_DATA,
      FrameType.WS_CLOSE,
    ])
  })
})

describe('attachWsBridgeToFrame', () => {
  it('pushes the installed bridge into a frame that asked for one', () => {
    const manager = new WSProxyManager(new StubTransport())
    installWsBridge(manager, window)

    const frame = document.createElement('iframe')
    document.body.append(frame)
    const view = frame.contentWindow as unknown as { __lemAttachWsBridge?: (b: unknown) => void }
    const received: unknown[] = []
    view.__lemAttachWsBridge = (value) => received.push(value)

    attachWsBridgeToFrame(frame, window)

    expect(received).toEqual([window.__lemWsBridge])
    frame.remove()
  })

  it('does nothing when there is no bridge to push', () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const view = frame.contentWindow as unknown as { __lemAttachWsBridge?: (b: unknown) => void }
    let called = 0
    view.__lemAttachWsBridge = () => {
      called += 1
    }

    attachWsBridgeToFrame(frame, window)

    expect(called).toBe(0)
    frame.remove()
  })

  it('does nothing when the frame never installed the hook', () => {
    installWsBridge(new WSProxyManager(new StubTransport()), window)
    const frame = document.createElement('iframe')
    document.body.append(frame)

    expect(() => attachWsBridgeToFrame(frame, window)).not.toThrow()
    frame.remove()
  })
})
