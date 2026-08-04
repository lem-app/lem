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
 * The Phase 4 acceptance criteria, end to end.
 *
 * Worker, page bridge and `HTTPProxy` are the shipping implementations; the
 * browser's plumbing is faked (`src/test/sw-harness.ts`). Every negative
 * assertion here is paired with a positive control, because "nothing was
 * recorded" is also what a harness that records nothing looks like.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  FakeNetwork,
  ORIGIN,
  appUrl,
  createHarness,
  dispatchFetch,
  persistentBindingStore,
  settle,
  type DispatchOptions,
  type Harness,
  type UpstreamRequest,
} from '../test/sw-harness'
import { FrameType, MAX_CHUNK_BYTES } from './http-frame'
import { TunnelErrorCode } from './tunnel-errors'
import { HTML_SNIFF_BYTES, SHIM_MARKER_ATTRIBUTE, WS_SHIM_SOURCE } from '../../public/lem-app-sw.js'

const DEVICE_A = 'dev-7f3a'
const DEVICE_B = 'dev-91c2'

/** A stand-in for Open WebUI: an HTML shell plus the subresources it pulls. */
const OPENWEBUI: Record<string, { type: string; body: string }> = {
  '/': { type: 'text/html', body: '<!doctype html><html><head></head><body>webui</body></html>' },
  '/static/app.js': { type: 'application/javascript', body: 'console.log("app")' },
  '/static/app.css': { type: 'text/css', body: 'body{color:red}' },
  '/static/font.woff2': { type: 'font/woff2', body: 'wOFF2-bytes' },
  '/favicon.ico': { type: 'image/x-icon', body: 'icon-bytes' },
  '/api/models': { type: 'application/json', body: '{"models":[]}' },
}

function serveOpenWebUI(harness: Harness): void {
  harness.tunnel.serve((request: UpstreamRequest) => {
    const asset = OPENWEBUI[request.path]
    if (asset === undefined) return { status: 404, chunks: ['missing'] }
    return {
      status: 200,
      headers: [['Content-Type', asset.type]],
      chunks: [asset.body],
    }
  })
}

describe('the same-origin Service Worker proxy', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness({ deviceId: DEVICE_A })
    await harness.bridge.openSession(DEVICE_A, 'webui')
    await settle()
  })

  describe('a service loads through the tunnel', () => {
    it('serves the document and every subresource, none of them locally', async () => {
      serveOpenWebUI(harness)
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      // Nothing on this machine's loopback is listening in CI, so a request to
      // `http://localhost:3000` would fail rather than accidentally succeed -
      // but a failure is easy to swallow. Watch the platform `fetch` directly
      // so "nothing was requested locally" is a fact about calls made, not
      // about which of them happened to work.
      const platformFetch = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new TypeError('fetch failed: nothing is listening'))

      const navigation = await harness.dispatch(appUrl(DEVICE_A, 'webui'), {
        mode: 'navigate',
        resultingClientId: 'frame-1',
      })
      expect(navigation.response?.status).toBe(200)
      expect(await navigation.response?.text()).toContain('webui')

      // The subresources arrive with no prefix, exactly as the app emits them.
      for (const path of [
        '/static/app.js',
        '/static/app.css',
        '/static/font.woff2',
        '/favicon.ico',
      ]) {
        const result = await harness.dispatch(`${ORIGIN}${path}`, {
          clientId: 'frame-1',
          referrer: appUrl(DEVICE_A, 'webui'),
        })
        expect(result.response?.status, path).toBe(200)
        expect(result.passedThrough, path).toBe(false)
      }

      // All six requests reached the far side, addressed to the service.
      expect(harness.tunnel.requests.map((request) => request.path)).toEqual([
        '/',
        '/static/app.js',
        '/static/app.css',
        '/static/font.woff2',
        '/favicon.ico',
      ])
      expect(harness.tunnel.requests.every((request) => request.service === 'webui')).toBe(true)

      // And nothing at all touched this browser's own loopback. The positive
      // control for this assertion is in the cross-origin test below, which
      // proves `network.requests` does record what reaches the network.
      expect(harness.network.loopbackRequests()).toEqual([])
      expect(harness.network.requests).toEqual([])
      expect(platformFetch).not.toHaveBeenCalled()

      // Positive control for the spy itself: it does observe a real call, so
      // the assertion above is reading something.
      await expect(fetch('http://localhost:3000/')).rejects.toThrow()
      expect(platformFetch).toHaveBeenCalledTimes(1)
      platformFetch.mockRestore()
    })

    it('streams the body rather than buffering it', async () => {
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'application/x-ndjson']],
        chunks: ['token-1\n', 'token-2\n', 'token-3\n'],
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/api/chat`, { clientId: 'frame-1' })
      const reader = result.response?.body?.getReader()
      expect(reader).toBeDefined()

      const first = await reader?.read()
      expect(new TextDecoder().decode(first?.value)).toBe('token-1\n')
      await reader?.cancel()
    })

    it('does not send the request headers the app must not choose', async () => {
      serveOpenWebUI(harness)
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      await harness.dispatch(`${ORIGIN}/api/models`, {
        clientId: 'frame-1',
        referrer: appUrl(DEVICE_A, 'webui'),
        headers: [
          ['X-Lem-Service', 'ollama'],
          ['Accept', 'application/json'],
        ],
      })

      const request = harness.tunnel.requests[0]
      // The frame asked for `ollama`; it gets the service its session names.
      expect(request.service).toBe('webui')
      expect(
        request.headers.filter(([name]) => name.toLowerCase() === 'x-lem-service')
      ).toHaveLength(1)
      // Positive control: an ordinary header does survive.
      expect(request.headers.map(([name]) => name.toLowerCase())).toContain('accept')
    })
  })

  describe('absolute-path resolution', () => {
    it('resolves via the referrer (step 2)', async () => {
      serveOpenWebUI(harness)

      const result = await harness.dispatch(`${ORIGIN}/static/app.js`, {
        clientId: 'frame-1',
        referrer: appUrl(DEVICE_A, 'webui'),
      })

      expect(result.response?.status).toBe(200)
      expect(harness.worker.stats.resolvedByReferrer).toBe(1)
      expect(harness.worker.stats.singleSessionFallbacks).toBe(0)
    })

    it('resolves via the client URL when Referrer-Policy is no-referrer (step 3)', async () => {
      serveOpenWebUI(harness)
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/static/app.js`, {
        clientId: 'frame-1',
        referrer: '',
      })

      expect(result.response?.status).toBe(200)
      expect(harness.worker.stats.resolvedByReferrer).toBe(0)
      expect(harness.worker.stats.resolvedByClientUrl).toBe(1)
      expect(harness.worker.stats.singleSessionFallbacks).toBe(0)
    })

    it('resolves from storage after the worker is killed and restarted (step 4)', async () => {
      serveOpenWebUI(harness)
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      // A navigation writes the binding, in memory and in storage.
      await harness.dispatch(appUrl(DEVICE_A, 'webui'), {
        mode: 'navigate',
        resultingClientId: 'frame-1',
      })
      await settle()

      // The browser recycles the worker. Its in-memory map is gone; so is the
      // client's URL, because the document was restored from bfcache and the
      // fake registry no longer lists it.
      const restarted = await harness.restartWorker()
      harness.clients.remove('frame-1')
      await harness.bridge.openSession(DEVICE_A, 'webui')
      await harness.bridge.openSession(DEVICE_A, 'ollama')
      await settle()

      const result = await harness.dispatch(`${ORIGIN}/static/app.js`, {
        clientId: 'frame-1',
        referrer: '',
      })

      expect(result.response?.status).toBe(200)
      expect(restarted.stats.resolvedByStore).toBe(1)
      // Two sessions are open, so step 5 could not have answered this even if
      // it had been reached.
      expect(restarted.stats.singleSessionFallbacks).toBe(0)
    })

    it('fails closed rather than guessing between two sessions (step 6)', async () => {
      await harness.bridge.openSession(DEVICE_A, 'ollama')
      await settle()

      const result = await harness.dispatch(`${ORIGIN}/static/app.js`, { clientId: 'unknown' })

      expect(result.response?.status).toBe(421)
      expect(harness.worker.stats.singleSessionFallbacks).toBe(0)
      expect(harness.tunnel.requestFramesSent).toBe(0)
    })
  })

  describe('two services in two tabs', () => {
    it('do not cross-talk, and never reach the single-session fallback', async () => {
      await harness.bridge.openSession(DEVICE_A, 'ollama')
      await settle()
      harness.tunnel.serve((request) => ({
        status: 200,
        headers: [['Content-Type', 'text/plain']],
        chunks: [`${String(request.service)}:${request.path}`],
      }))

      harness.clients.add('tab-webui', appUrl(DEVICE_A, 'webui'))
      harness.clients.add('tab-ollama', appUrl(DEVICE_A, 'ollama'))

      const fromWebui = await harness.dispatch(`${ORIGIN}/api/models`, {
        clientId: 'tab-webui',
        referrer: appUrl(DEVICE_A, 'webui'),
      })
      const fromOllama = await harness.dispatch(`${ORIGIN}/api/models`, {
        clientId: 'tab-ollama',
        referrer: appUrl(DEVICE_A, 'ollama'),
      })

      expect(await fromWebui.response?.text()).toBe('webui:/api/models')
      expect(await fromOllama.response?.text()).toBe('ollama:/api/models')
      // The counter the spec asks for: reaching step 5 with two sessions open
      // would mean guessing, and it is never reached.
      expect(harness.worker.stats.singleSessionFallbacks).toBe(0)
    })
  })

  describe('the security refusals', () => {
    it('refuses to serve its own source to a controlled client', async () => {
      const result = await harness.dispatch(`${ORIGIN}/lem-app-sw.js`, { clientId: 'frame-1' })

      expect(result.response?.status).toBe(403)
      expect(result.passedThrough).toBe(false)
      expect(harness.tunnel.requestFramesSent).toBe(0)
    })

    it('does not intercept a cross-origin request at all', async () => {
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch('https://cdn.jsdelivr.net/npm/x.js', {
        clientId: 'frame-1',
        referrer: appUrl(DEVICE_A, 'webui'),
      })

      // Asserted at the network, not from a log line: the request appears in
      // what the browser fetched itself, and nothing about it reached the wire.
      expect(result.passedThrough).toBe(true)
      expect(harness.network.requests).toEqual(['https://cdn.jsdelivr.net/npm/x.js'])
      expect(harness.tunnel.requestFramesSent).toBe(0)
      // The tunnel must never become an open proxy to the wider internet from
      // inside the user's home network.
      expect(harness.tunnel.requests).toEqual([])
    })

    it('refuses everything while the tunnel is down', async () => {
      harness.bridge.setTunnelUp(false)
      await settle()

      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui'), { clientId: 'frame-1' })

      expect(result.response?.status).toBe(503)
      expect(harness.tunnel.requestFramesSent).toBe(0)
    })

    it('answers 410 for a session that has been closed', async () => {
      harness.bridge.closeSession(DEVICE_A, 'webui')
      await settle()

      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui'), { clientId: 'frame-1' })

      expect(result.response?.status).toBe(410)
      expect(harness.tunnel.requestFramesSent).toBe(0)
    })
  })

  describe('redirects', () => {
    it('rewrites a 302 carrying the request device segment, not the active one', async () => {
      harness.tunnel.serve(() => ({
        status: 302,
        headers: [['Location', '/auth/callback']],
        chunks: [],
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), {
        clientId: 'frame-1',
      })

      expect(result.response?.status).toBe(302)
      expect(result.response?.headers.get('location')).toBe(`/app/${DEVICE_A}/webui/auth/callback`)
    })

    it('rewrites an upstream loopback redirect so it cannot escape to this machine', async () => {
      harness.tunnel.serve(() => ({
        status: 302,
        headers: [['Location', 'http://127.0.0.1:33801/auth/callback']],
        chunks: [],
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), {
        clientId: 'frame-1',
      })

      expect(result.response?.headers.get('location')).toBe(`/app/${DEVICE_A}/webui/auth/callback`)
    })
  })

  describe('device-segment rejection', () => {
    it('refuses a stale prefix with 409 and puts no frame on the wire', async () => {
      serveOpenWebUI(harness)
      harness.bridge.setActiveDevice(DEVICE_B)
      await harness.bridge.openSession(DEVICE_B, 'webui')
      await settle()

      const before = harness.tunnel.sent.length
      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui'), { clientId: 'frame-1' })

      expect(result.response?.status).toBe(409)
      expect(await result.response?.json()).toMatchObject({ code: 'E_DEVICE_MISMATCH' })
      // Asserted at the transport: not one byte was framed for it.
      expect(harness.tunnel.sent.length).toBe(before)
      expect(harness.tunnel.requests).toEqual([])
      // And emphatically not re-routed to B, which is the tempting behaviour.
      expect(harness.tunnel.requests.some((request) => request.service === 'webui')).toBe(false)
    })

    it('refuses a binding recovered from storage after a restart', async () => {
      // The stale-device worked example of the spec, run for real: a document
      // opened on A, a worker restart, a device change to B, and then a
      // prefix-less fetch from the surviving client.
      const store = persistentBindingStore()
      const session = await createHarness({ deviceId: DEVICE_A, bindingStore: store })
      await session.bridge.openSession(DEVICE_A, 'webui')
      session.clients.add('worker-1', appUrl(DEVICE_A, 'webui'))
      session.tunnel.serve(() => ({ status: 200, chunks: ['ok'] }))
      await settle()

      await session.dispatch(appUrl(DEVICE_A, 'webui'), {
        mode: 'navigate',
        resultingClientId: 'worker-1',
      })
      await settle()

      const restarted = await session.restartWorker()
      // The client's own URL is gone too, so step 3 cannot answer and step 4
      // is the one that resolves - which is the point of the criterion.
      session.clients.remove('worker-1')
      session.bridge.setActiveDevice(DEVICE_B)
      await session.bridge.openSession(DEVICE_B, 'webui')
      await settle()

      const framesBefore = session.tunnel.sent.length
      const requestsBefore = session.tunnel.requests.length

      const result = await session.dispatch(`${ORIGIN}/api/models`, {
        clientId: 'worker-1',
        referrer: '',
      })

      expect(restarted.stats.resolvedByStore).toBe(1)
      expect(result.response?.status).toBe(409)
      expect(await result.response?.json()).toMatchObject({ code: 'E_DEVICE_MISMATCH' })
      expect(session.tunnel.sent.length).toBe(framesBefore)
      expect(session.tunnel.requests.length).toBe(requestsBefore)
    })

    it('the page refuses one too, because the page is what owns the tunnel', async () => {
      // Belt and braces: even with the worker's check bypassed, a LEM_FETCH for
      // a device the page is not connected to must not enter the tunnel.
      serveOpenWebUI(harness)
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      // Reach past the worker's own check by asking it while A is active, then
      // switching the page's device before the exchange is dispatched.
      const before = harness.tunnel.sent.length
      const pending = harness.worker.proxy(
        DEVICE_A,
        'webui',
        '/api/models',
        new Request(`${ORIGIN}/api/models`)
      )
      harness.bridge.setActiveDevice(DEVICE_B)
      const response = await pending

      expect(response.status).toBe(409)
      // The page's own refusal fired, not the worker's: the worker had not yet
      // been told about the switch when it made its decision.
      expect(harness.bridge.deviceMismatches).toBe(1)
      expect(harness.worker.stats.deviceMismatches).toBe(0)
      expect(harness.tunnel.sent.length).toBe(before)
    })
  })

  describe('the response-path accumulator', () => {
    it('errors the stream rather than closing it when the far side truncates', async () => {
      // The far side committed a 200 and then blew the cap: it sends CANCEL and
      // *no* final chunk. A close() here would hand the app a short body it
      // believes is whole.
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'application/octet-stream']],
        chunks: ['first-half'],
        end: 'truncate',
        cancelReason: TunnelErrorCode.E_TOO_LARGE,
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/big.bin`, { clientId: 'frame-1' })
      expect(result.response?.status).toBe(200)

      await expect(result.response?.arrayBuffer()).rejects.toThrow()
    })

    it('errors the stream when the browser own cap is breached mid-body', async () => {
      // The browser-side accumulator of spec 5.5.1, with the negotiated cap
      // lowered so the test is fast. Each chunk is individually legal.
      harness.proxy.setNegotiatedLimits(MAX_CHUNK_BYTES, 3 * 8)
      harness.tunnel.serve(() => ({
        status: 200,
        chunks: ['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd', 'eeeeeeee'],
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/big.bin`, { clientId: 'frame-1' })

      await expect(result.response?.text()).rejects.toThrow()
      // The browser told the far side to stop.
      expect(harness.tunnel.cancelled).toContain(1)
    })

    it('delivers an over-cap rejection as a real 502 in the frame', async () => {
      // The request-side rejection: the far side answers 502 with the problem
      // body and *then* cancels, so a peer that stops reading on the cancel has
      // still been given a diagnosable answer.
      harness.tunnel.serve(() => ({
        status: 502,
        headers: [['Content-Type', 'application/json']],
        chunks: ['{"error":"Payload too large"}'],
        end: 'final-then-cancel',
        cancelReason: TunnelErrorCode.E_TOO_LARGE,
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/upload`, {
        clientId: 'frame-1',
        method: 'POST',
        body: 'x'.repeat(64),
      })

      expect(result.response?.status).toBe(502)
      expect(await result.response?.json()).toEqual({ error: 'Payload too large' })
    })

    it('a complete body is delivered whole - the positive control', async () => {
      harness.tunnel.serve(() => ({ status: 200, chunks: ['abc', 'def'] }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/small.bin`, { clientId: 'frame-1' })

      expect(await result.response?.text()).toBe('abcdef')
    })
  })

  describe('cancellation', () => {
    it('reaches the far side as an HTTP_CANCEL when the frame aborts', async () => {
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'application/x-ndjson']],
        chunks: ['token-1\n'],
        // Still generating, so there is something to cancel.
        end: 'never',
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))
      const abort = new AbortController()

      await harness.dispatch(`${ORIGIN}/api/chat`, {
        clientId: 'frame-1',
        signal: abort.signal,
      })
      abort.abort()
      await settle()

      // The page turned the frame's abort into a cancel on the wire, rather
      // than leaving the far side generating tokens nobody will read.
      expect(harness.tunnel.frameTypes()).toContain(FrameType.HTTP_CANCEL)
    })
  })

  describe('request bodies', () => {
    it('reach the far side byte for byte', async () => {
      harness.tunnel.serve((request) => ({
        status: 200,
        chunks: [new TextDecoder().decode(request.body)],
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/api/chat`, {
        clientId: 'frame-1',
        method: 'POST',
        body: '{"prompt":"hello"}',
      })

      expect(harness.tunnel.requests[0].method).toBe('POST')
      expect(new TextDecoder().decode(harness.tunnel.requests[0].body)).toBe('{"prompt":"hello"}')
      expect(await result.response?.text()).toBe('{"prompt":"hello"}')
    })
  })

  describe('the harness itself', () => {
    it('refuses a respondWith made after the fetch listener returned', async () => {
      // The positive control for the constraint asserted in lem-app-sw.test.ts.
      // Without this guard, a listener refactored to `async` and awaiting
      // before `respondWith` would pass every test in this suite and throw
      // `InvalidStateError` in every real browser (#75).
      let thrown: unknown = null
      const network = new FakeNetwork()

      const result = await dispatchFetch(
        (event) => {
          setTimeout(() => {
            try {
              event.respondWith(new Response('late'))
            } catch (error) {
              thrown = error
            }
          }, 0)
        },
        network,
        appUrl(DEVICE_A, 'webui')
      )
      await settle()

      expect(result.passedThrough).toBe(true)
      expect((thrown as Error | null)?.message).toMatch(/after the fetch listener returned/)
    })
  })

  describe('the WebSocket shim', () => {
    /** Parse what the frame actually received and list its scripts. */
    async function scriptsDeliveredFor(url: string, options: DispatchOptions): Promise<Element[]> {
      const result = await harness.dispatch(url, options)
      const html = (await result.response?.text()) ?? ''
      const parsed = new DOMParser().parseFromString(html, 'text/html')
      return [...parsed.querySelectorAll('script')]
    }

    it('is the first script in a navigated document', async () => {
      serveOpenWebUI(harness)

      const scripts = await scriptsDeliveredFor(appUrl(DEVICE_A, 'webui'), {
        mode: 'navigate',
        resultingClientId: 'frame-1',
      })

      // Asserted on the parse tree, not on the bytes: a shim spliced into a
      // comment or after a stray `<` is a string match and not a script.
      expect(scripts.length).toBeGreaterThan(0)
      expect(scripts[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
      expect(scripts[0].textContent).toBe(WS_SHIM_SOURCE)
    })

    it('runs ahead of the app own boot script', async () => {
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'text/html; charset=utf-8']],
        chunks: [
          '<!doctype html><html><head><script>window.boot=1</',
          'script></head><body></body></html>',
        ],
      }))

      const scripts = await scriptsDeliveredFor(appUrl(DEVICE_A, 'webui'), {
        mode: 'navigate',
        resultingClientId: 'frame-1',
      })

      expect(scripts).toHaveLength(2)
      expect(scripts[0].getAttribute(SHIM_MARKER_ATTRIBUTE)).toBe('1')
      expect(scripts[1].textContent).toBe('window.boot=1')
    })

    it('is not spliced into a subresource that merely returns HTML', async () => {
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'text/html']],
        chunks: ['<div>a fragment</div>'],
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/partials/menu`, { clientId: 'frame-1' })

      // A `fetch()` for an HTML fragment is not a document. Injecting here
      // would corrupt whatever the app does with the string.
      expect(await result.response?.text()).toBe('<div>a fragment</div>')
    })

    it('is not spliced into a navigation that is not HTML', async () => {
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'application/pdf']],
        chunks: ['%PDF-1.7'],
      }))

      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui', '/report.pdf'), {
        mode: 'navigate',
        resultingClientId: 'frame-1',
      })

      expect(await result.response?.text()).toBe('%PDF-1.7')
    })

    it('tells the page when a document could not be spliced', async () => {
      // A comment that never closes inside the sniff window, so the preamble
      // cannot be delimited and no offset is known to be after the doctype.
      // The only position-less case; HTTP still works for this document,
      // WebSockets in it will not, and the page is told so.
      const filler = 'y'.repeat(16 * 1024)
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'text/html']],
        // Chunked under MAX_CHUNK_BYTES, the way a real body arrives.
        chunks: ['<!-- ', ...Array<string>(6).fill(filler)],
      }))

      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui'), {
        mode: 'navigate',
        resultingClientId: 'frame-1',
      })
      const html = (await result.response?.text()) ?? ''
      await settle()

      expect(html.length).toBeGreaterThan(HTML_SNIFF_BYTES)
      expect(html).not.toContain(SHIM_MARKER_ATTRIBUTE)
      expect(harness.bridge.shimSkips).toBe(1)
    })

    it('splices a document of the same size that is decidable - the positive control', async () => {
      const filler = 'y'.repeat(16 * 1024)
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'text/html']],
        chunks: ['<!doctype html><html><head></head><body>', ...Array<string>(6).fill(filler)],
      }))

      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui'), {
        mode: 'navigate',
        resultingClientId: 'frame-1',
      })
      const html = (await result.response?.text()) ?? ''
      await settle()

      expect(html.length).toBeGreaterThan(HTML_SNIFF_BYTES)
      expect(html).toContain(SHIM_MARKER_ATTRIBUTE)
      expect(harness.bridge.shimSkips).toBe(0)
    })

    it('streams the rest of the document after the splice', async () => {
      // The splice must not turn a streamed document into a buffered one: the
      // whole point of Phase 3 was that a `<script>` starts executing early.
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [['Content-Type', 'text/html']],
        chunks: ['<!doctype html><html><head></head><body>', 'first', 'second', '</body></html>'],
      }))

      const result = await harness.dispatch(appUrl(DEVICE_A, 'webui'), {
        mode: 'navigate',
        resultingClientId: 'frame-1',
      })
      const reader = result.response?.body?.getReader()
      const seen: string[] = []
      for (;;) {
        const next = await reader?.read()
        if (next === undefined || next.done) break
        seen.push(new TextDecoder().decode(next.value))
      }

      // More than one chunk reached the frame, and the shim rode in the first.
      expect(seen.length).toBeGreaterThan(1)
      expect(seen[0]).toContain('<!doctype html><html><head>')
      expect(seen.join('')).toContain('firstsecond')
    })
  })

  // The worker now keeps its own cookie jar (section 5.6.2), and `sw-cookies.
  // test.ts` covers it. What stays here is the *reason* the jar exists: the
  // browser rule that made #72's original `Set-Cookie` rewrite undeliverable,
  // and which this suite does not enforce. Without these two assertions a
  // future rewrite could be "proved" correct by a runtime more permissive than
  // the platform - which is exactly how the deleted implementation passed.
  describe('cookies, and why the browser never sees them', () => {
    it('cannot be delivered on a worker-synthesised Response - the rule undici does not enforce', () => {
      // `Set-Cookie` and `Set-Cookie2` are *forbidden response-header names* in
      // the Fetch Standard - a concept that is current, not removed. A browser's
      // `new Response(body, { headers })` gives its Headers the "response"
      // guard, and `validate` drops a forbidden name silently. Even if it
      // survived, "parse and store response Set-Cookie headers" runs only inside
      // HTTP-network-or-cache fetch, which a worker-supplied response never
      // enters.
      //
      // Node's undici does not enforce that guard. This assertion pins the
      // divergence so that a future rewrite cannot be "proved" correct by a
      // suite that is simply more permissive than the platform.
      const synthesised = new Response('x', { headers: [['Set-Cookie', 'a=1; Path=/']] })
      expect(synthesised.headers.getSetCookie()).toEqual(['a=1; Path=/'])
      // ^ In every browser this is `[]`. See docs/tunnel-proxy-spec.md 5.6.2.
    })

    it('are taken by the jar rather than handed to the frame', async () => {
      // The worker mirrors the browser instead of diverging from it: an upstream
      // cookie reaches the worker (the server relays it, which the jar needs),
      // is stored in the jar, and goes no further. What this pins is that the
      // cookie is not handed to the frame *as a response header* — nothing more.
      // It is emphatically NOT evidence that `HttpOnly` is real: the jar sits in
      // same-origin IndexedDB, which the framed realm can open and read itself.
      // See spec section 5.6.2 and #94.
      harness.tunnel.serve(() => ({
        status: 200,
        headers: [
          ['Content-Type', 'text/plain'],
          ['Set-Cookie', 'session=s3cret; Path=/; HttpOnly'],
        ],
        chunks: ['ok'],
      }))
      harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))

      const result = await harness.dispatch(`${ORIGIN}/login`, { clientId: 'frame-1' })
      await settle()

      expect(result.response?.headers.getSetCookie()).toEqual([])
      // ...and the jar did get it, so this is "consumed", not "lost".
      const stored = await harness.worker.cookies.read(DEVICE_A, 'webui')
      expect(stored.map((cookie: { name: string }) => cookie.name)).toEqual(['session'])
    })
  })
})
