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
 * A whole Service Worker proxy, assembled from real parts, in one process.
 *
 * The worker, the page bridge and `HTTPProxy` are the shipping implementations;
 * only the browser's own plumbing is faked - the `clients` registry, the
 * `ServiceWorkerContainer`, IndexedDB, and the network the browser would use
 * when the worker declines to intercept.
 *
 * Two properties this harness is built to make *assertable* rather than
 * inferable:
 *
 * - **What reached the wire.** `FakeTunnel.sent` is every frame the browser
 *   put on the transport, so "no frame was sent" is a transport-level fact and
 *   not the absence of a log line.
 * - **What reached the network.** `network.requests` is every URL the browser
 *   would have fetched itself because the worker declined to intercept it. A
 *   test can therefore assert both that a CDN request went to the network *and*
 *   that nothing ever went to a loopback address.
 */

import { HTTPProxy, type Transport } from '../lib/proxy-fetch'
import {
  FrameType,
  deserializeCancel,
  deserializeChunk,
  deserializeRequestHead,
  serializeCancel,
  serializeResponseChunk,
  serializeResponseHead,
  type HeaderList,
} from '../lib/http-frame'
import { TunnelErrorCode } from '../lib/tunnel-errors'
import { ServiceWorkerBridge, SW_SCOPE } from '../lib/sw-bridge'
import {
  LemAppServiceWorker,
  createMemoryBindingStore,
  installServiceWorker,
  type BindingStore,
} from '../../public/lem-app-sw.js'

/** Origin the dashboard and the framed apps share; matches `vitest.config.ts`. */
export const ORIGIN = 'https://dashboard.lem.test'

// -- the far side ------------------------------------------------------------

/** One request as the far-side server saw it. */
export interface UpstreamRequest {
  method: string
  path: string
  headers: HeaderList
  /** Value of `X-Lem-Service`, or null when the request targets the local API. */
  service: string | null
  body: Uint8Array
}

/** What the far side should answer with. */
export interface UpstreamReply {
  status: number
  headers?: HeaderList
  /** Body pieces; each becomes one `HTTP_RESPONSE_CHUNK`. */
  chunks?: (Uint8Array | string)[]
  /**
   * How the response ends.
   *
   * - `final` (default): a zero-length `FINAL` chunk. The body was complete.
   * - `truncate`: `HTTP_CANCEL` and **no** final chunk. This is what the far
   *   side does when it streams past the cap after committing a 200, and the
   *   absence of the final chunk is load-bearing - it is what turns a
   *   truncation into a visible failure instead of a short body the app
   *   believes is whole.
   * - `final-then-cancel`: a final chunk followed by `HTTP_CANCEL`. This is the
   *   request-side rejection order: the peer gets a diagnosable answer even if
   *   it stops reading on the cancel.
   * - `never`: nothing after the chunks. A long generation still in progress.
   */
  end?: 'final' | 'truncate' | 'final-then-cancel' | 'never'
  /** Reason code for the cancel, when there is one. */
  cancelReason?: number
}

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? new TextEncoder().encode(value) : value
}

function serviceOf(headers: HeaderList): string | null {
  const found = headers.find(([name]) => name.toLowerCase() === 'x-lem-service')
  return found ? found[1] : null
}

/**
 * A transport that records every frame and answers requests like a far-side
 * server would.
 */
export class FakeTunnel implements Transport {
  /** Every frame the browser put on the wire, in order. */
  readonly sent: ArrayBuffer[] = []
  /** Every request the far side actually received. */
  readonly requests: UpstreamRequest[] = []
  /** `request_id`s the browser cancelled. */
  readonly cancelled: number[] = []

  open = true
  proxy: HTTPProxy | null = null

  private handler: (request: UpstreamRequest) => UpstreamReply = () => ({
    status: 404,
    chunks: ['not found'],
  })

  private readonly intakes = new Map<
    number,
    { method: string; path: string; headers: HeaderList; body: Uint8Array[] }
  >()

  /** Set the far side's behaviour. */
  serve(handler: (request: UpstreamRequest) => UpstreamReply): void {
    this.handler = handler
  }

  sendData(data: ArrayBuffer): void {
    this.sent.push(data)
    this.consume(data)
  }

  isOpen(): boolean {
    return this.open
  }

  /** Type byte of every frame sent, for coarse assertions. */
  frameTypes(): number[] {
    return this.sent.map((frame) => new Uint8Array(frame)[0])
  }

  /** Did any request frame reach the wire? */
  get requestFramesSent(): number {
    return this.frameTypes().filter(
      (type) => type === FrameType.HTTP_REQUEST_HEAD || type === FrameType.HTTP_REQUEST_CHUNK
    ).length
  }

  private consume(data: ArrayBuffer): void {
    const type = new Uint8Array(data)[0]
    if (type === FrameType.HTTP_REQUEST_HEAD) {
      const frame = deserializeRequestHead(data)
      this.intakes.set(frame.requestId, {
        method: frame.method,
        path: frame.path,
        headers: frame.headers,
        body: [],
      })
      if (!frame.bodyFollows) this.dispatch(frame.requestId)
      return
    }
    if (type === FrameType.HTTP_REQUEST_CHUNK) {
      const frame = deserializeChunk(data)
      const intake = this.intakes.get(frame.requestId)
      if (!intake) return
      intake.body.push(frame.payload)
      if (frame.final) this.dispatch(frame.requestId)
      return
    }
    if (type === FrameType.HTTP_CANCEL) {
      this.cancelled.push(deserializeCancel(data).requestId)
    }
  }

  private dispatch(requestId: number): void {
    const intake = this.intakes.get(requestId)
    if (!intake) return
    this.intakes.delete(requestId)

    const totalLength = intake.body.reduce((sum, part) => sum + part.byteLength, 0)
    const body = new Uint8Array(totalLength)
    let offset = 0
    for (const part of intake.body) {
      body.set(part, offset)
      offset += part.byteLength
    }

    const request: UpstreamRequest = {
      method: intake.method,
      path: intake.path,
      headers: intake.headers,
      service: serviceOf(intake.headers),
      body,
    }
    this.requests.push(request)
    const reply = this.handler(request)

    // Asynchronous, like a real transport: a response that arrived
    // synchronously inside `sendData` would hide every ordering bug.
    queueMicrotask(() => {
      const proxy = this.proxy
      if (proxy === null) return
      proxy.handleFrame(
        serializeResponseHead({
          requestId,
          statusCode: reply.status,
          headers: reply.headers ?? [],
          bodyFollows: true,
        })
      )
      for (const chunk of reply.chunks ?? []) {
        proxy.handleFrame(serializeResponseChunk(requestId, toBytes(chunk), false))
      }
      const cancelReason = reply.cancelReason ?? TunnelErrorCode.E_TOO_LARGE
      if (reply.end === 'never') return
      if (reply.end === 'truncate') {
        proxy.handleFrame(serializeCancel(requestId, cancelReason))
        return
      }
      proxy.handleFrame(serializeResponseChunk(requestId, new Uint8Array(0), true))
      if (reply.end === 'final-then-cancel') {
        proxy.handleFrame(serializeCancel(requestId, cancelReason))
      }
    })
  }
}

// -- the browser's plumbing --------------------------------------------------

interface FakeClient {
  id: string
  url: string
  postMessage: (message: unknown) => void
}

/** The `clients` registry a worker consults for resolution step 3. */
export class FakeClients {
  private readonly clients = new Map<string, FakeClient>()
  readonly broadcasts: unknown[] = []

  add(id: string, url: string): void {
    this.clients.set(id, { id, url, postMessage: (message) => this.broadcasts.push(message) })
  }

  remove(id: string): void {
    this.clients.delete(id)
  }

  get(id: string): Promise<FakeClient | undefined> {
    return Promise.resolve(this.clients.get(id))
  }

  matchAll(): Promise<FakeClient[]> {
    return Promise.resolve([...this.clients.values()])
  }
}

/** A binding store that outlives a worker, exactly as IndexedDB does. */
export function persistentBindingStore(): BindingStore {
  return createMemoryBindingStore()
}

/** Everything the browser would have fetched itself. */
export class FakeNetwork {
  readonly requests: string[] = []

  fetch(url: string): Response {
    this.requests.push(url)
    return new Response('from the network', { status: 200 })
  }

  /** URLs that named a loopback address. Must always be empty. */
  loopbackRequests(): string[] {
    return this.requests.filter((url) => {
      try {
        const parsed = new URL(url)
        return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      } catch {
        return false
      }
    })
  }
}

export interface DispatchOptions {
  clientId?: string
  resultingClientId?: string
  referrer?: string
  mode?: RequestMode
  method?: string
  body?: string
  headers?: HeaderList
  /** Stands in for the signal a browser aborts when the frame walks away. */
  signal?: AbortSignal
}

export interface DispatchResult {
  /** The response the frame received, or null when the worker declined. */
  response: Response | null
  /** True when the worker did not call `respondWith` at all. */
  passedThrough: boolean
}

/** The `fetch` listener `installServiceWorker` wired up. */
export type FetchListener = (event: {
  request: Request
  clientId: string
  resultingClientId: string
  respondWith: (value: Response | Promise<Response>) => void
}) => void

/**
 * Deliver one request through the worker's **real** `fetch` listener.
 *
 * Not through `classify()` directly, which is what this harness used to do
 * (#75): no test then exercised the listener `installServiceWorker` actually
 * registers, and a browser enforces something that shape of test cannot see -
 * `respondWith()` must be called *synchronously*, before the handler returns.
 * A listener refactored to `async` and awaiting first passes a `classify()`
 * test and throws `InvalidStateError` in every real browser.
 *
 * So `respondWith` here throws exactly as the browser does once the listener
 * has returned. The rest of the fake stays a fake, and the second gap #75
 * records - a synchronous `ServiceWorker.postMessage` where the real one is
 * async - is untouched and still open.
 */
export async function dispatchFetch(
  listener: FetchListener,
  network: FakeNetwork,
  url: string,
  options: DispatchOptions = {}
): Promise<DispatchResult> {
  const init: RequestInit = { method: options.method ?? 'GET' }
  if (options.body !== undefined) init.body = options.body
  if (options.headers !== undefined) init.headers = options.headers
  const request = new Request(url, init)

  // jsdom's Request has no settable `referrer`/`mode`, and the worker reads
  // both. Layer them on rather than reimplementing Request.
  const overrides: PropertyDescriptorMap = {
    referrer: { value: options.referrer ?? '', enumerable: true },
    mode: { value: options.mode ?? 'no-cors', enumerable: true },
  }
  if (options.signal !== undefined) {
    overrides.signal = { value: options.signal, enumerable: true }
  }
  const framed = Object.create(request, overrides) as Request

  let settled: Response | Promise<Response> | null = null
  let listenerReturned = false
  const event = {
    request: framed,
    clientId: options.clientId ?? '',
    resultingClientId: options.resultingClientId ?? '',
    respondWith: (value: Response | Promise<Response>) => {
      if (listenerReturned) {
        throw new DOMException(
          'respondWith() was called after the fetch listener returned',
          'InvalidStateError'
        )
      }
      settled = value
    },
  }

  try {
    listener(event)
  } finally {
    listenerReturned = true
  }

  if (settled === null) {
    return { response: network.fetch(url), passedThrough: true }
  }
  return { response: await (settled as Response | Promise<Response>), passedThrough: false }
}

// -- assembly ----------------------------------------------------------------

export interface Harness {
  worker: LemAppServiceWorker
  bridge: ServiceWorkerBridge
  tunnel: FakeTunnel
  proxy: HTTPProxy
  clients: FakeClients
  network: FakeNetwork
  bindingStore: BindingStore
  /** Replace the worker with a fresh one over the same store, as a restart does. */
  restartWorker: () => Promise<LemAppServiceWorker>
  dispatch: (url: string, options?: DispatchOptions) => Promise<DispatchResult>
}

interface FakeWorkerHandle {
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

/**
 * Build the whole proxy: worker, bridge, tunnel and fakes, already connected.
 */
export async function createHarness(
  options: { deviceId?: string; bindingStore?: BindingStore } = {}
): Promise<Harness> {
  const deviceId = options.deviceId ?? 'dev-7f3a'
  const bindingStore = options.bindingStore ?? persistentBindingStore()
  const clients = new FakeClients()
  const network = new FakeNetwork()
  const tunnel = new FakeTunnel()
  const proxy = new HTTPProxy(tunnel)
  tunnel.proxy = proxy

  // The worker is built through `installServiceWorker`, the same entry point a
  // browser uses, so the listeners under test are the ones that ship.
  const swListeners = new Map<string, ((event: never) => void)[]>()
  const scope = {
    location: { origin: ORIGIN },
    clients,
    addEventListener: (type: string, listener: (event: never) => void) => {
      swListeners.set(type, [...(swListeners.get(type) ?? []), listener])
    },
  }

  const buildWorker = (): LemAppServiceWorker => {
    swListeners.clear()
    return installServiceWorker(scope, { bindingStore })
  }

  const emit = (type: string, event: unknown): void => {
    for (const listener of swListeners.get(type) ?? []) {
      ;(listener as (value: unknown) => void)(event)
    }
  }

  let worker = buildWorker()

  const listeners = new Map<string, Set<EventListener>>()
  const controller: FakeWorkerHandle = {
    postMessage: (message, transfer) => {
      emit('message', { data: message, ports: (transfer ?? []) as MessagePort[] })
    },
  }

  const container = {
    controller,
    register: () => Promise.resolve({}),
    ready: Promise.resolve({ active: controller }),
    addEventListener: (type: string, listener: EventListener) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener)
    },
  } as unknown as ServiceWorkerContainer

  const bridge = new ServiceWorkerBridge({
    proxyFetch: (url, init) => proxy.fetch(url, init),
    container,
    secureContext: true,
  })

  const status = await bridge.start()
  if (status.state !== 'ready') {
    throw new Error(`Harness bridge did not start: ${JSON.stringify(status)}`)
  }

  bridge.setActiveDevice(deviceId)
  bridge.setTunnelUp(true)
  await settle()

  return {
    get worker() {
      return worker
    },
    bridge,
    tunnel,
    proxy,
    clients,
    network,
    bindingStore,
    restartWorker: async () => {
      // A restarted worker keeps nothing but what it persisted, which is the
      // whole point of resolution step 4.
      worker = buildWorker()
      for (const listener of listeners.get('controllerchange') ?? []) {
        listener(new Event('controllerchange'))
      }
      await settle()
      return worker
    },
    dispatch: (url, dispatchOptions) =>
      dispatchFetch(
        (event) => {
          emit('fetch', event)
        },
        network,
        url,
        dispatchOptions
      ),
  }
}

/** Let every pending microtask and port message land. */
export async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Convenience: the app path a service is framed at. */
export function appUrl(deviceId: string, serviceId: string, rest = '/'): string {
  return `${ORIGIN}${SW_SCOPE}${deviceId}/${serviceId}${rest}`
}
