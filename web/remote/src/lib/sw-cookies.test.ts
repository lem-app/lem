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
 * The Service Worker's own cookie jar (spec section 5.6.2, #72).
 *
 * **Every assertion here is on the jar or on the header pairs that reached the
 * transport.** Never on `document.cookie`, and never on a jsdom cookie store
 * standing in for a browser. That is not a stylistic preference: the previous
 * implementation of this feature was "proved" correct by a suite that asked
 * tough-cookie, via jsdom, a question only a browser could answer, and the
 * answers differed. `FakeTunnel.requests` is what the far side actually
 * received, so "the cookie was sent" is a transport fact here.
 *
 * The jar is in-worker by construction, so no test in this file puts
 * `Set-Cookie` on a `Response` or reads `Cookie` off a `Request`. Both are
 * guarded header names, and Node's undici does not enforce either guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ORIGIN,
  appUrl,
  createHarness,
  settle,
  type Harness,
  type UpstreamRequest,
} from '../test/sw-harness'
import { localApiUrl } from './env'
import { attachRawHeaders, rawResponseHeaders } from './proxy-fetch'
import {
  CookieJar,
  cookiePrefixOf,
  createMemoryCookieStore,
  defaultCookiePath,
  isTrustworthyOrigin,
  parseSetCookie,
} from '../../public/lem-app-sw.js'

const DEVICE_A = 'dev-7f3a'
const DEVICE_B = 'dev-91c2'

/** The `Cookie` header the far side received, or null when there was none. */
function cookieOf(request: UpstreamRequest): string | null {
  const found = request.headers.find(([name]) => name.toLowerCase() === 'cookie')
  return found ? found[1] : null
}

/** Serve one fixed reply, whatever is asked for. */
function serveWith(harness: Harness, headers: [string, string][]): void {
  harness.tunnel.serve(() => ({
    status: 200,
    headers: [['Content-Type', 'text/plain'], ...headers],
    chunks: ['ok'],
  }))
}

describe('the worker cookie jar, end to end', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness({ deviceId: DEVICE_A })
    await harness.bridge.openSession(DEVICE_A, 'webui')
    await settle()
  })

  it('parses a Set-Cookie off the response frame and stores it under (device, service)', async () => {
    serveWith(harness, [['Set-Cookie', 'session=s3cret; Path=/; HttpOnly']])

    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
    await settle()

    const stored = await harness.worker.cookies.read(DEVICE_A, 'webui')
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      name: 'session',
      value: 's3cret',
      path: '/',
      httpOnly: true,
    })

    // The partition is the key: the same service id on another device is a
    // different jar, not the same one reached by a different route.
    expect(await harness.worker.cookies.read(DEVICE_B, 'webui')).toEqual([])
  })

  it('sends the stored cookie on the next request, in the pairs handed to the tunnel', async () => {
    serveWith(harness, [['Set-Cookie', 'session=s3cret; Path=/']])
    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
    await settle()

    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/api/me'))
    await settle()

    // The first request could not have carried it; the second must.
    expect(cookieOf(harness.tunnel.requests[0])).toBeNull()
    expect(cookieOf(harness.tunnel.requests[1])).toBe('session=s3cret')
  })

  it('does not send one service’s cookie to another service, or to the dashboard', async () => {
    await harness.bridge.openSession(DEVICE_A, 'ollama')
    await settle()
    serveWith(harness, [['Set-Cookie', 'session=webui-only; Path=/']])

    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
    await settle()

    // Positive control first: without it, a harness that sends no cookie at all
    // would pass every negative assertion below.
    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/api/me'))
    await settle()
    const toWebui = harness.tunnel.requests.at(-1)
    expect(cookieOf(toWebui!)).toBe('session=webui-only')

    // Another service on the same device, same origin, same jar file.
    await harness.dispatch(appUrl(DEVICE_A, 'ollama', '/api/tags'))
    await settle()
    const toOllama = harness.tunnel.requests.at(-1)
    expect(toOllama!.service).toBe('ollama')
    expect(cookieOf(toOllama!)).toBeNull()

    // The dashboard's own origin: its API calls go over the tunnel too, and the
    // jar must not touch them. `service` is null for a local-API request.
    await harness.proxy.fetch(localApiUrl('/v1/services'))
    await settle()
    const toDashboard = harness.tunnel.requests.at(-1)
    expect(toDashboard!.service).toBeNull()
    expect(cookieOf(toDashboard!)).toBeNull()
  })

  it('stores every Set-Cookie on one response separately - they do not fold', async () => {
    // Not foldable into one comma-joined header: the section 5.6 correction
    // already recorded, and the reason the wire carries pairs, not a map.
    serveWith(harness, [
      ['Set-Cookie', 'session=s3cret; Path=/'],
      ['Set-Cookie', 'csrf=t0ken; Path=/'],
      ['Set-Cookie', 'theme=dark; Path=/'],
    ])

    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
    await settle()

    const stored = await harness.worker.cookies.read(DEVICE_A, 'webui')
    expect(stored.map((cookie) => cookie.name).sort()).toEqual(['csrf', 'session', 'theme'])

    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/api/me'))
    await settle()
    const sent = cookieOf(harness.tunnel.requests.at(-1)!)
    expect(sent).toContain('session=s3cret')
    expect(sent).toContain('csrf=t0ken')
    expect(sent).toContain('theme=dark')
  })

  it('does not send a cookie that expired after it was stored', async () => {
    // Only `Date` is faked - the harness drives real timers, and faking those
    // would deadlock `settle()`. The harness is built *inside* the fake, not in
    // `beforeEach`: the jar captures `Date.now` at construction, so a jar built
    // first would hold the real clock and this test would silently measure
    // nothing. (It did, on the first run.)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const timed = await createHarness({ deviceId: DEVICE_A })
      await timed.bridge.openSession(DEVICE_A, 'webui')
      await settle()

      serveWith(timed, [['Set-Cookie', 'session=s3cret; Path=/; Max-Age=60']])
      await timed.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
      await settle()

      // Alive: the positive control that makes the negative below mean something.
      await timed.dispatch(appUrl(DEVICE_A, 'webui', '/api/me'))
      await settle()
      expect(cookieOf(timed.tunnel.requests.at(-1)!)).toBe('session=s3cret')

      // Nothing rewrites the jar in between, so this can only pass if expiry is
      // enforced when the cookie is *read*.
      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'))
      await timed.dispatch(appUrl(DEVICE_A, 'webui', '/api/me'))
      await settle()
      expect(cookieOf(timed.tunnel.requests.at(-1)!)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('still reaches the jar when the Response guard has stripped it, as a browser does', async () => {
    // **The test that pins the fix, and the only one that can.**
    //
    // The page builds a `Response` from the frame before the worker sees it,
    // and `new Response(body, { headers })` gives its `Headers` the "response"
    // guard, which drops `Set-Cookie` *silently*. So in a browser the page's
    // `response.headers` has already lost the one header the jar exists to
    // read - and the jar would be permanently empty, with nothing anywhere
    // reporting why.
    //
    // Node's undici does not enforce that guard, so this suite cannot produce
    // the browser's response by running the code. It has to *construct* it: the
    // wrapper below rebuilds each response with `set-cookie` removed from
    // `headers`, which is exactly what the guard leaves behind, while the raw
    // frame pairs travel beside it as they do in production.
    //
    // If the bridge ever goes back to reading `response.headers`, this fails
    // here and passes everywhere else in the suite - which is the whole lesson
    // of section 5.6.2.
    const guarded = await createHarness({
      deviceId: DEVICE_A,
      proxyFetch: (inner) => async (url, init) => {
        const real = await inner(url, init)
        const survived = [...real.headers.entries()].filter(
          ([name]) => name.toLowerCase() !== 'set-cookie'
        )
        return attachRawHeaders(
          new Response(real.body, { status: real.status, headers: survived }),
          rawResponseHeaders(real) ?? []
        )
      },
    })
    await guarded.bridge.openSession(DEVICE_A, 'webui')
    await settle()
    serveWith(guarded, [['Set-Cookie', 'session=s3cret; Path=/']])

    await guarded.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
    await settle()

    // The premise: the page's Response really has lost the header here.
    const stored = await guarded.worker.cookies.read(DEVICE_A, 'webui')
    expect(stored.map((cookie: { name: string }) => cookie.name)).toEqual(['session'])

    await guarded.dispatch(appUrl(DEVICE_A, 'webui', '/api/me'))
    await settle()
    expect(cookieOf(guarded.tunnel.requests.at(-1)!)).toBe('session=s3cret')
  })

  it('keeps the upstream Set-Cookie reachable past the Response guard', async () => {
    // The bug this pins: `new Response(body, { headers })` gives its `Headers`
    // the "response" guard, which drops `Set-Cookie` **silently**. The page
    // builds exactly such a `Response` from the frame before the worker sees
    // it, so reading `response.headers` there would hand the jar a response
    // with the one header it exists to read already gone - in a browser only,
    // because undici does not enforce the guard. The raw pairs travel beside
    // the `Response` instead, and this asserts they arrive.
    serveWith(harness, [['Set-Cookie', 'session=s3cret; Path=/']])
    const response = await harness.proxy.fetch(localApiUrl('/v1/services'))

    const raw = rawResponseHeaders(response)
    expect(raw).not.toBeNull()
    expect(raw!.filter(([name]) => name.toLowerCase() === 'set-cookie')).toEqual([
      ['Set-Cookie', 'session=s3cret; Path=/'],
    ])
  })

  it('never hands Set-Cookie to the frame, and never sends two Cookie headers', async () => {
    serveWith(harness, [['Set-Cookie', 'session=s3cret; Path=/']])
    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
    await settle()

    // An app that sets its own `Cookie` on a fetch must not produce two of them.
    const result = await harness.dispatch(appUrl(DEVICE_A, 'webui', '/api/me'), {
      headers: [['Cookie', 'forged=1']],
    })
    await settle()

    expect(result.response?.headers.getSetCookie()).toEqual([])
    const sent = harness.tunnel.requests
      .at(-1)!
      .headers.filter(([name]) => name.toLowerCase() === 'cookie')
    expect(sent).toEqual([['Cookie', 'session=s3cret']])
  })

  it('answers a device mismatch 409 without ever consulting the jar', async () => {
    // The existing rule stands ahead of the jar: a stale frame must not be able
    // to make the worker read, or write, another device's cookies.
    const headerFor = vi.spyOn(harness.worker.cookies, 'headerFor')
    const ingest = vi.spyOn(harness.worker.cookies, 'ingest')
    serveWith(harness, [['Set-Cookie', 'session=s3cret; Path=/']])

    const result = await harness.dispatch(appUrl(DEVICE_B, 'webui', '/api/me'))
    await settle()

    expect(result.response?.status).toBe(409)
    expect(headerFor).not.toHaveBeenCalled()
    expect(ingest).not.toHaveBeenCalled()
    expect(harness.tunnel.requestFramesSent).toBe(0)
  })

  it('survives the browser recycling the worker', async () => {
    // A session cookie has to outlive an idle worker being killed, or the app
    // is logged out the moment the user looks away.
    serveWith(harness, [['Set-Cookie', 'session=s3cret; Path=/']])
    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
    await settle()

    await harness.restartWorker()
    await harness.bridge.openSession(DEVICE_A, 'webui')
    await settle()

    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/api/me'))
    await settle()
    expect(cookieOf(harness.tunnel.requests.at(-1)!)).toBe('session=s3cret')
  })
})

describe('the jar reports what it refused, because nothing else will', () => {
  // Section 5.6.2 note 3: no exception, no console entry, nothing in the
  // platform reports a refused cookie. A jar that cannot say what it dropped is
  // a jar that believes it succeeded - which is what both previous bugs in this
  // area looked like from the inside.
  let jar: CookieJar

  beforeEach(() => {
    jar = new CookieJar({ store: createMemoryCookieStore(), secureOrigin: true, now: () => 1000 })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the cookie and the reason for each refusal', async () => {
    const report = await jar.ingest(
      DEVICE_A,
      'webui',
      [
        ['Set-Cookie', 'good=1; Path=/'],
        ['Set-Cookie', 'no-equals-sign'],
        ['Set-Cookie', '=orphaned'],
        ['Set-Cookie', '__Secure-nope=1; Path=/'],
        ['Set-Cookie', '__Host-nope=1; Secure; Domain=example.com'],
        ['Set-Cookie', '__Host-deep=1; Secure; Path=/deep'],
      ],
      '/login'
    )

    expect(report.stored).toEqual(['good'])
    expect(report.dropped.map((drop) => [drop.name, drop.reason])).toEqual([
      ['', 'no-name-value-pair'],
      ['', 'empty-name'],
      ['__Secure-nope', '__secure-needs-secure'],
      ['__Host-nope', '__host-forbids-domain'],
      ['__Host-deep', '__host-needs-root-path'],
    ])
    // The refusals are also on the jar itself, not only in the return value,
    // because the worker calls `ingest` fire-and-forget.
    expect(jar.drops).toHaveLength(5)
    expect(jar.stats.dropped).toBe(5)
  })

  it('refuses a value that could inject a header on the far side', async () => {
    const report = await jar.ingest(
      DEVICE_A,
      'webui',
      [['Set-Cookie', 'evil=a\r\nX-Admin: 1; Path=/']],
      '/'
    )
    expect(report.stored).toEqual([])
    expect(report.dropped[0]).toMatchObject({ name: 'evil', reason: 'control-character' })
  })

  it('reports a removal separately from a refusal', async () => {
    await jar.ingest(DEVICE_A, 'webui', [['Set-Cookie', 'session=x; Path=/']], '/')
    const report = await jar.ingest(
      DEVICE_A,
      'webui',
      [['Set-Cookie', 'session=x; Path=/; Max-Age=0']],
      '/'
    )
    expect(report.removed).toEqual(['session'])
    expect(report.dropped).toEqual([])
    expect(await jar.read(DEVICE_A, 'webui')).toEqual([])
  })
})

describe('cookie name prefixes are matched case-insensitively', () => {
  // RFC 6265bis section 4.1.3 describes the prefixes case-sensitively, from the
  // *server's* point of view. The requirement that binds an implementation is
  // in section 5.4 and the storage model of section 5.7, and there it is
  // case-insensitive (MUST) - so that a case-insensitive server cannot be
  // tricked into accepting `__SECURE-` as an unprefixed name.
  //
  // **tough-cookie matches case-sensitively.** Via jsdom it is this repo's only
  // cookie oracle, so an oracle-driven test would accept `__HOST-x` without
  // `Secure` and the code would be wrong in every real browser. These assert
  // against the RFC requirement directly. A green suite here is not evidence
  // about prefixes; the case-folding below is.
  const context = { requestPath: '/login', now: 1000, secureOrigin: true }

  it.each(['__Host-sid', '__host-sid', '__HOST-sid', '__HoSt-sid'])(
    'applies the __Host- rules to %s',
    (name) => {
      // Without `Secure`, refused whatever the casing.
      expect(parseSetCookie(`${name}=1; Path=/`, context)).toMatchObject({
        reason: '__host-needs-secure',
      })
      // With `Secure`, no `Domain` and `Path=/`, accepted - and the path is left
      // exactly as upstream set it, which is why a jar keyed by the partition
      // never has to fight this rule.
      expect(parseSetCookie(`${name}=1; Secure; Path=/`, context)).toMatchObject({
        cookie: { name, path: '/', secure: true },
      })
    }
  )

  it.each(['__Secure-sid', '__secure-sid', '__SECURE-sid'])(
    'applies the __Secure- rules to %s',
    (name) => {
      expect(parseSetCookie(`${name}=1; Path=/`, context)).toMatchObject({
        reason: '__secure-needs-secure',
      })
      expect(parseSetCookie(`${name}=1; Secure; Path=/deep`, context)).toMatchObject({
        // __Secure- says nothing about Path, unlike __Host-.
        cookie: { name, path: '/deep' },
      })
    }
  )

  it('leaves a name that merely resembles a prefix alone', () => {
    expect(cookiePrefixOf('__Hostess')).toBeNull()
    expect(cookiePrefixOf('_Host-x')).toBeNull()
    expect(cookiePrefixOf('session')).toBeNull()
    expect(parseSetCookie('__Hostess=1', context)).toMatchObject({ cookie: { name: '__Hostess' } })
  })
})

describe('parseSetCookie attribute handling', () => {
  const context = { requestPath: '/a/b/c', now: 10_000, secureOrigin: true }

  it('takes Max-Age over Expires', () => {
    const parsed = parseSetCookie('x=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT; Max-Age=30', context)
    expect(parsed).toMatchObject({ cookie: { expiresAt: 10_000 + 30_000 } })
  })

  it('treats a cookie with no expiry as a session cookie', () => {
    expect(parseSetCookie('x=1', context)).toMatchObject({ cookie: { expiresAt: null } })
  })

  it('falls back to the request default-path (RFC 6265 5.1.4)', () => {
    expect(defaultCookiePath('/a/b/c')).toBe('/a/b')
    expect(defaultCookiePath('/a')).toBe('/')
    expect(defaultCookiePath('/')).toBe('/')
    expect(parseSetCookie('x=1', context)).toMatchObject({ cookie: { path: '/a/b' } })
  })

  it('ignores a Path that is not absolute', () => {
    expect(parseSetCookie('x=1; Path=relative', context)).toMatchObject({
      cookie: { path: '/a/b' },
    })
  })

  it('records SameSite without acting on it', () => {
    // No cross-site request can arise inside a per-service partition, so the
    // `SameSite=None`-requires-`Secure` pairing is deliberately not enforced:
    // it would protect nothing here while refusing it would break logins for
    // apps that set it over plain HTTP upstream.
    expect(parseSetCookie('x=1; SameSite=None', context)).toMatchObject({
      cookie: { sameSite: 'none', secure: false },
    })
  })
})

describe('Secure is judged against the dashboard origin, not a build flag', () => {
  it('accepts Secure on HTTPS and on loopback, and nowhere else', () => {
    expect(isTrustworthyOrigin('https://dashboard.lem.test')).toBe(true)
    expect(isTrustworthyOrigin('http://localhost:5173')).toBe(true)
    expect(isTrustworthyOrigin('http://127.0.0.1:5173')).toBe(true)
    // A plain-HTTP LAN origin is not potentially trustworthy. Production is
    // HTTPS, so it is unaffected - which is the point of keying off the origin
    // rather than off a dev switch that could follow a build into production.
    expect(isTrustworthyOrigin('http://192.168.1.10:5173')).toBe(false)
    expect(isTrustworthyOrigin('http://lem.example.com')).toBe(false)
  })

  it('refuses a Secure cookie on an origin that is not trustworthy, and says so', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const jar = new CookieJar({
      store: createMemoryCookieStore(),
      secureOrigin: false,
      now: () => 1000,
    })

    const report = await jar.ingest(
      DEVICE_A,
      'webui',
      [
        ['Set-Cookie', 'plain=1; Path=/'],
        ['Set-Cookie', 'locked=1; Path=/; Secure'],
      ],
      '/'
    )

    expect(report.stored).toEqual(['plain'])
    expect(report.dropped.map((drop) => [drop.name, drop.reason])).toEqual([
      ['locked', 'insecure-origin'],
    ])
    vi.restoreAllMocks()
  })
})

describe('path scoping inside one service', () => {
  let jar: CookieJar

  beforeEach(() => {
    jar = new CookieJar({ store: createMemoryCookieStore(), secureOrigin: true, now: () => 1000 })
  })

  it('sends a cookie only to paths it scopes, and orders longest path first', async () => {
    await jar.ingest(
      DEVICE_A,
      'webui',
      [
        ['Set-Cookie', 'root=1; Path=/'],
        ['Set-Cookie', 'deep=1; Path=/api'],
      ],
      '/'
    )

    expect(await jar.headerFor(DEVICE_A, 'webui', '/api/models')).toBe('deep=1; root=1')
    expect(await jar.headerFor(DEVICE_A, 'webui', '/other')).toBe('root=1')
    // A prefix that is not a path-segment boundary does not match.
    expect(await jar.headerFor(DEVICE_A, 'webui', '/apiary')).toBe('root=1')
  })

  it('ignores the query string when matching', async () => {
    await jar.ingest(DEVICE_A, 'webui', [['Set-Cookie', 'deep=1; Path=/api']], '/')
    expect(await jar.headerFor(DEVICE_A, 'webui', '/api/models?stream=1')).toBe('deep=1')
  })

  it('keeps two cookies of one name at different paths apart', async () => {
    await jar.ingest(
      DEVICE_A,
      'webui',
      [
        ['Set-Cookie', 'sid=outer; Path=/'],
        ['Set-Cookie', 'sid=inner; Path=/admin'],
      ],
      '/'
    )
    expect(await jar.headerFor(DEVICE_A, 'webui', '/admin/panel')).toBe('sid=inner; sid=outer')
    expect(await jar.headerFor(DEVICE_A, 'webui', '/')).toBe('sid=outer')
  })

  it('overwrites in place when the same name and path are set again', async () => {
    await jar.ingest(DEVICE_A, 'webui', [['Set-Cookie', 'sid=old; Path=/']], '/')
    await jar.ingest(DEVICE_A, 'webui', [['Set-Cookie', 'sid=new; Path=/']], '/')
    expect(await jar.headerFor(DEVICE_A, 'webui', '/')).toBe('sid=new')
    expect(await jar.read(DEVICE_A, 'webui')).toHaveLength(1)
  })
})

describe('expiry is enforced when the jar is read', () => {
  it('drops a cookie that expired since it was written, without a write in between', async () => {
    let clock = 1000
    const jar = new CookieJar({
      store: createMemoryCookieStore(),
      secureOrigin: true,
      now: () => clock,
    })

    await jar.ingest(DEVICE_A, 'webui', [['Set-Cookie', 'sid=1; Path=/; Max-Age=60']], '/')
    expect(await jar.headerFor(DEVICE_A, 'webui', '/')).toBe('sid=1')

    clock += 61_000
    expect(await jar.headerFor(DEVICE_A, 'webui', '/')).toBeNull()
    expect(await jar.read(DEVICE_A, 'webui')).toEqual([])
    expect(jar.stats.expired).toBeGreaterThan(0)
  })

  it('treats a past Expires at write time as a deletion', async () => {
    const jar = new CookieJar({
      store: createMemoryCookieStore(),
      secureOrigin: true,
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    })
    await jar.ingest(DEVICE_A, 'webui', [['Set-Cookie', 'sid=1; Path=/']], '/')
    const report = await jar.ingest(
      DEVICE_A,
      'webui',
      [['Set-Cookie', 'sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT']],
      '/'
    )
    expect(report.removed).toEqual(['sid'])
    expect(await jar.headerFor(DEVICE_A, 'webui', '/')).toBeNull()
  })
})

describe('the jar and the dashboard origin', () => {
  it('is empty for a partition nothing was ever stored under', async () => {
    const jar = new CookieJar({ store: createMemoryCookieStore(), secureOrigin: true })
    expect(await jar.headerFor(DEVICE_A, 'webui', '/')).toBeNull()
    expect(await jar.read(DEVICE_A, 'webui')).toEqual([])
  })

  it('refuses to store against a malformed partition key, and says why', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const jar = new CookieJar({ store: createMemoryCookieStore(), secureOrigin: true })
    const report = await jar.ingest('', 'webui', [['Set-Cookie', 'sid=1; Path=/']], '/')
    expect(report.stored).toEqual([])
    expect(report.dropped[0]).toMatchObject({ reason: 'no-partition' })
    vi.restoreAllMocks()
  })

  it('does not intercept a cross-origin request, so no cookie can reach one', async () => {
    const harness = await createHarness({ deviceId: DEVICE_A })
    await harness.bridge.openSession(DEVICE_A, 'webui')
    await settle()
    serveWith(harness, [['Set-Cookie', 'session=s3cret; Path=/']])
    await harness.dispatch(appUrl(DEVICE_A, 'webui', '/login'), { method: 'POST', body: 'u=a' })
    await settle()

    harness.clients.add('frame-1', appUrl(DEVICE_A, 'webui'))
    const before = harness.tunnel.requests.length
    const result = await harness.dispatch('https://cdn.example.com/lib.js', {
      clientId: 'frame-1',
    })

    expect(result.passedThrough).toBe(true)
    expect(harness.network.requests).toContain('https://cdn.example.com/lib.js')
    // Nothing new reached the transport, so nothing carried a cookie.
    expect(harness.tunnel.requests).toHaveLength(before)
    expect(ORIGIN.startsWith('https://')).toBe(true)
  })
})
