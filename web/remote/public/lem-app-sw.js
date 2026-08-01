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
 * Lem app Service Worker: the same-origin proxy for framed services.
 *
 * A service is viewed at `/app/<deviceId>/<serviceId>/…` on the dashboard's own
 * origin. This worker is scoped to `/app/`, so it controls the iframe document
 * and therefore sees *every* request that document makes - subresources,
 * `fetch`, `import()`, worker scripts, `<img src>`, CSS `url()` - including the
 * root-relative ones that carry no prefix. Nothing else catches all of those:
 * URL rewriting misses runtime-constructed URLs, and patching `fetch` in the
 * frame's realm misses everything the platform loads on the app's behalf.
 *
 * The worker holds **no** tunnel state. It cannot: an `RTCDataChannel` cannot be
 * transferred into a worker, and the browser may kill and restart this script at
 * any moment. Every request is handed to the dashboard page over a `MessagePort`
 * and the page performs it over the tunnel.
 *
 * Two rules are load-bearing and neither is an optimisation:
 *
 * - A cross-origin request from a controlled client is **not** intercepted at
 *   all. The tunnel must never become an open proxy from the user's home
 *   network to arbitrary internet hosts.
 * - A request whose `<deviceId>` is not the active tunnel's device is answered
 *   `409` and **never re-routed**. A stale frame that shows an error is
 *   diagnosable; a stale frame quietly showing another machine's data is not.
 *
 * This file lives in `public/` and is served verbatim at `/lem-app-sw.js`, so it
 * is authored as a checked ES module rather than compiled from `src/`: the URL
 * has to be at the origin root for the `/app/` scope to be claimable, and a
 * build step between the source and the served bytes is a place for the two to
 * disagree. `tsconfig.app.json` type-checks it via `checkJs`.
 */

// -- constants ---------------------------------------------------------------

/** Path prefix the worker is scoped to. */
export const APP_PREFIX = '/app/'

/** Where this script is served. A controlled client may not read it. */
export const SW_SCRIPT_PATH = '/lem-app-sw.js'

/** How long a request waits for a cold-started worker's page to re-init. */
export const BRIDGE_WAIT_MS = 3000

/** Lifetime of a persisted client binding. */
export const BINDING_TTL_MS = 24 * 60 * 60 * 1000

/** CSP the worker substitutes for whatever the upstream sent. */
export const SUBSTITUTED_CSP = "frame-ancestors 'self'; base-uri 'self'"

/**
 * Grammar for `/app/<deviceId>/<serviceId>[/rest]`.
 *
 * Both segments are bounded and restricted to characters that cannot introduce
 * a path traversal or a second path segment, so a device or service id from the
 * URL can be compared and forwarded without further escaping.
 */
export const APP_PATH_RE = /^\/app\/([A-Za-z0-9._-]{1,64})\/([A-Za-z0-9._-]{1,64})(\/.*)?$/

/**
 * The subset of the spec's error taxonomy this worker renders itself.
 *
 * `src/lib/tunnel-errors.ts` holds the full table; a test cross-checks these
 * statuses against it, because a worker in `public/` cannot import from `src/`
 * and two hand-maintained tables are how `FrameType` drifted once already.
 */
export const ERROR_STATUS = {
  E_NO_SESSION: 421,
  E_DEVICE_MISMATCH: 409,
  E_SW_FORBIDDEN: 403,
  E_BRIDGE_UNAVAILABLE: 503,
  E_TUNNEL_DOWN: 503,
  E_SESSION_CLOSED: 410,
  E_TIMEOUT_HEAD: 504,
  E_TIMEOUT_STREAM: 504,
  E_TOO_LARGE: 502,
  E_PROTO_VERSION: 502,
  E_PROTO_V2_FRAME: 502,
  E_PROTO_MALFORMED: 502,
  E_UPSTREAM: 502,
  E_UNKNOWN_SERVICE: 502,
  E_INTERNAL: 500,
}

/**
 * Response headers dropped before the `Response` is constructed.
 *
 * These were written for the app's own origin. An upstream CSP would block the
 * shim the worker injects; an upstream `Strict-Transport-Security` would let a
 * framed app pin the *dashboard's* origin to HTTPS-only in the user's browser,
 * which is a denial of service against Lem itself.
 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
])

/**
 * Cross-realm `ArrayBuffer` test.
 *
 * A structured clone that crossed a `MessagePort` may carry a buffer from
 * another realm, and `instanceof` compares constructor identity, not shape. The
 * brand check does not care which realm minted it. (`instanceof` is right often
 * enough in a browser to hide this until a chunk is silently dropped.)
 *
 * @param {unknown} value
 * @returns {value is ArrayBuffer}
 */
function isArrayBuffer(value) {
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]'
}

/** Statuses that must not carry a body (RFC 9110). */
const BODYLESS_STATUSES = new Set([101, 103, 204, 205, 304])

/** Hosts an upstream `Location` may name that are really *the far machine*. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

// -- types -------------------------------------------------------------------

/** @typedef {{ deviceId: string, serviceId: string }} Binding */
/** @typedef {{ deviceId: string, serviceId: string, expiresAt: number }} StoredBinding */

/**
 * @typedef {object} BindingStore
 * @property {(clientId: string) => Promise<StoredBinding | null>} get
 * @property {(clientId: string, binding: StoredBinding) => Promise<void>} put
 */

/**
 * @typedef {object} SwClient
 * @property {string} id
 * @property {string} url
 * @property {(message: unknown) => void} postMessage
 */

/**
 * @typedef {object} SwClients
 * @property {(id: string) => Promise<SwClient | undefined>} get
 * @property {(options?: { includeUncontrolled?: boolean, type?: string }) => Promise<SwClient[]>} matchAll
 */

/**
 * @typedef {object} SwFetchEvent
 * @property {Request} request
 * @property {string} [clientId]
 * @property {string} [resultingClientId]
 * @property {(response: Response | Promise<Response>) => void} respondWith
 */

// -- pure helpers ------------------------------------------------------------

/**
 * Split an `/app/` path into its parts.
 *
 * @param {string} pathname
 * @returns {{ deviceId: string, serviceId: string, path: string } | null}
 */
export function parseAppPath(pathname) {
  const match = APP_PATH_RE.exec(pathname)
  if (match === null) return null
  // `.` is in the character class, so `.` and `..` match the grammar. A browser
  // normalises those away before a request is issued, but the worker also reads
  // paths out of referrers and stored records, and a segment that means
  // "somewhere else" must never become a device or service id.
  if (isDotSegment(match[1]) || isDotSegment(match[2])) return null
  return { deviceId: match[1], serviceId: match[2], path: match[3] || '/' }
}

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isDotSegment(segment) {
  return segment === '.' || segment === '..'
}

/**
 * Read a `{deviceId, serviceId}` out of any same-origin `/app/` URL.
 *
 * Used for the referrer (step 2) and for `client.url` (step 3). Both are URLs
 * of documents *inside* a service session, so both carry the full prefix.
 *
 * @param {string | null | undefined} raw
 * @param {string} origin
 * @returns {Binding | null}
 */
export function bindingFromUrl(raw, origin) {
  // A Service Worker reports "no referrer" as either the empty string or the
  // literal `about:client`, depending on the browser and the request.
  if (!raw || raw === 'about:client') return null
  let url
  try {
    url = new URL(raw, origin)
  } catch {
    return null
  }
  if (url.origin !== origin) return null
  const parsed = parseAppPath(url.pathname)
  if (parsed === null) return null
  return { deviceId: parsed.deviceId, serviceId: parsed.serviceId }
}

/**
 * Build an RFC 7807 problem detail response, the same shape the local server
 * already uses for its own errors.
 *
 * @param {keyof typeof ERROR_STATUS} code
 * @param {string} detail
 * @returns {Response}
 */
export function problemResponse(code, detail) {
  const status = ERROR_STATUS[code]
  const body = JSON.stringify({
    type: `https://lem.gg/errors/${code.toLowerCase().replace(/_/g, '-')}`,
    title: code,
    status,
    detail,
    code,
  })
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/problem+json',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': SUBSTITUTED_CSP,
    },
  })
}

/**
 * Re-prefix an upstream `Location` so a redirect stays inside the frame.
 *
 * Carries the **request's** device segment, never the active one: the answer to
 * a request belongs to the device that request named, and substituting the
 * active device here would reintroduce exactly the silent re-routing the
 * `409` exists to prevent.
 *
 * Root-relative paths and absolute loopback URLs are rewritten - a loopback
 * absolute URL is *the far machine's* address, and handing it to the remote
 * browser verbatim is defect #1 of the tracking issue in miniature. Anything
 * else (a real external origin) passes through untouched.
 *
 * @param {string} location Raw upstream Location header
 * @param {string} deviceId Device segment of the request being answered
 * @param {string} serviceId Service segment of the request being answered
 * @param {string} upstreamPath Path the request was made to, for relative refs
 * @returns {string}
 */
export function rewriteLocation(location, deviceId, serviceId, upstreamPath) {
  const prefix = `${APP_PREFIX}${deviceId}/${serviceId}`
  const trimmed = location.trim()
  if (trimmed === '') return location

  // Protocol-relative (`//host/path`) names another origin; leave it alone.
  if (trimmed.startsWith('//')) return location

  if (trimmed.startsWith('/')) return prefix + trimmed

  let absolute
  try {
    absolute = new URL(trimmed)
  } catch {
    // A relative reference: resolve it against the upstream path we asked for,
    // then re-prefix the result.
    try {
      const resolved = new URL(trimmed, `http://upstream.invalid${upstreamPath}`)
      return prefix + resolved.pathname + resolved.search + resolved.hash
    } catch {
      return location
    }
  }

  if (LOOPBACK_HOSTS.has(absolute.hostname)) {
    return prefix + absolute.pathname + absolute.search + absolute.hash
  }
  return location
}

/**
 * Build the `Headers` for a proxied response.
 *
 * @param {[string, string][]} pairs Upstream header pairs, in order
 * @param {{ deviceId: string, serviceId: string, upstreamPath: string }} context
 * @returns {Headers}
 */
export function buildResponseHeaders(pairs, context) {
  const headers = new Headers()
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase()
    if (STRIPPED_RESPONSE_HEADERS.has(lower)) continue
    if (lower === 'location') {
      // append, never set: duplicates are why the wire carries pairs at all,
      // and Set-Cookie in particular must survive or login breaks.
      headers.append(
        name,
        rewriteLocation(value, context.deviceId, context.serviceId, context.upstreamPath)
      )
      continue
    }
    headers.append(name, value)
  }
  headers.set('Content-Security-Policy', SUBSTITUTED_CSP)
  return headers
}

/**
 * An in-memory binding store, used when IndexedDB is unavailable.
 *
 * Degrades resolution step 4 to a no-op rather than failing the worker: steps
 * 1-3 still resolve every request from a live document.
 *
 * @returns {BindingStore}
 */
export function createMemoryBindingStore() {
  /** @type {Map<string, StoredBinding>} */
  const records = new Map()
  return {
    get: (clientId) => Promise.resolve(records.get(clientId) ?? null),
    put: (clientId, binding) => {
      records.set(clientId, binding)
      return Promise.resolve()
    },
  }
}

/**
 * An IndexedDB-backed binding store.
 *
 * The in-memory map is lost every time the browser kills an idle worker, which
 * it does aggressively. This is what lets a request from a document the worker
 * has forgotten still be attributed - and, just as importantly, still be
 * attributed to the device it was opened for, so a binding written hours ago
 * for another machine is *detectable* rather than invisible.
 *
 * @param {IDBFactory | undefined} factory
 * @returns {BindingStore}
 */
export function createIndexedDbBindingStore(factory) {
  if (!factory) return createMemoryBindingStore()
  const idb = factory

  /** @type {Promise<IDBDatabase> | null} */
  let opening = null

  function open() {
    if (opening !== null) return opening
    opening = new Promise((resolve, reject) => {
      const request = idb.open('lem-sw', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('clientBindings', { keyPath: 'clientId' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    })
    return opening
  }

  return {
    async get(clientId) {
      const db = await open()
      return await new Promise((resolve) => {
        const request = db
          .transaction('clientBindings', 'readonly')
          .objectStore('clientBindings')
          .get(clientId)
        request.onsuccess = () => {
          const record = /** @type {StoredBinding | undefined} */ (request.result)
          resolve(record ?? null)
        }
        request.onerror = () => resolve(null)
      })
    },
    async put(clientId, binding) {
      const db = await open()
      await new Promise((resolve) => {
        const request = db
          .transaction('clientBindings', 'readwrite')
          .objectStore('clientBindings')
          .put({ clientId, ...binding })
        request.onsuccess = () => resolve(undefined)
        request.onerror = () => resolve(undefined)
      })
    },
  }
}

// -- the worker --------------------------------------------------------------

/**
 * The worker's whole decision surface, as a class so tests can drive it without
 * a browser and so a restart is expressible as "construct a new one over the
 * same persistent store".
 */
export class LemAppServiceWorker {
  /**
   * @param {object} options
   * @param {string} options.origin This worker's origin
   * @param {SwClients} options.clients The `clients` API
   * @param {BindingStore} options.bindingStore Persistent client bindings
   * @param {() => number} [options.now] Clock, for TTL expiry
   */
  constructor({ origin, clients, bindingStore, now = Date.now }) {
    this.origin = origin
    this.clients = clients
    this.bindingStore = bindingStore
    this.now = now

    /** Bindings for live clients. Lost on every worker restart, by design. */
    this.clientBindings = /** @type {Map<string, Binding>} */ (new Map())

    /** Exactly one active device, ever. Null until the page says otherwise. */
    this.activeDeviceId = /** @type {string | null} */ (null)

    /** Open sessions, keyed `deviceId serviceId`. */
    this.sessions = /** @type {Set<string>} */ (new Set())

    /** The page's end of the bridge. The page pushes it; we never hunt for it. */
    this.bridgePort = /** @type {MessagePort | null} */ (null)

    /**
     * Refused until the page says the tunnel is up. Fail-closed: a request
     * proxied into a dead tunnel becomes a hang, and a hang is the failure mode
     * this design exists to remove.
     */
    this.tunnelUp = false

    /** @type {(() => void)[]} */
    this.bridgeWaiters = []

    this.nextRequestId = 1

    /**
     * Counters the acceptance tests read.
     *
     * `singleSessionFallbacks` is the one that matters: routinely reaching
     * resolution step 5 means steps 1-4 have a bug, and the only way to know is
     * to count it.
     */
    this.stats = {
      resolvedByMemory: 0,
      resolvedByReferrer: 0,
      resolvedByClientUrl: 0,
      resolvedByStore: 0,
      singleSessionFallbacks: 0,
      unresolved: 0,
      deviceMismatches: 0,
      forbidden: 0,
      bridgeTimeouts: 0,
      passedThrough: 0,
    }
  }

  // -- page messages ---------------------------------------------------------

  /**
   * Handle one message from the dashboard page.
   *
   * @param {unknown} data
   * @param {readonly MessagePort[]} ports
   * @returns {void}
   */
  handleMessage(data, ports = []) {
    if (typeof data !== 'object' || data === null) return
    const message = /** @type {Record<string, unknown>} */ (data)

    switch (message.type) {
      case 'LEM_BRIDGE_INIT': {
        const port = ports[0]
        if (!port) return
        this.bridgePort = port
        port.onmessage = (event) => this.handleMessage(event.data)
        port.start?.()
        this.notifyBridgeWaiters()
        return
      }
      case 'LEM_ACTIVE_DEVICE': {
        const deviceId = message.deviceId
        if (typeof deviceId !== 'string') return
        if (deviceId !== this.activeDeviceId) {
          // Sessions belong to the device they were opened on. Keeping them
          // would make the single-session fallback answer for a device that is
          // no longer connected.
          this.sessions.clear()
          this.clientBindings.clear()
        }
        this.activeDeviceId = deviceId
        this.notifyBridgeWaiters()
        return
      }
      case 'LEM_SESSION_OPEN': {
        const key = sessionKey(message.deviceId, message.serviceId)
        if (key !== null) this.sessions.add(key)
        return
      }
      case 'LEM_SESSION_CLOSE': {
        const key = sessionKey(message.deviceId, message.serviceId)
        if (key !== null) this.sessions.delete(key)
        return
      }
      case 'LEM_TUNNEL_UP':
        this.tunnelUp = true
        return
      case 'LEM_TUNNEL_DOWN':
        this.tunnelUp = false
        return
      default:
        return
    }
  }

  /** Wake everything waiting on a cold-started bridge. */
  notifyBridgeWaiters() {
    if (!this.bridgeIsReady()) return
    const waiters = this.bridgeWaiters
    this.bridgeWaiters = []
    for (const resolve of waiters) resolve()
  }

  /**
   * The bridge is usable once the page has both handed over a port and told us
   * which device it is connected to. Waiting for the second is what stops a
   * cold-started worker from answering `409` to a perfectly good request
   * merely because it has not been told anything yet.
   *
   * @returns {boolean}
   */
  bridgeIsReady() {
    return this.bridgePort !== null && this.activeDeviceId !== null
  }

  /**
   * Wait up to `BRIDGE_WAIT_MS` for the page to re-initialise the bridge.
   *
   * @returns {Promise<MessagePort | null>}
   */
  async waitForBridge() {
    if (this.bridgeIsReady()) return this.bridgePort
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.bridgeWaiters = this.bridgeWaiters.filter((waiter) => waiter !== onReady)
        resolve(undefined)
      }, BRIDGE_WAIT_MS)
      const onReady = () => {
        clearTimeout(timer)
        resolve(undefined)
      }
      this.bridgeWaiters.push(onReady)
    })
    if (!this.bridgeIsReady()) {
      this.stats.bridgeTimeouts += 1
      return null
    }
    return this.bridgePort
  }

  // -- fetch -----------------------------------------------------------------

  /**
   * Decide, synchronously, whether this request is ours.
   *
   * Returning `null` means "do not call `respondWith`", which leaves the
   * browser to perform the request exactly as it would with no Service Worker
   * installed. That is the only correct answer for a cross-origin URL: a
   * refusal would break apps that legitimately load a public CDN, and proxying
   * it would turn the tunnel into an open proxy onto the user's home network.
   *
   * @param {SwFetchEvent} event
   * @returns {Promise<Response> | null}
   */
  classify(event) {
    let url
    try {
      url = new URL(event.request.url)
    } catch {
      return null
    }

    // A. Not our origin -> not ours.
    if (url.origin !== this.origin) {
      this.stats.passedThrough += 1
      return null
    }

    // The worker's own source is dashboard-owned. A framed app must not be able
    // to read the bridge protocol out of it or trigger a re-registration.
    if (url.pathname === SW_SCRIPT_PATH) {
      this.stats.forbidden += 1
      return Promise.resolve(
        problemResponse('E_SW_FORBIDDEN', 'The service worker source is not readable from an app.')
      )
    }

    // B. An explicit prefix wins, always.
    const parsed = parseAppPath(url.pathname)
    if (parsed !== null) {
      if (event.request.mode === 'navigate' && event.resultingClientId) {
        // resultingClientId, not clientId: at navigation the document being
        // created is the one that will own every subsequent subresource.
        this.bindClient(event.resultingClientId, parsed)
      }
      return this.proxy(parsed.deviceId, parsed.serviceId, parsed.path + url.search, event.request)
    }

    // C. No prefix: the owning client decides.
    return this.resolveAndProxy(event, url)
  }

  /**
   * Resolve a prefix-less same-origin request to a session and proxy it.
   *
   * @param {SwFetchEvent} event
   * @param {URL} url
   * @returns {Promise<Response>}
   */
  async resolveAndProxy(event, url) {
    const binding = await this.resolveBindingForClient(event)
    if (binding === null) {
      this.stats.unresolved += 1
      return problemResponse(
        'E_NO_SESSION',
        `No service session owns ${url.pathname}. Reload the service from the dashboard.`
      )
    }
    return await this.proxy(
      binding.deviceId,
      binding.serviceId,
      url.pathname + url.search,
      event.request
    )
  }

  /**
   * Resolution steps 1-6 of the spec, in order, stopping at the first hit.
   *
   * Every step yields a `{deviceId, serviceId}` pair rather than a bare service
   * id. That is the whole reason a stale binding is detectable: the device
   * travels with the binding, so the caller can reject it instead of quietly
   * forwarding to whichever machine happens to be connected now.
   *
   * @param {SwFetchEvent} event
   * @returns {Promise<Binding | null>}
   */
  async resolveBindingForClient(event) {
    const clientId = event.clientId ?? ''

    // 1. In-memory map.
    if (clientId) {
      const cached = this.clientBindings.get(clientId)
      if (cached) {
        this.stats.resolvedByMemory += 1
        return cached
      }
    }

    // 2. Referrer. The cheapest signal, and the one an app can switch off.
    const fromReferrer = bindingFromUrl(event.request.referrer, this.origin)
    if (fromReferrer !== null) {
      this.stats.resolvedByReferrer += 1
      if (clientId) this.bindClient(clientId, fromReferrer)
      return fromReferrer
    }

    // 3. The client's own URL. Survives `Referrer-Policy: no-referrer`, and
    //    works for window, worker and sharedworker clients alike - a worker the
    //    app spawned was itself loaded from inside the prefix.
    if (clientId) {
      const client = await this.clients.get(clientId)
      const fromClient = client ? bindingFromUrl(client.url, this.origin) : null
      if (fromClient !== null) {
        this.stats.resolvedByClientUrl += 1
        this.bindClient(clientId, fromClient)
        return fromClient
      }
    }

    // 4. Persisted bindings: the map above is gone after every worker restart.
    if (clientId) {
      const stored = await this.bindingStore.get(clientId)
      if (stored !== null && stored.expiresAt > this.now()) {
        const binding = { deviceId: stored.deviceId, serviceId: stored.serviceId }
        this.stats.resolvedByStore += 1
        this.clientBindings.set(clientId, binding)
        return binding
      }
    }

    // 5. Single open session on the active device. Sessions for any other
    //    device are not candidates - guessing across machines is the failure
    //    this design is built to prevent.
    const candidates = [...this.sessions]
      .map(parseSessionKey)
      .filter((session) => session.deviceId === this.activeDeviceId)
    if (candidates.length === 1) {
      this.stats.singleSessionFallbacks += 1
      console.warn(
        `[lem-sw] Fell back to the single open session for ${event.request.url}; ` +
          'steps 1-4 should have resolved this.'
      )
      return candidates[0]
    }

    // 6. Fail closed. Never guess between two sessions.
    return null
  }

  /**
   * Record a binding, in memory now and in storage shortly.
   *
   * The in-memory write is synchronous on purpose: a navigation's subresources
   * can arrive in the same task, long before an IndexedDB transaction settles.
   *
   * @param {string} clientId
   * @param {Binding} binding
   * @returns {void}
   */
  bindClient(clientId, binding) {
    this.clientBindings.set(clientId, binding)
    void this.bindingStore
      .put(clientId, { ...binding, expiresAt: this.now() + BINDING_TTL_MS })
      .catch(() => {
        // A worker that cannot persist bindings still resolves every request
        // from a live document via steps 1-3.
      })
  }

  /**
   * Is a session open for this exact (device, service) pair?
   *
   * @param {string} deviceId
   * @param {string} serviceId
   * @returns {boolean}
   */
  hasSession(deviceId, serviceId) {
    const key = sessionKey(deviceId, serviceId)
    return key !== null && this.sessions.has(key)
  }

  /**
   * Perform one request over the page's tunnel.
   *
   * @param {string} deviceId Device the request named
   * @param {string} serviceId Service the request named
   * @param {string} upstreamPath Path to ask the upstream for, including query
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async proxy(deviceId, serviceId, upstreamPath, request) {
    const bridge = await this.waitForBridge()
    if (bridge === null) {
      return problemResponse(
        'E_BRIDGE_UNAVAILABLE',
        'The Lem dashboard is not reachable from this frame. Reload the dashboard tab.'
      )
    }

    // The device check. After the bridge, so a cold-started worker is not
    // answering out of ignorance; before anything is handed to the page, so a
    // mismatch puts no frame on the wire. Never re-routed to the active device.
    if (deviceId !== this.activeDeviceId) {
      this.stats.deviceMismatches += 1
      return problemResponse(
        'E_DEVICE_MISMATCH',
        `This view belongs to device ${deviceId}, but the dashboard is connected to ` +
          `${String(this.activeDeviceId)}. Reload the dashboard and open the service again.`
      )
    }

    if (!this.hasSession(deviceId, serviceId)) {
      return problemResponse(
        'E_SESSION_CLOSED',
        `The session for ${serviceId} is closed. Open the service again from the dashboard.`
      )
    }

    if (!this.tunnelUp) {
      return problemResponse('E_TUNNEL_DOWN', 'The tunnel to your device is down.')
    }

    /** @type {ArrayBuffer | null} */
    let body = null
    if (request.body !== null && request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.arrayBuffer()
    }

    const headers = /** @type {[string, string][]} */ ([...request.headers.entries()])
    const reqId = this.nextRequestId
    this.nextRequestId = this.nextRequestId >= 0xffffffff ? 1 : this.nextRequestId + 1

    return await this.exchange(bridge, {
      reqId,
      deviceId,
      serviceId,
      upstreamPath,
      method: request.method,
      headers,
      body,
      signal: request.signal,
    })
  }

  /**
   * Run one request/response exchange over a fresh `MessageChannel`.
   *
   * The `Response` resolves as soon as the head arrives, wrapping a
   * `ReadableStream` that later chunks feed. That is what makes a `<script>`
   * start executing and model tokens paint as they arrive, instead of the whole
   * body being buffered before the frame sees any of it.
   *
   * @param {MessagePort} bridge
   * @param {object} exchange
   * @param {number} exchange.reqId
   * @param {string} exchange.deviceId
   * @param {string} exchange.serviceId
   * @param {string} exchange.upstreamPath
   * @param {string} exchange.method
   * @param {[string, string][]} exchange.headers
   * @param {ArrayBuffer | null} exchange.body
   * @param {AbortSignal} [exchange.signal]
   * @returns {Promise<Response>}
   */
  exchange(bridge, exchange) {
    const channel = new MessageChannel()
    const port = channel.port1

    return new Promise((resolve) => {
      /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
      let controller = null
      let headSettled = false

      const finish = () => {
        port.onmessage = null
        port.close?.()
      }

      /** @param {string} code */
      const fail = (code) => {
        const known = code in ERROR_STATUS ? /** @type {keyof typeof ERROR_STATUS} */ (code) : null
        if (controller !== null) {
          // error(), never close(): a closed stream hands the app a truncated
          // body it believes is whole, which is silent corruption. An errored
          // one rejects the frame's fetch exactly as an interrupted download
          // does.
          controller.error(new Error(known ?? 'E_INTERNAL'))
          controller = null
          finish()
          return
        }
        if (!headSettled) {
          headSettled = true
          resolve(
            problemResponse(
              known ?? 'E_INTERNAL',
              `The tunnel could not complete this request (${code}).`
            )
          )
        }
        finish()
      }

      port.onmessage = (event) => {
        const message = /** @type {Record<string, unknown>} */ (event.data)
        switch (message?.type) {
          case 'LEM_RESPONSE_HEAD': {
            if (headSettled) return
            headSettled = true
            const status = typeof message.status === 'number' ? message.status : 502
            const pairs = /** @type {[string, string][]} */ (message.headers ?? [])
            const responseHeaders = buildResponseHeaders(pairs, {
              deviceId: exchange.deviceId,
              serviceId: exchange.serviceId,
              upstreamPath: exchange.upstreamPath,
            })
            if (BODYLESS_STATUSES.has(status)) {
              resolve(new Response(null, { status, headers: responseHeaders }))
              finish()
              return
            }
            const stream = new ReadableStream({
              start: (streamController) => {
                controller = streamController
              },
              cancel: () => {
                controller = null
                bridge.postMessage({ type: 'LEM_CANCEL', reqId: exchange.reqId })
                finish()
              },
            })
            resolve(new Response(stream, { status, headers: responseHeaders }))
            return
          }
          case 'LEM_RESPONSE_CHUNK': {
            const buffer = message.buf
            if (controller !== null && isArrayBuffer(buffer)) {
              controller.enqueue(new Uint8Array(buffer))
            }
            return
          }
          case 'LEM_RESPONSE_END': {
            controller?.close()
            controller = null
            finish()
            return
          }
          case 'LEM_RESPONSE_ERROR': {
            fail(typeof message.code === 'string' ? message.code : 'E_INTERNAL')
            return
          }
          default:
            return
        }
      }
      port.start?.()

      exchange.signal?.addEventListener(
        'abort',
        () => {
          bridge.postMessage({ type: 'LEM_CANCEL', reqId: exchange.reqId })
        },
        { once: true }
      )

      /** @type {Transferable[]} */
      const transfer = [channel.port2]
      if (exchange.body !== null) transfer.push(exchange.body)

      // The reply port travels in the transfer list only, never in the message
      // body: the page reads it from `event.ports[0]`.
      bridge.postMessage(
        {
          type: 'LEM_FETCH',
          reqId: exchange.reqId,
          deviceId: exchange.deviceId,
          serviceId: exchange.serviceId,
          method: exchange.method,
          path: exchange.upstreamPath,
          headers: exchange.headers,
          body: exchange.body,
        },
        transfer
      )
    })
  }
}

/**
 * Build a session key, rejecting anything that is not a pair of strings.
 *
 * @param {unknown} deviceId
 * @param {unknown} serviceId
 * @returns {string | null}
 */
function sessionKey(deviceId, serviceId) {
  if (typeof deviceId !== 'string' || typeof serviceId !== 'string') return null
  if (deviceId === '' || serviceId === '') return null
  return `${deviceId} ${serviceId}`
}

/**
 * @param {string} key
 * @returns {Binding}
 */
function parseSessionKey(key) {
  const [deviceId, serviceId] = key.split(' ')
  return { deviceId, serviceId }
}

// -- worker wiring -----------------------------------------------------------

/**
 * @typedef {object} LemSwScope
 * @property {{ origin: string }} location
 * @property {SwClients} clients
 * @property {(type: string, listener: (event: never) => void) => void} addEventListener
 * @property {IDBFactory} [indexedDB]
 */

/**
 * Attach the worker to a real `ServiceWorkerGlobalScope`.
 *
 * Exported so a test can drive the wiring with a fake scope; called below for
 * the real one.
 *
 * @param {LemSwScope} scope
 * @returns {LemAppServiceWorker}
 */
export function installServiceWorker(scope) {
  const worker = new LemAppServiceWorker({
    origin: scope.location.origin,
    clients: scope.clients,
    bindingStore: createIndexedDbBindingStore(scope.indexedDB),
  })

  // No skipWaiting()/clients.claim(): a newly deployed worker takes over on the
  // next navigation. Claiming mid-session would leave an iframe controlled by a
  // worker that never received LEM_SESSION_OPEN.
  scope.addEventListener(
    'activate',
    /** @param {{ waitUntil: (p: Promise<unknown>) => void }} event */
    (event) => {
      event.waitUntil(
        scope.clients
          .matchAll({ includeUncontrolled: true, type: 'window' })
          .then((windows) => {
            for (const client of windows) client.postMessage({ type: 'LEM_BRIDGE_HELLO' })
          })
          .catch(() => undefined)
      )
    }
  )

  scope.addEventListener(
    'message',
    /** @param {{ data: unknown, ports: readonly MessagePort[] }} event */
    (event) => {
      worker.handleMessage(event.data, event.ports)
    }
  )

  scope.addEventListener(
    'fetch',
    /** @param {SwFetchEvent} event */
    (event) => {
      const response = worker.classify(event)
      if (response === null) return
      event.respondWith(response)
    }
  )

  return worker
}

/* c8 ignore start -- only reachable inside a real ServiceWorkerGlobalScope */
const globalScope = /** @type {LemSwScope | null} */ (
  'ServiceWorkerGlobalScope' in globalThis && 'clients' in globalThis
    ? /** @type {unknown} */ (globalThis)
    : null
)
if (globalScope !== null) {
  installServiceWorker(globalScope)
}
/* c8 ignore stop */
