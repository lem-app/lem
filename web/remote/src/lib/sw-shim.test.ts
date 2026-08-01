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
 * The WebSocket shim: where it is spliced, and what it does once it runs.
 *
 * Two halves, and the second is the one that matters:
 *
 * - **The splice** is asserted by *parsing* the delivered bytes, never by
 *   looking at them. "The shim is the first `<script>`" is a fact about the
 *   parsed document, and a string comparison would pass for a shim spliced into
 *   a comment.
 * - **The shim itself** is evaluated in a real second realm - a live `iframe`
 *   window - with the bridge installed on the parent, exactly as it ships.
 *   Every cross-realm hazard this design has (`instanceof` against the wrong
 *   `Blob`, a `window.parent` that is not the dashboard) is therefore real in
 *   these tests rather than modelled.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  HTML_SNIFF_BYTES,
  SHIM_MARKER_ATTRIBUTE,
  WS_SHIM_SOURCE,
  createShimInjector,
  findShimInsertionPoint,
} from '../../public/lem-app-sw.js'
import { WSProxyManager } from './ws-proxy'
import { installWsBridge } from './ws-bridge'
import type { Transport } from './proxy-fetch'
import { WSOpcode, deserializeWSData, serializeWSConnectAck, serializeWSData } from './ws-frame'
import { FrameType } from './http-frame'

// -- helpers -----------------------------------------------------------------

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

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Push a document through the injector in chunks of `size` bytes. */
async function inject(
  html: string | Uint8Array,
  size = Number.MAX_SAFE_INTEGER,
  onSkipped?: () => void
): Promise<string> {
  const bytes = typeof html === 'string' ? encoder.encode(html) : html
  const injector = createShimInjector(onSkipped)

  const writer = injector.writable.getWriter()
  const written = (async () => {
    for (let offset = 0; offset < bytes.byteLength; offset += size) {
      await writer.write(bytes.slice(offset, Math.min(offset + size, bytes.byteLength)))
    }
    await writer.close()
  })()

  const parts: Uint8Array[] = []
  const reader = injector.readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  await written

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.byteLength
  }
  return decoder.decode(out)
}

/** Parse the delivered document and return its `<script>` elements. */
function scriptsOf(html: string): HTMLScriptElement[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return [...parsed.querySelectorAll('script')]
}

// -- where the shim is spliced ----------------------------------------------

describe('the shim source', () => {
  it('carries nothing that would break the element it is spliced into', () => {
    // `</script` anywhere in the source ends the element early, leaving the
    // rest of the shim as text in the document. A backtick would break the
    // template literal that carries it.
    expect(WS_SHIM_SOURCE).not.toContain('</script')
    expect(WS_SHIM_SOURCE).not.toContain('`')
  })

  it('never constructs a native WebSocket as a fallback', () => {
    // A native socket from the framed document would connect from the *remote*
    // browser's own network, which is defect #1 of issue #6 wearing a hat.
    expect(WS_SHIM_SOURCE).not.toMatch(/new\s+NativeWebSocket/)
  })
})

describe('splicing the shim into a document', () => {
  it('makes it the first script in the document, by parse not by string', async () => {
    const delivered = await inject(
      '<!doctype html><html><head><meta charset="utf-8">' +
        '<script src="/app.js"></' +
        'script></head><body>hi</body></html>'
    )

    const scripts = scriptsOf(delivered)

    expect(scripts.length).toBe(2)
    expect(scripts[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
    expect(scripts[0].textContent).toBe(WS_SHIM_SOURCE)
    expect(scripts[1].getAttribute('src')).toBe('/app.js')
  })

  it('goes first even when the app has no <head> at all', async () => {
    const delivered = await inject(
      '<!doctype html><html><body><script>window.boot=1</' + 'script></body></html>'
    )

    const scripts = scriptsOf(delivered)

    expect(scripts[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
    expect(scripts[1].textContent).toBe('window.boot=1')
  })

  it('keeps the doctype ahead of itself, so the document stays in standards mode', async () => {
    const delivered = await inject('<!DOCTYPE html><html><body><p>hi</p></body></html>')

    expect(delivered.slice(0, 15).toUpperCase()).toBe('<!DOCTYPE HTML>')
    const parsed = new DOMParser().parseFromString(delivered, 'text/html')
    expect(parsed.doctype?.name).toBe('html')
  })

  it('survives a BOM and an XML declaration ahead of the doctype', async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    const rest = encoder.encode(
      '<?xml version="1.0" encoding="UTF-8"?><!doctype html><html><head></head>' +
        '<body><script>1</' +
        'script></body></html>'
    )
    const source = new Uint8Array(bom.byteLength + rest.byteLength)
    source.set(bom, 0)
    source.set(rest, bom.byteLength)

    const delivered = await inject(source)

    expect(delivered).toContain('<?xml version="1.0" encoding="UTF-8"?><!doctype html>')
    expect(delivered.indexOf('<?xml')).toBeLessThan(delivered.indexOf(SHIM_MARKER_ATTRIBUTE))
    expect(scriptsOf(delivered)[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
  })

  it('leaves a <base> in the head intact, and still runs before it matters', async () => {
    const delivered = await inject(
      '<!doctype html><html><head><base href="/app/dev-7f3a/webui/">' +
        '<script src="rel.js"></' +
        'script></head><body></body></html>'
    )

    const parsed = new DOMParser().parseFromString(delivered, 'text/html')
    const base = parsed.querySelector('base')

    expect(base?.getAttribute('href')).toBe('/app/dev-7f3a/webui/')
    // The shim resolves URLs at `new WebSocket(...)` time, long after parsing,
    // so sitting ahead of <base> costs nothing - but <base> must survive.
    expect(scriptsOf(delivered)[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
  })

  it('is not fooled by a <head> that only appears inside a comment', async () => {
    const delivered = await inject(
      '<!doctype html><!-- <head> is not here --><html><head></head>' +
        '<body><script>1</' +
        'script></body></html>'
    )

    const parsed = new DOMParser().parseFromString(delivered, 'text/html')

    // Spliced into the real head, not into the comment.
    expect(parsed.querySelector(`head > script[${SHIM_MARKER_ATTRIBUTE}]`)).not.toBeNull()
    expect(delivered).toContain('<!-- <head> is not here -->')
  })

  // The scanner used to advance one byte at a time past any tag it did not
  // recognise, so it never left `<html …>` and read markup inside that tag's
  // own quoted attribute as real. The splice landed inside the quotes: the
  // document was corrupted, the shim never became a script, and - because the
  // "no native WebSocket fallback" rule lives only in the shim's own JS -
  // `window.WebSocket` stayed native. That is issue #6's defect #1 returning
  // silently, on nothing more than a byte pattern in someone's `data-*`.
  it.each([
    {
      label: 'a data-* attribute holding example markup',
      html:
        '<!doctype html><html lang="en" data-x="<head>fake</head>">' +
        '<head><title>Real</title></head><body>hi</body></html>',
      attribute: '<head>fake</head>',
    },
    {
      label: 'a single-quoted attribute',
      html:
        "<!doctype html><html data-x='<head>fake'>" +
        '<head><title>Real</title></head><body>hi</body></html>',
      attribute: '<head>fake',
    },
    {
      label: 'an attribute holding a whole fake document',
      html:
        '<!doctype html><html data-tpl="<html><head><script>evil()</scr' +
        'ipt></head></html>">' +
        '<head><title>Real</title></head><body>hi</body></html>',
      attribute: '<html><head><script>evil()</scr' + 'ipt></head></html>',
    },
  ])('is not fooled by $label', async ({ html, attribute }) => {
    let skipped = 0
    const delivered = await inject(html, Number.MAX_SAFE_INTEGER, () => {
      skipped += 1
    })
    const parsed = new DOMParser().parseFromString(delivered, 'text/html')

    // The shim is a real element in the real head, not text inside a quote.
    const shim = parsed.querySelector(`head > script[${SHIM_MARKER_ATTRIBUTE}]`)
    expect(shim).not.toBeNull()
    expect(shim?.textContent).toBe(WS_SHIM_SOURCE)
    expect(scriptsOf(delivered)[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
    // The attribute that carried the decoy survives byte for byte.
    expect(
      parsed.documentElement.getAttribute('data-x') ??
        parsed.documentElement.getAttribute('data-tpl')
    ).toBe(attribute)
    expect(parsed.title).toBe('Real')
    expect(skipped).toBe(0)
  })

  it('is not fooled by a bare < in prose before the head', async () => {
    // A `<` that opens nothing must be stepped over one byte at a time. Reading
    // it as a tag and skipping to the next `>` would step past the real head.
    const delivered = await inject(
      '<!doctype html><html><body>a < b and c > d<script>1</' + 'script></body></html>'
    )

    expect(scriptsOf(delivered)[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
    expect(delivered).toContain('a < b and c > d')
  })

  it('does not read <header> as <head>', async () => {
    const delivered = await inject(
      '<!doctype html><html><body><header>x</header><script>1</' + 'script></body></html>'
    )

    const parsed = new DOMParser().parseFromString(delivered, 'text/html')

    expect(parsed.querySelector('header')?.textContent).toBe('x')
    expect(scriptsOf(delivered)[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
  })

  it('produces the same document however the bytes are chunked', async () => {
    const source =
      '<!doctype html>\n<html>\n  <head>\n    <meta charset="utf-8">\n' +
      '    <title>café — webui</title>\n  </head>\n  <body>\n' +
      '    <script src="/app.js"></' +
      'script>\n  </body>\n</html>\n'
    const whole = await inject(source)

    // Every split offset across the markers, including mid-`<head`, mid-UTF-8
    // and mid-doctype. This is the failure that only shows up on large
    // documents in production, which is where it matters most.
    for (let size = 1; size <= 12; size += 1) {
      expect(await inject(source, size)).toBe(whole)
    }
    expect(await inject(source, 3)).toBe(whole)
  })

  it('reassembles a UTF-8 sequence split across a chunk boundary', async () => {
    // "café" - the 0xC3 0xA9 pair is deliberately split.
    const source = '<!doctype html><html><head></head><body>café</body></html>'
    const bytes = encoder.encode(source)
    const boundary = bytes.indexOf(0xc3)

    const injector = createShimInjector()
    const writer = injector.writable.getWriter()
    const written = (async () => {
      await writer.write(bytes.slice(0, boundary + 1))
      await writer.write(bytes.slice(boundary + 1))
      await writer.close()
    })()
    const parts: Uint8Array[] = []
    const reader = injector.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
    }
    await written
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
    const out = new Uint8Array(total)
    let cursor = 0
    for (const part of parts) {
      out.set(part, cursor)
      cursor += part.byteLength
    }

    expect(new TextDecoder('utf-8', { fatal: true }).decode(out)).toContain('café')
    expect(decoder.decode(out)).not.toContain('�')
  })

  it('falls back to the safe position when the head tag never closes', async () => {
    // Undecidable *after* the preamble. There is still an ordering-correct
    // answer - after the doctype, before every tag - so take it rather than
    // guess a position or drop the shim.
    let skipped = 0
    const source = `<!doctype html><html><head data-x="${'y'.repeat(HTML_SNIFF_BYTES)}">`

    const delivered = await inject(source, 4096, () => {
      skipped += 1
    })

    expect(skipped).toBe(0)
    expect(delivered.startsWith('<!doctype html><script')).toBe(true)
    // Still the first script once parsed: the parser fosters a pre-<html>
    // script into the head it synthesises.
    expect(scriptsOf(delivered)[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
  })

  it('skips, and says so, when the preamble itself cannot be delimited', async () => {
    // The one position-less case: an unterminated comment before the doctype.
    // Every offset in this buffer might be in front of a doctype that has not
    // arrived, and a script in front of a doctype means quirks mode.
    let skipped = 0
    const source = `<!-- ${'y'.repeat(HTML_SNIFF_BYTES)}`

    const delivered = await inject(source, 4096, () => {
      skipped += 1
    })

    expect(skipped).toBe(1)
    expect(delivered).toBe(source)
    expect(delivered).not.toContain(SHIM_MARKER_ATTRIBUTE)
  })

  it('forwards a document with no markers at all once the window is exhausted', async () => {
    // The positive control for the test above: the same size of document, but
    // decidable. It must be injected, or "skipped" above proves nothing.
    const source = `<!doctype html><html><p>${'z'.repeat(HTML_SNIFF_BYTES)}</p>`
    let skipped = 0

    const delivered = await inject(source, 4096, () => {
      skipped += 1
    })

    expect(skipped).toBe(0)
    expect(scriptsOf(delivered)[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
  })

  it('holds nothing downstream until the insertion point is settled', async () => {
    const injector = createShimInjector()
    const writer = injector.writable.getWriter()
    const reader = injector.readable.getReader()

    // The read is issued first: a `TransformStream`'s readable side has a high
    // water mark of 0, so a write only settles once a reader is asking.
    let first: Uint8Array | undefined
    const pending = reader.read().then(({ value }) => {
      first = value
    })

    // A first chunk that ends mid-doctype cannot be forwarded: emitting it
    // would put bytes in front of a shim that has not been spliced yet.
    await writer.write(encoder.encode('<!doct'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(first).toBeUndefined()

    // Not awaited: the transform enqueues three chunks and the readable's high
    // water mark is one, so the write only settles once they are drained.
    const rest = writer
      .write(encoder.encode('ype html><html><head></head><body></body></html>'))
      .then(() => writer.close())
    await pending

    expect(first === undefined ? '' : decoder.decode(first)).toBe('<!doctype html><html><head>')

    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    await rest
  })

  it('reports the same insertion point wherever the scan is truncated', () => {
    const source = encoder.encode('<!doctype html><html><head lang="en">x')
    const settled = findShimInsertionPoint(source, true)

    expect(settled).toEqual({ kind: 'insert', at: source.indexOf(0x78) })

    // Truncating anywhere before that must say "wait", never a wrong answer.
    for (let cut = 1; cut < source.indexOf(0x78); cut += 1) {
      expect(findShimInsertionPoint(source.slice(0, cut), false)).toEqual({ kind: 'wait' })
    }
  })
})

// -- what the shim does once it runs ----------------------------------------

interface ShimRealm {
  frame: HTMLIFrameElement
  view: Window & typeof globalThis
}

const realms: ShimRealm[] = []

afterEach(() => {
  for (const realm of realms.splice(0)) realm.frame.remove()
  delete window.__lemWsBridge
})

/**
 * Run the shim in a genuinely separate realm.
 *
 * A live `iframe` window: its `Blob`, `Event`, `URL` and `MessageEvent` are
 * different constructors from this file's, so every cross-realm hazard is real
 * here rather than modelled.
 *
 * One thing *is* faked, and it is worth being explicit about: jsdom's
 * `WindowProxy` does not forward arbitrary properties across `parent`, so
 * `window.parent.__lemWsBridge` reads `undefined` in jsdom where a real
 * same-origin browser returns the object. The property is re-pointed at the
 * dashboard window to restore browser behaviour. The bridge lookup itself, the
 * absence path (4002) and everything downstream are the shipped code.
 */
function bootShimRealm(baseHref: string): ShimRealm {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const view = frame.contentWindow as (Window & typeof globalThis) | null
  if (view === null) throw new Error('jsdom gave the iframe no window')

  Object.defineProperty(view, 'parent', { value: window, configurable: true })

  // jsdom's `Blob` in a nested realm is missing `arrayBuffer()`, which every
  // browser has had since 2020. Restore it through the frame's own
  // `FileReader`, so the object under test stays a genuine foreign-realm Blob
  // read by that realm's own machinery.
  const frameBlob = view.Blob.prototype as Blob & { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (typeof frameBlob.arrayBuffer !== 'function') {
    frameBlob.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
      return new Promise((resolve, reject) => {
        const reader = new view.FileReader()
        reader.onload = () => resolve(reader.result as ArrayBuffer)
        reader.onerror = () => reject(reader.error ?? new Error('read failed'))
        reader.readAsArrayBuffer(this)
      })
    }
  }

  const base = view.document.createElement('base')
  base.setAttribute('href', baseHref)
  view.document.head.append(base)

  // The point of this file: evaluate the shipped source in the frame's realm.
  ;(view.eval as (source: string) => void)(WS_SHIM_SOURCE)

  const realm = { frame, view }
  realms.push(realm)
  return realm
}

describe('the shim in a framed realm', () => {
  const BASE = 'https://dashboard.lem.test/app/dev-7f3a/webui/'

  function bridged(): { transport: StubTransport; manager: WSProxyManager } {
    const transport = new StubTransport()
    const manager = new WSProxyManager(transport)
    installWsBridge(manager, window)
    return { transport, manager }
  }

  it('replaces the frame realm WebSocket, not the dashboard one', () => {
    const dashboardWebSocket = window.WebSocket
    const { view } = bootShimRealm(BASE)

    expect(view.WebSocket.name).toBe('LemWebSocket')
    expect(window.WebSocket).toBe(dashboardWebSocket)
    expect(view.WebSocket.CONNECTING).toBe(0)
    expect(view.WebSocket.OPEN).toBe(1)
    expect(view.WebSocket.CLOSING).toBe(2)
    expect(view.WebSocket.CLOSED).toBe(3)
  })

  it('resolves a root-relative URL against the frame own base', async () => {
    const { transport, manager } = bridged()
    const { view } = bootShimRealm(BASE)

    new view.WebSocket('/ws/socket.io/?EIO=4')
    await Promise.resolve()

    const connect = transport.sent[0]
    expect(new Uint8Array(connect)[0]).toBe(FrameType.WS_CONNECT)
    const url = decoder.decode(
      new Uint8Array(connect).slice(7, 7 + new DataView(connect).getUint16(5, false))
    )
    expect(url).toBe('wss://dashboard.lem.test/ws/socket.io/?EIO=4')
    manager.closeAll()
  })

  it('opens over the tunnel and flushes a send made in the same turn', async () => {
    const { transport, manager } = bridged()
    const { view } = bootShimRealm(BASE)

    const opened: string[] = []
    const socket = new view.WebSocket('wss://dashboard.lem.test/socket')
    socket.onopen = () => opened.push('open')
    // Synchronously after construction, before the connect frame has even been
    // put on the wire. This is what socket.io does.
    socket.send('40/chat,')

    expect(socket.readyState).toBe(0)
    expect(transport.sent).toHaveLength(0)

    await Promise.resolve()
    expect(transport.frameTypes()).toEqual([FrameType.WS_CONNECT])

    manager.handleFrame(serializeWSConnectAck({ connectionId: 1, protocol: '' }))
    await Promise.resolve()

    expect(opened).toEqual(['open'])
    expect(socket.readyState).toBe(1)
    const data = transport.sent.slice(1).map((frame) => deserializeWSData(frame))
    expect(data.map((frame) => decoder.decode(frame.payload))).toEqual(['40/chat,'])
  })

  it('delivers an inbound binary message as a Blob of the frame own realm', async () => {
    const { transport, manager } = bridged()
    const { view } = bootShimRealm(BASE)

    const socket = new view.WebSocket('wss://dashboard.lem.test/socket')
    const received: unknown[] = []
    socket.onmessage = (event: MessageEvent) => received.push(event.data)
    await Promise.resolve()
    manager.handleFrame(serializeWSConnectAck({ connectionId: 1, protocol: '' }))

    manager.handleFrame(
      serializeWSData({
        connectionId: 1,
        opcode: WSOpcode.BINARY,
        payload: new Uint8Array([7, 8, 9]),
        fin: true,
      })
    )

    expect(received).toHaveLength(1)
    // The distinction this test exists for: a Blob minted in the dashboard's
    // realm fails `instanceof Blob` inside the app, and apps do check.
    expect(received[0] instanceof view.Blob).toBe(true)
    expect(received[0] instanceof Blob).toBe(false)
    expect(transport.sent.length).toBeGreaterThan(0)
  })

  it('sends a Blob made in the frame realm without emptying it', async () => {
    const { transport, manager } = bridged()
    const { view } = bootShimRealm(BASE)

    const socket = new view.WebSocket('wss://dashboard.lem.test/socket')
    await Promise.resolve()
    manager.handleFrame(serializeWSConnectAck({ connectionId: 1, protocol: '' }))
    transport.sent.length = 0

    // `data instanceof Blob` in the dashboard realm is false for this object.
    // Before the brand check, it fell through to the ArrayBuffer branch and
    // went on the wire as a zero-length message.
    socket.send(new view.Blob([new Uint8Array([1, 2, 3, 4])]))

    await vi.waitFor(() => {
      expect(transport.sent).toHaveLength(1)
    })
    const frame = deserializeWSData(transport.sent[0])
    expect(frame.opcode).toBe(WSOpcode.BINARY)
    expect([...frame.payload]).toEqual([1, 2, 3, 4])
  })

  it('fails with 4002 rather than opening a socket from the remote browser', async () => {
    // No bridge installed: the dashboard was reloaded, or this frame outlived
    // its session. A native fallback here would reach the *remote* browser's
    // own network, which is the defect the whole design exists to remove.
    const { view } = bootShimRealm(BASE)

    const socket = new view.WebSocket('wss://dashboard.lem.test/socket')
    const events: string[] = []
    let code = 0
    socket.onerror = () => events.push('error')
    socket.onclose = (event: CloseEvent) => {
      events.push('close')
      code = event.code
    }

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(events).toEqual(['error', 'close'])
    expect(code).toBe(4002)
    expect(socket.readyState).toBe(3)
  })

  it('accepts a bridge pushed in by the parent on load', async () => {
    const { transport, manager } = bridged()
    const bridge = window.__lemWsBridge
    delete window.__lemWsBridge
    const { view } = bootShimRealm(BASE)

    // Belt and braces: this is the path for a dashboard that is itself framed,
    // so `window.parent` is somebody else.
    ;(view as unknown as { __lemAttachWsBridge: (value: unknown) => void }).__lemAttachWsBridge(
      bridge
    )
    new view.WebSocket('wss://dashboard.lem.test/socket')
    await Promise.resolve()

    expect(transport.frameTypes()).toEqual([FrameType.WS_CONNECT])
    manager.closeAll()
  })

  it('throws InvalidStateError on send after close, like the platform', async () => {
    const { manager } = bridged()
    const { view } = bootShimRealm(BASE)

    const socket = new view.WebSocket('wss://dashboard.lem.test/socket')
    await Promise.resolve()
    manager.handleFrame(serializeWSConnectAck({ connectionId: 1, protocol: '' }))
    socket.close()
    manager.handleFrame(new Uint8Array([FrameType.WS_CLOSE, 0, 0, 0, 1, 0x03, 0xe8, 0, 0]).buffer)

    expect(() => socket.send('too late')).toThrow(/CLOSING or CLOSED/)
  })
})
