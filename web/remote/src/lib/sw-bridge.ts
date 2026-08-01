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
 * The dashboard's half of the Service Worker proxy.
 *
 * The worker owns URL resolution and constructs the `Response` objects; this
 * side owns the tunnel. That split is forced rather than chosen: an
 * `RTCDataChannel` cannot be transferred into a worker, and the browser may kill
 * an idle worker at any moment, so tunnel ownership has to live in the page.
 *
 * The page checks the device id on every `LEM_FETCH` even though the worker
 * already did. The worker's check is about which content the frame is allowed to
 * see; this one is about which tunnel the bytes may enter, and the page is the
 * side that actually holds the tunnel.
 */

import { LOCAL_API_BASE_URL } from './env'
import { LemProxyError } from './tunnel-errors'

/** Where the worker script is served. Origin root, so it can claim `/app/`. */
export const SW_SCRIPT_URL = '/lem-app-sw.js'

/** Scope the worker claims. The dashboard at `/` is deliberately outside it. */
export const SW_SCOPE = '/app/'

/** How long `navigator.serviceWorker.ready` gets before we call it unavailable. */
export const SW_READY_TIMEOUT_MS = 5000

/** Segments that can appear in `/app/<deviceId>/<serviceId>/` unescaped. */
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/

/** Why the Service Worker proxy is not available. */
export type SwUnavailableReason =
  | 'unsupported'
  | 'insecure-context'
  | 'registration-failed'
  | 'timeout'

/** Whether a service can be framed at all. */
export type SwStatus =
  | { state: 'pending' }
  | { state: 'ready' }
  | { state: 'unavailable'; reason: SwUnavailableReason }

/** The subset of `fetch` the bridge needs. */
export type ProxyFetch = (url: string, init?: RequestInit) => Promise<Response>

/**
 * The part of the bridge a viewer needs.
 *
 * Narrow on purpose: a component that could reach the whole bridge could reach
 * the tunnel, and the viewer's only business with it is session lifetime.
 */
export interface SessionRegistrar {
  openSession(deviceId: string, serviceId: string): void
  closeSession(deviceId: string, serviceId: string): void
}

/**
 * Build the same-origin path a service is viewed at.
 *
 * The device segment is mandatory. A path naming only the service is ambiguous
 * the moment the dashboard's target changes, and the worker - along with its
 * 24 h persisted bindings - outlives every React component that could have
 * cleaned up after it.
 *
 * @throws if either id would not survive the round trip through the URL
 */
export function appPath(deviceId: string, serviceId: string): string {
  if (!PATH_SEGMENT_RE.test(deviceId)) {
    throw new Error(`Device id ${deviceId} cannot appear in a service URL`)
  }
  if (!PATH_SEGMENT_RE.test(serviceId)) {
    throw new Error(`Service id ${serviceId} cannot appear in a service URL`)
  }
  return `${SW_SCOPE}${deviceId}/${serviceId}/`
}

/** Can this browser, in this context, run the proxy at all? */
export function detectUnavailability(
  container: ServiceWorkerContainer | undefined,
  secureContext: boolean
): SwUnavailableReason | null {
  if (!secureContext) return 'insecure-context'
  if (!container) return 'unsupported'
  return null
}

interface LemFetchMessage {
  type: 'LEM_FETCH'
  reqId: number
  deviceId: string
  serviceId: string
  method: string
  path: string
  headers: [string, string][]
  body: ArrayBuffer | null
}

function isLemFetch(value: unknown): value is LemFetchMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as Record<string, unknown>
  return (
    message.type === 'LEM_FETCH' &&
    typeof message.reqId === 'number' &&
    typeof message.deviceId === 'string' &&
    typeof message.serviceId === 'string' &&
    typeof message.method === 'string' &&
    typeof message.path === 'string' &&
    Array.isArray(message.headers)
  )
}

/**
 * Headers the page must not relay from the framed app.
 *
 * `X-Lem-Service` in particular: the page appends its own, and a frame that
 * could set it would choose which service its requests reach.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'x-lem-service',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
])

/**
 * Turn an upstream path into an absolute URL for `proxyFetch`.
 *
 * Built by concatenating onto a parsed origin rather than by `new URL(path,
 * base)`, because a path of `//evil.example/x` is a network-path reference:
 * resolved against a base it silently names another host.
 */
export function upstreamUrl(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`Refusing to proxy a path that is not host-relative: ${path}`)
  }
  return new URL(LOCAL_API_BASE_URL).origin + path
}

export interface ServiceWorkerBridgeOptions {
  /** Performs one request over the tunnel. */
  proxyFetch: ProxyFetch
  /** Injectable for tests; defaults to `navigator.serviceWorker`. */
  container?: ServiceWorkerContainer
  /** Injectable for tests; defaults to `window.isSecureContext`. */
  secureContext?: boolean
}

/**
 * Owns the worker registration, the `MessagePort` to it, and every exchange.
 */
export class ServiceWorkerBridge {
  private readonly proxyFetch: ProxyFetch
  private readonly container: ServiceWorkerContainer | undefined
  private readonly secureContext: boolean

  private port: MessagePort | null = null
  private activeDeviceId: string | null = null
  private tunnelUp = false
  private readonly sessions = new Set<string>()
  /** Exchanges the worker can still cancel, keyed by its request id. */
  private readonly inFlight = new Map<number, AbortController>()
  private disposed = false

  /** Exposed for tests: how many exchanges the page refused on device id. */
  deviceMismatches = 0

  constructor(options: ServiceWorkerBridgeOptions) {
    this.proxyFetch = options.proxyFetch
    this.container =
      options.container ?? (typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined)
    this.secureContext =
      options.secureContext ?? (typeof window !== 'undefined' && window.isSecureContext)
  }

  /**
   * Register the worker and hand it a port.
   *
   * Never throws: a dashboard whose worker will not register still has a working
   * control plane, and reporting *why* is more useful than a rejected promise.
   */
  async start(): Promise<SwStatus> {
    const unavailable = detectUnavailability(this.container, this.secureContext)
    if (unavailable !== null) return { state: 'unavailable', reason: unavailable }

    const container = this.container
    if (!container) return { state: 'unavailable', reason: 'unsupported' }

    try {
      await container.register(SW_SCRIPT_URL, { scope: SW_SCOPE, type: 'module' })
    } catch (error) {
      console.error('[sw-bridge] Registration failed:', error)
      return { state: 'unavailable', reason: 'registration-failed' }
    }

    let registration: ServiceWorkerRegistration
    try {
      registration = await withTimeout(container.ready, SW_READY_TIMEOUT_MS)
    } catch {
      return { state: 'unavailable', reason: 'timeout' }
    }

    // The worker broadcasts LEM_BRIDGE_HELLO when it activates, and a browser
    // that recycled an idle worker will do exactly that on the next request.
    container.addEventListener('message', this.onContainerMessage)
    container.addEventListener('controllerchange', this.onControllerChange)

    this.attach(registration.active ?? container.controller ?? registration.installing)
    return { state: 'ready' }
  }

  /** Which device the tunnel is connected to. Sent before any session opens. */
  setActiveDevice(deviceId: string): void {
    if (this.activeDeviceId !== deviceId) {
      // The worker clears its sessions on a device change; mirror that here so
      // a re-init does not replay sessions for a device we have left.
      this.sessions.clear()
    }
    this.activeDeviceId = deviceId
    this.post({ type: 'LEM_ACTIVE_DEVICE', deviceId })
  }

  /** Tunnel liveness. The worker refuses everything until this is true. */
  setTunnelUp(up: boolean): void {
    this.tunnelUp = up
    this.post({ type: up ? 'LEM_TUNNEL_UP' : 'LEM_TUNNEL_DOWN' })
  }

  /** Open a service session. Must complete before the iframe is created. */
  openSession(deviceId: string, serviceId: string): void {
    this.sessions.add(`${deviceId} ${serviceId}`)
    this.post({ type: 'LEM_SESSION_OPEN', deviceId, serviceId })
  }

  /** Close a service session; the worker answers 410 for it afterwards. */
  closeSession(deviceId: string, serviceId: string): void {
    this.sessions.delete(`${deviceId} ${serviceId}`)
    this.post({ type: 'LEM_SESSION_CLOSE', deviceId, serviceId })
  }

  /** Drop the port, abort everything outstanding, and stop listening. */
  dispose(): void {
    this.disposed = true
    for (const abort of this.inFlight.values()) abort.abort()
    this.inFlight.clear()
    this.container?.removeEventListener('message', this.onContainerMessage)
    this.container?.removeEventListener('controllerchange', this.onControllerChange)
    this.port?.close()
    this.port = null
  }

  private readonly onContainerMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown } | null
    if (data?.type === 'LEM_BRIDGE_HELLO') {
      this.attach(this.container?.controller ?? null)
    }
  }

  private readonly onControllerChange = (): void => {
    this.attach(this.container?.controller ?? null)
  }

  /**
   * Hand a (possibly restarted) worker a fresh port and replay our state.
   *
   * The worker keeps nothing across a restart, so everything it needs to answer
   * a request - the active device, the open sessions, tunnel liveness - is
   * re-sent here. Without the replay a recycled worker answers `503` until the
   * user reloads.
   */
  private attach(worker: ServiceWorker | null | undefined): void {
    if (this.disposed || !worker) return
    const channel = new MessageChannel()
    channel.port1.onmessage = (event) => {
      this.onWorkerMessage(event)
    }
    channel.port1.start()
    this.port?.close()
    this.port = channel.port1
    worker.postMessage({ type: 'LEM_BRIDGE_INIT' }, [channel.port2])

    if (this.activeDeviceId !== null) {
      this.post({ type: 'LEM_ACTIVE_DEVICE', deviceId: this.activeDeviceId })
    }
    this.post({ type: this.tunnelUp ? 'LEM_TUNNEL_UP' : 'LEM_TUNNEL_DOWN' })
    for (const key of this.sessions) {
      const [deviceId, serviceId] = key.split(' ')
      this.post({ type: 'LEM_SESSION_OPEN', deviceId, serviceId })
    }
  }

  private post(message: Record<string, unknown>): void {
    this.port?.postMessage(message)
  }

  private onWorkerMessage(event: MessageEvent): void {
    const data = event.data as { type?: unknown; reqId?: unknown } | null

    if (data?.type === 'LEM_CANCEL' && typeof data.reqId === 'number') {
      // The frame walked away. Abort the exchange so the far side stops
      // producing rather than streaming a body nobody will read.
      this.inFlight.get(data.reqId)?.abort()
      return
    }

    if (!isLemFetch(event.data)) return
    const port = event.ports[0]
    if (port === undefined) {
      console.error('[sw-bridge] LEM_FETCH arrived with no reply port; dropping it')
      return
    }
    void this.runExchange(event.data, port)
  }

  /**
   * Perform one framed-app request over the tunnel and stream it back.
   */
  private async runExchange(message: LemFetchMessage, port: MessagePort): Promise<void> {
    const reqId = message.reqId
    const finish = (): void => {
      this.inFlight.delete(reqId)
      port.close()
    }
    const fail = (code: string, detail: string): void => {
      port.postMessage({ type: 'LEM_RESPONSE_ERROR', reqId, code, message: detail })
      finish()
    }

    // The page owns the tunnel, so the page re-checks. Refusing here means no
    // frame reaches the wire for a request bound to a device we have left.
    if (message.deviceId !== this.activeDeviceId) {
      this.deviceMismatches += 1
      fail('E_DEVICE_MISMATCH', `Request is bound to device ${message.deviceId}`)
      return
    }

    let target: string
    try {
      target = upstreamUrl(message.path)
    } catch (error) {
      fail('E_PROTO_MALFORMED', error instanceof Error ? error.message : String(error))
      return
    }

    const headers: [string, string][] = message.headers.filter(
      ([name]) => !DROPPED_REQUEST_HEADERS.has(name.toLowerCase())
    )
    headers.push(['X-Lem-Service', message.serviceId])

    const abort = new AbortController()
    this.inFlight.set(reqId, abort)

    let response: Response
    try {
      response = await this.proxyFetch(target, {
        method: message.method,
        headers,
        body: message.body === null ? undefined : message.body,
        signal: abort.signal,
      })
    } catch (error) {
      fail(codeFor(error), error instanceof Error ? error.message : String(error))
      return
    }

    port.postMessage({
      type: 'LEM_RESPONSE_HEAD',
      reqId,
      status: response.status,
      headers: [...response.headers.entries()],
    })

    const body = response.body
    if (body === null) {
      port.postMessage({ type: 'LEM_RESPONSE_END', reqId })
      finish()
      return
    }

    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.byteLength === 0) continue
        // slice(), not the whole `value.buffer`: a chunk is often a view into
        // a larger pooled buffer, and transferring that would move bytes the
        // reader still owns.
        const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        port.postMessage({ type: 'LEM_RESPONSE_CHUNK', reqId, buf: buffer }, [buffer])
      }
    } catch (error) {
      // The stream errored rather than ended: an over-cap body, a cancel, or a
      // dead transport. Reporting it as an error is what stops the frame from
      // treating a truncated body as complete.
      fail(codeFor(error), error instanceof Error ? error.message : String(error))
      return
    }

    port.postMessage({ type: 'LEM_RESPONSE_END', reqId })
    finish()
  }
}

/** Map a thrown value onto the shared error taxonomy. */
function codeFor(error: unknown): string {
  return error instanceof LemProxyError ? error.code : 'E_INTERNAL'
}

/** Reject if a promise has not settled in time. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
