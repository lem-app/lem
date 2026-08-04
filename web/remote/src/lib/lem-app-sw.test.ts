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
 * The Service Worker's decision surface, without a browser.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  APP_PATH_RE,
  BRIDGE_WAIT_MS,
  CookieJar,
  ERROR_STATUS,
  LemAppServiceWorker,
  SUBSTITUTED_CSP,
  bindingFromUrl,
  buildResponseHeaders,
  createMemoryBindingStore,
  createMemoryCookieStore,
  installServiceWorker,
  parseAppPath,
  problemResponse,
  rewriteLocation,
} from '../../public/lem-app-sw.js'
import { HTTP_STATUS_FOR_ERROR } from './tunnel-errors'

const ORIGIN = 'https://dashboard.lem.test'

describe('parseAppPath', () => {
  it('splits a device, a service and the remaining path', () => {
    expect(parseAppPath('/app/dev-7f3a/openwebui/static/x.js')).toEqual({
      deviceId: 'dev-7f3a',
      serviceId: 'openwebui',
      path: '/static/x.js',
    })
  })

  it('defaults a bare prefix to the root path', () => {
    expect(parseAppPath('/app/dev-7f3a/openwebui/')).toEqual({
      deviceId: 'dev-7f3a',
      serviceId: 'openwebui',
      path: '/',
    })
    expect(parseAppPath('/app/dev-7f3a/openwebui')).toEqual({
      deviceId: 'dev-7f3a',
      serviceId: 'openwebui',
      path: '/',
    })
  })

  it.each([
    ['/app/', 'no segments'],
    ['/app/only-one/', 'one segment'],
    ['/apps/dev/svc/', 'a different prefix'],
    ['/app/dev/svc%2f../etc/', 'an escaped separator'],
    ['/app/../../etc/passwd', 'traversal'],
    ['/app/./svc/', 'a dot device segment'],
    [`/app/${'x'.repeat(65)}/svc/`, 'an over-long device id'],
    [`/app/dev/${'x'.repeat(65)}/`, 'an over-long service id'],
  ])('rejects %s (%s)', (pathname) => {
    expect(parseAppPath(pathname)).toBeNull()
  })

  it('bounds both segments so neither can introduce a path separator', () => {
    expect(APP_PATH_RE.source).toContain('[A-Za-z0-9._-]{1,64}')
  })
})

describe('bindingFromUrl', () => {
  it('reads a binding out of a same-origin app URL', () => {
    expect(bindingFromUrl(`${ORIGIN}/app/dev-7f3a/openwebui/`, ORIGIN)).toEqual({
      deviceId: 'dev-7f3a',
      serviceId: 'openwebui',
    })
  })

  it.each(['', 'about:client', null, undefined])('treats %p as no referrer', (raw) => {
    expect(bindingFromUrl(raw, ORIGIN)).toBeNull()
  })

  it('refuses a cross-origin URL that happens to have the right shape', () => {
    expect(bindingFromUrl('https://evil.example/app/dev-7f3a/openwebui/', ORIGIN)).toBeNull()
  })

  it('refuses a same-origin URL outside the scope', () => {
    expect(bindingFromUrl(`${ORIGIN}/dashboard`, ORIGIN)).toBeNull()
  })
})

describe('rewriteLocation', () => {
  it('re-prefixes a root-relative redirect', () => {
    expect(rewriteLocation('/auth/callback', 'dev-7f3a', 'webui', '/login')).toBe(
      '/app/dev-7f3a/webui/auth/callback'
    )
  })

  it('re-prefixes an absolute loopback redirect', () => {
    // The upstream's own address is a *far machine* address. Passing it through
    // verbatim would point this browser at its own localhost, which is the
    // entire defect this design exists to fix.
    expect(rewriteLocation('http://127.0.0.1:33801/auth/callback', 'dev-7f3a', 'webui', '/')).toBe(
      '/app/dev-7f3a/webui/auth/callback'
    )
  })

  it('resolves a relative redirect against the request path first', () => {
    expect(rewriteLocation('callback', 'dev-7f3a', 'webui', '/auth/login')).toBe(
      '/app/dev-7f3a/webui/auth/callback'
    )
  })

  it('keeps the query and fragment', () => {
    expect(rewriteLocation('/cb?code=1#tok', 'dev-7f3a', 'webui', '/')).toBe(
      '/app/dev-7f3a/webui/cb?code=1#tok'
    )
  })

  it('passes a genuinely external redirect through untouched', () => {
    expect(rewriteLocation('https://accounts.google.com/o/oauth2', 'dev', 'svc', '/')).toBe(
      'https://accounts.google.com/o/oauth2'
    )
    expect(rewriteLocation('//cdn.example/x', 'dev', 'svc', '/')).toBe('//cdn.example/x')
  })

  it('carries the device segment it was given, whatever the active device is', () => {
    // The function takes the device explicitly and has no access to the active
    // one, which is how the "request's segment, never the active one" rule is
    // made unbreakable rather than merely followed.
    expect(rewriteLocation('/x', 'dev-OLD', 'webui', '/')).toBe('/app/dev-OLD/webui/x')
  })
})

describe('buildResponseHeaders', () => {
  it('strips headers written for the app own origin and substitutes a CSP', () => {
    const headers = buildResponseHeaders(
      [
        ['Content-Type', 'text/html'],
        ['Content-Security-Policy', "default-src 'none'"],
        ['X-Frame-Options', 'DENY'],
        ['Strict-Transport-Security', 'max-age=31536000'],
        ['Public-Key-Pins', 'pin-sha256="x"'],
      ],
      { deviceId: 'dev', serviceId: 'svc', upstreamPath: '/' }
    )

    expect(headers.get('content-type')).toBe('text/html')
    expect(headers.get('x-frame-options')).toBeNull()
    expect(headers.get('strict-transport-security')).toBeNull()
    expect(headers.get('public-key-pins')).toBeNull()
    expect(headers.get('content-security-policy')).toBe(SUBSTITUTED_CSP)
  })

  it('rewrites Location while leaving other headers alone', () => {
    const headers = buildResponseHeaders(
      [
        ['Location', '/auth/callback'],
        ['Cache-Control', 'no-store'],
      ],
      { deviceId: 'dev-7f3a', serviceId: 'webui', upstreamPath: '/login' }
    )

    expect(headers.get('location')).toBe('/app/dev-7f3a/webui/auth/callback')
    expect(headers.get('cache-control')).toBe('no-store')
  })
})

// -- CSP substitution (spec sections 3.8 and 8.3) ----------------------------
//
// Two things have to be true at once, and they pull against each other:
//
//   1. No upstream policy may survive, because any of them can stop the
//      injected shim from running - and a shim that does not run means
//      `new WebSocket(...)` in the framed app reaches the remote browser's own
//      network instead of the tunnel. That is defect #3 of #6 returning.
//   2. The policy the worker substitutes must not be a blank cheque. It is
//      served on the *dashboard's* origin, so anything it permits, it permits
//      to third-party app code sharing that origin.
//
// The assertions below parse the policy rather than matching substrings. A
// substring test for "script-src" passes for `script-src-elem`, and a
// substring test for "'self'" passes for `frame-ancestors *  'self'`.

/** Parse a CSP into `directive -> values`, lower-cased as the grammar says. */
function parsePolicy(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>()
  for (const serialized of policy.split(';')) {
    const tokens = serialized.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    const [name, ...values] = tokens
    // First occurrence wins, per the CSP grammar.
    if (!directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values)
  }
  return directives
}

describe('the substituted Content-Security-Policy', () => {
  const context = { deviceId: 'dev', serviceId: 'svc', upstreamPath: '/' }

  it('replaces every shape of upstream policy, so none can block the shim', () => {
    const headers = buildResponseHeaders(
      [
        ['Content-Type', 'text/html'],
        // The maximally hostile one: this alone stops the shim executing.
        ['Content-Security-Policy', "default-src 'none'; script-src 'none'"],
        // A second policy header. CSP *intersects* multiple policies, so one
        // surviving header is enough to block the shim even if another is
        // permissive - which is why the test sends more than one.
        ['Content-Security-Policy', "script-src 'nonce-abc'"],
        // Report-Only does not block, but it exfiltrates: it would post the
        // shim's presence to a URL the app chooses.
        ['Content-Security-Policy-Report-Only', 'default-src *; report-uri https://evil.test/r'],
        // Header names are case-insensitive; the strip must be too.
        ['CONTENT-SECURITY-POLICY', "script-src 'none'"],
        ['content-security-policy-report-only', "default-src 'none'"],
      ],
      context
    )

    // `getAll` is not on Headers; `get` joins duplicates with ", ". Splitting
    // it is how we prove there is exactly one policy, not a merged pair.
    const policies = (headers.get('content-security-policy') ?? '').split(', ')

    expect(policies).toEqual([SUBSTITUTED_CSP])
    expect(headers.get('content-security-policy-report-only')).toBeNull()
  })

  it('declares no directive that could block the injected inline script', () => {
    const directives = parsePolicy(SUBSTITUTED_CSP)

    // The shim is spliced in as an inline <script> element. Under CSP an
    // inline script element is governed by `script-src-elem`, falling back to
    // `script-src`, falling back to `default-src`. If none of the three is
    // declared, the script is unrestricted and runs. Asserting their absence is
    // therefore the whole "the shim executes under the substituted CSP"
    // criterion, decided from the policy rather than guessed at.
    expect(directives.has('script-src-elem')).toBe(false)
    expect(directives.has('script-src')).toBe(false)
    expect(directives.has('default-src')).toBe(false)
  })

  it('is not so permissive that substituting it defeats the point', () => {
    const directives = parsePolicy(SUBSTITUTED_CSP)

    // `frame-ancestors 'self'`: the proxied app may be framed by the dashboard
    // and by nothing else. Without it, any site on the internet could frame
    // /app/<deviceId>/<serviceId>/ and drive the user's home services.
    expect(directives.get('frame-ancestors')).toEqual(["'self'"])

    // `base-uri 'self'`: a framed app that could set <base href="https://evil">
    // would re-point every relative URL in its own document off this origin,
    // out of the Service Worker's scope, and straight past the proxy. Pinning
    // it to 'self' keeps relative resolution inside the scope the worker owns.
    expect(directives.get('base-uri')).toEqual(["'self'"])

    // Neither may be widened by a wildcard or a scheme source hiding beside it.
    for (const [name, values] of directives) {
      expect(values, `${name} must not admit a wildcard`).not.toContain('*')
      expect(values, `${name} must not admit any host`).toEqual(["'self'"])
    }
  })

  it('substitutes a policy even when upstream sent none', () => {
    const headers = buildResponseHeaders([['Content-Type', 'text/html']], context)

    expect(headers.get('content-security-policy')).toBe(SUBSTITUTED_CSP)
  })
})

describe('problemResponse', () => {
  it('renders an RFC 7807 document with the taxonomy status', async () => {
    const response = problemResponse('E_DEVICE_MISMATCH', 'wrong device')

    expect(response.status).toBe(409)
    expect(response.headers.get('content-type')).toBe('application/problem+json')
    expect(await response.json()).toEqual({
      type: 'https://lem.gg/errors/e-device-mismatch',
      title: 'E_DEVICE_MISMATCH',
      status: 409,
      detail: 'wrong device',
      code: 'E_DEVICE_MISMATCH',
    })
  })
})

describe('a cold-started worker', () => {
  it('waits for the page to re-init, then gives up with 503', async () => {
    vi.useFakeTimers()
    try {
      const worker = new LemAppServiceWorker({
        origin: ORIGIN,
        clients: { get: () => Promise.resolve(undefined), matchAll: () => Promise.resolve([]) },
        bindingStore: createMemoryBindingStore(),
        cookies: new CookieJar({ store: createMemoryCookieStore(), secureOrigin: true }),
      })

      const pending = worker.proxy('dev-7f3a', 'webui', '/', new Request(`${ORIGIN}/x`))
      await vi.advanceTimersByTimeAsync(BRIDGE_WAIT_MS + 10)
      const response = await pending

      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: 'E_BRIDGE_UNAVAILABLE' })
      expect(worker.stats.bridgeTimeouts).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not answer 409 merely because it has not been told the device yet', async () => {
    // The device check runs after the bridge is ready, so a worker the browser
    // recycled mid-session resolves the request instead of rejecting one that
    // was perfectly valid. Here the page never arrives, so the honest answer is
    // "no bridge", not "wrong device".
    vi.useFakeTimers()
    try {
      const worker = new LemAppServiceWorker({
        origin: ORIGIN,
        clients: { get: () => Promise.resolve(undefined), matchAll: () => Promise.resolve([]) },
        bindingStore: createMemoryBindingStore(),
        cookies: new CookieJar({ store: createMemoryCookieStore(), secureOrigin: true }),
      })

      const pending = worker.proxy('dev-7f3a', 'webui', '/', new Request(`${ORIGIN}/x`))
      await vi.advanceTimersByTimeAsync(BRIDGE_WAIT_MS + 10)

      expect((await pending).status).toBe(503)
      expect(worker.stats.deviceMismatches).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('installServiceWorker', () => {
  it('wires the three handlers and asks live pages to re-init on activate', async () => {
    const handlers = new Map<string, (event: never) => void>()
    const posted: unknown[] = []
    const scope = {
      location: { origin: ORIGIN },
      clients: {
        get: () => Promise.resolve(undefined),
        matchAll: () =>
          Promise.resolve([
            { id: 'page-1', url: `${ORIGIN}/`, postMessage: (m: unknown) => posted.push(m) },
          ]),
      },
      addEventListener: (type: string, listener: (event: never) => void) => {
        handlers.set(type, listener)
      },
    }

    const worker = installServiceWorker(scope)

    expect([...handlers.keys()].sort()).toEqual(['activate', 'fetch', 'message'])

    // `activate` broadcasts LEM_BRIDGE_HELLO: the worker never hunts for its
    // page's port, it asks the page to push one.
    let waited: Promise<unknown> = Promise.resolve()
    const activate = handlers.get('activate') as (event: unknown) => void
    activate({
      waitUntil: (promise: Promise<unknown>) => {
        waited = promise
      },
    })
    await waited
    expect(posted).toEqual([{ type: 'LEM_BRIDGE_HELLO' }])

    // A cross-origin request is declined, so the browser fetches it itself.
    let responded = false
    const onFetch = handlers.get('fetch') as (event: unknown) => void
    onFetch({
      request: new Request('https://cdn.example/x.js'),
      clientId: 'frame-1',
      respondWith: () => {
        responded = true
      },
    })
    expect(responded).toBe(false)
    expect(worker.stats.passedThrough).toBe(1)
  })

  it('calls respondWith before the listener returns, as a browser requires', () => {
    // A real Service Worker throws `InvalidStateError` if `respondWith()` is
    // called after the handler returns. That makes "the listener must not be
    // async" a hard constraint, and one that is easy to reintroduce in a
    // refactor - #75 records that no test used to exercise it at all.
    const handlers = new Map<string, (event: never) => void>()
    const scope = {
      location: { origin: ORIGIN },
      clients: { get: () => Promise.resolve(undefined), matchAll: () => Promise.resolve([]) },
      addEventListener: (type: string, listener: (event: never) => void) => {
        handlers.set(type, listener)
      },
    }
    installServiceWorker(scope)

    let respondedDuringListener = false
    let listenerReturned = false
    const onFetch = handlers.get('fetch') as (event: unknown) => void
    onFetch({
      request: new Request(`${ORIGIN}/app/dev-7f3a/webui/`),
      clientId: 'frame-1',
      resultingClientId: '',
      respondWith: () => {
        respondedDuringListener = !listenerReturned
      },
    })
    listenerReturned = true

    expect(respondedDuringListener).toBe(true)
  })
})

describe('the worker error table', () => {
  it('matches src/lib/tunnel-errors.ts exactly', () => {
    // The worker lives in public/ and cannot import from src/, so the table is
    // duplicated. FrameType drifted between two hand-maintained tables once
    // already; this is the check that stops it happening again.
    expect(ERROR_STATUS).toEqual(HTTP_STATUS_FOR_ERROR)
  })
})
