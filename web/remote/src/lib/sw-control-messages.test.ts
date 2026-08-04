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
 * Who is allowed to tell the worker what to route.
 *
 * A framed service is a **controlled client**, so it can post to the worker
 * exactly as the dashboard does. Until the sender was checked, that was enough
 * to steal another service's session cookie, and the chain below is the attack
 * rather than a stand-in for it:
 *
 * 1. The hostile frame forges `LEM_SESSION_OPEN` for a service it does not own.
 * 2. It spawns a Worker from a `blob:` URL. That client's URL parses to *this*
 *    origin with a pathname that is not under `/app/`, so it is unattributable
 *    by every step of the resolution chain that reads a path.
 * 3. Resolution therefore falls through to the single-open-session fallback and
 *    lands on the forged session.
 * 4. `proxy()` attaches the victim service's real cookie from the jar and sends
 *    it over the real tunnel; the response comes back to the attacker.
 *
 * The worker's own "fell back to the single open session" warning fires *during*
 * the theft, which is what makes this worth pinning: the diagnostic was present
 * and the hole was still open.
 *
 * These assert on the tunnel and on the jar, never on a browser store.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ORIGIN, appUrl, createHarness, settle, type Harness } from '../test/sw-harness'
import { isDashboardClientUrl } from '../../public/lem-app-sw.js'

const DEVICE_A = 'dev-7f3a'
const VICTIM = 'webui'
const HOSTILE = 'evil'

/** The URL a Worker spawned from `URL.createObjectURL` reports. */
const BLOB_WORKER_URL = `blob:${ORIGIN}/9f1c2b7e-0000-4000-8000-abcdefabcdef`

describe('isDashboardClientUrl', () => {
  it('accepts the dashboard document and refuses a framed service', () => {
    expect(isDashboardClientUrl(`${ORIGIN}/`, ORIGIN)).toBe(true)
    expect(isDashboardClientUrl(`${ORIGIN}/settings`, ORIGIN)).toBe(true)
    expect(isDashboardClientUrl(appUrl(DEVICE_A, HOSTILE), ORIGIN)).toBe(false)
    expect(isDashboardClientUrl(appUrl(DEVICE_A, HOSTILE, '/deep/page'), ORIGIN)).toBe(false)
  })

  it('refuses a blob: client even though its origin matches', () => {
    // The trap. `new URL('blob:https://host/uuid')` reports
    // `origin === 'https://host'` and `pathname === 'https://host/uuid'` - a
    // matching origin, and a path that is not under `/app/`. An origin-only
    // check would therefore trust exactly the Worker this attack uses.
    expect(new URL(BLOB_WORKER_URL).origin).toBe(ORIGIN)
    expect(new URL(BLOB_WORKER_URL).pathname.startsWith('/app/')).toBe(false)
    expect(isDashboardClientUrl(BLOB_WORKER_URL, ORIGIN)).toBe(false)
  })

  it('refuses a data: URL, a cross-origin client, and no client at all', () => {
    expect(isDashboardClientUrl('data:text/html,<script>x</script>', ORIGIN)).toBe(false)
    expect(isDashboardClientUrl('https://evil.example.com/', ORIGIN)).toBe(false)
    expect(isDashboardClientUrl(null, ORIGIN)).toBe(false)
    expect(isDashboardClientUrl('', ORIGIN)).toBe(false)
  })
})

describe('a framed service cannot forge control messages', () => {
  let harness: Harness
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    harness = await createHarness({ deviceId: DEVICE_A })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  it('refuses LEM_SESSION_OPEN from a client under /app/, and says so', async () => {
    harness.postAsClient(appUrl(DEVICE_A, HOSTILE), {
      type: 'LEM_SESSION_OPEN',
      deviceId: DEVICE_A,
      serviceId: VICTIM,
    })
    await settle()

    expect(harness.worker.hasSession(DEVICE_A, VICTIM)).toBe(false)
    expect(harness.worker.stats.refusedControlMessages).toBe(1)
    expect(harness.worker.refusedControl.at(-1)).toMatchObject({ type: 'LEM_SESSION_OPEN' })
    // Note 3: the refusal is visible, not silent.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refused control message'))
  })

  it('refuses LEM_SESSION_CLOSE, so a frame cannot shut another service down', async () => {
    await harness.bridge.openSession(DEVICE_A, VICTIM)
    await settle()
    expect(harness.worker.hasSession(DEVICE_A, VICTIM)).toBe(true)

    harness.postAsClient(appUrl(DEVICE_A, HOSTILE), {
      type: 'LEM_SESSION_CLOSE',
      deviceId: DEVICE_A,
      serviceId: VICTIM,
    })
    await settle()

    expect(harness.worker.hasSession(DEVICE_A, VICTIM)).toBe(true)
  })

  it('refuses LEM_ACTIVE_DEVICE, so a frame cannot repoint the worker', async () => {
    harness.postAsClient(appUrl(DEVICE_A, HOSTILE), {
      type: 'LEM_ACTIVE_DEVICE',
      deviceId: 'dev-attacker',
    })
    await settle()

    expect(harness.worker.activeDeviceId).toBe(DEVICE_A)
  })

  it('refuses LEM_BRIDGE_INIT, so a frame cannot become the tunnel', async () => {
    const legitimate = harness.worker.bridgePort
    const channel = new MessageChannel()

    harness.postAsClient(appUrl(DEVICE_A, HOSTILE), { type: 'LEM_BRIDGE_INIT' }, [channel.port2])
    await settle()

    // The bridge port is the capability every other control message rests on.
    // Replacing it would let the frame answer the worker's requests itself.
    expect(harness.worker.bridgePort).toBe(legitimate)
  })

  it('refuses a message whose sender cannot be established', async () => {
    harness.postAsClient(null, {
      type: 'LEM_SESSION_OPEN',
      deviceId: DEVICE_A,
      serviceId: VICTIM,
    })
    await settle()

    expect(harness.worker.hasSession(DEVICE_A, VICTIM)).toBe(false)
    expect(harness.worker.refusedControl.at(-1)).toMatchObject({ reason: 'unknown-sender' })
  })

  it('refuses a session message posted globally even by the dashboard itself', async () => {
    // The second, independent gate. In production the dashboard sends these
    // over the bridge port, so this costs nothing - and it means a sender check
    // that were ever bypassed still would not be enough on its own.
    harness.postAsClient(`${ORIGIN}/`, {
      type: 'LEM_SESSION_OPEN',
      deviceId: DEVICE_A,
      serviceId: VICTIM,
    })
    await settle()

    expect(harness.worker.hasSession(DEVICE_A, VICTIM)).toBe(false)
    expect(harness.worker.refusedControl.at(-1)).toMatchObject({
      reason: 'not-over-bridge-port',
    })
  })

  it('still lets the real dashboard open a session over the bridge port', async () => {
    // The positive control. Without it every assertion above is satisfied by a
    // worker that simply refuses everything.
    await harness.bridge.openSession(DEVICE_A, VICTIM)
    await settle()

    expect(harness.worker.hasSession(DEVICE_A, VICTIM)).toBe(true)
    expect(harness.worker.stats.refusedControlMessages).toBe(0)
  })
})

describe('the full cookie-theft chain is closed', () => {
  let harness: Harness

  beforeEach(async () => {
    harness = await createHarness({ deviceId: DEVICE_A })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // The victim is logged in: a real session cookie sits in its partition.
    harness.tunnel.serve(() => ({
      status: 200,
      headers: [
        ['Content-Type', 'text/plain'],
        ['Set-Cookie', 'session=victim-secret; Path=/'],
      ],
      chunks: ['ok'],
    }))
    await harness.bridge.openSession(DEVICE_A, VICTIM)
    await settle()
    await harness.dispatch(appUrl(DEVICE_A, VICTIM, '/login'), { method: 'POST', body: 'u=a' })
    await settle()
  })

  it('has a victim cookie to steal, and the legitimate frame still gets it', async () => {
    // Positive control for the whole file: the cookie exists and does flow, so
    // the negative below is about the attack and not about an empty jar.
    const stored = await harness.worker.cookies.read(DEVICE_A, VICTIM)
    expect(stored.map((cookie: { name: string }) => cookie.name)).toEqual(['session'])

    await harness.dispatch(appUrl(DEVICE_A, VICTIM, '/api/me'))
    await settle()
    const sent = harness.tunnel.requests
      .at(-1)!
      .headers.find(([name]) => name.toLowerCase() === 'cookie')
    expect(sent?.[1]).toBe('session=victim-secret')
  })

  it('does not let a forged session plus a blob: worker steal the cookie', async () => {
    // Step 1 of the chain: forge the session. Refused now.
    harness.postAsClient(appUrl(DEVICE_A, HOSTILE), {
      type: 'LEM_SESSION_OPEN',
      deviceId: DEVICE_A,
      serviceId: VICTIM,
    })
    await settle()

    const before = harness.tunnel.requests.length

    // Steps 2-3: the unattributable blob: worker makes a prefix-less request.
    // No referrer, and a client URL no step of the chain can attribute.
    harness.clients.add('blob-worker-1', BLOB_WORKER_URL)
    const result = await harness.dispatch(`${ORIGIN}/api/me`, { clientId: 'blob-worker-1' })
    await settle()

    // Step 4 never happens: nothing new reached the tunnel, so no cookie did.
    expect(harness.tunnel.requests).toHaveLength(before)
    expect(result.response?.status).toBe(421)

    // And the decisive assertion - at the transport, not on a store: nothing
    // that reached the wire in this test ever carried the victim's cookie. The
    // only earlier request was the `/login` POST, which is what *set* it.
    const leaked = harness.tunnel.requests.filter((request) =>
      request.headers.some(([, value]) => value.includes('victim-secret'))
    )
    expect(leaked).toHaveLength(0)
  })

  it('leaks the victim cookie to no request the attacker can cause', async () => {
    harness.postAsClient(appUrl(DEVICE_A, HOSTILE), {
      type: 'LEM_SESSION_OPEN',
      deviceId: DEVICE_A,
      serviceId: VICTIM,
    })
    await settle()
    harness.clients.add('blob-worker-1', BLOB_WORKER_URL)

    await harness.dispatch(`${ORIGIN}/api/me`, { clientId: 'blob-worker-1' })
    await settle()

    // Every request that carried the cookie must belong to the victim service.
    const carrying = harness.tunnel.requests.filter((request) =>
      request.headers.some(([, value]) => value.includes('victim-secret'))
    )
    for (const request of carrying) {
      expect(request.service).toBe(VICTIM)
    }
    expect(harness.worker.hasSession(DEVICE_A, VICTIM)).toBe(true)
    expect(harness.worker.stats.refusedControlMessages).toBeGreaterThan(0)
  })

  it('does not leak the cookie to a blob: worker with no forgery at all', async () => {
    // **The variant the sender check alone does not close, and the reason the
    // fallback had to change too.** No forged message anywhere in this test:
    // the hostile frame simply spawns a Worker from a `blob:` URL and makes a
    // prefix-less request. Before the fix that request resolved onto the
    // victim's own legitimate session through the single-open-session fallback
    // and came back `200` carrying `session=victim-secret`.
    harness.clients.add('blob-worker-3', BLOB_WORKER_URL)
    const before = harness.tunnel.requests.length

    const result = await harness.dispatch(`${ORIGIN}/api/me`, { clientId: 'blob-worker-3' })
    await settle()

    expect(result.response?.status).toBe(421)
    expect(harness.tunnel.requests).toHaveLength(before)
    expect(harness.worker.stats.unattributableClients).toBe(1)
    // The fallback must not have been consulted at all.
    expect(harness.worker.stats.singleSessionFallbacks).toBe(0)
    const leaked = harness.tunnel.requests.filter((request) =>
      request.headers.some(([, value]) => value.includes('victim-secret'))
    )
    expect(leaked).toHaveLength(0)
  })

  it('still serves a client it genuinely cannot look up, via the fallback', async () => {
    // The positive control for the rule above, and it matters: no existing test
    // asserted the fallback ever *fires* - every one of them asserts it did not
    // - so a change that made step 5 unreachable would have gone unnoticed.
    //
    // The distinction the rule draws: this client cannot be looked up at all
    // (`clients.get` finds nothing), which is what the fallback is for. A
    // `blob:` Worker *can* be looked up and demonstrably belongs to no service,
    // which is what it is not for.
    const result = await harness.dispatch(`${ORIGIN}/api/me`, { clientId: 'vanished-client' })
    await settle()

    expect(result.response?.status).toBe(200)
    expect(harness.worker.stats.singleSessionFallbacks).toBe(1)
    expect(harness.worker.stats.unattributableClients).toBe(0)
    expect(harness.tunnel.requests.at(-1)!.service).toBe(VICTIM)
  })

  it('cannot be steered onto a session the sender did not open', async () => {
    // The fallback itself is the steerable part, so pin it directly: with the
    // forged session refused, an unattributable request has no single candidate
    // it may be given, and fails closed at step 6 rather than guessing.
    harness.postAsClient(appUrl(DEVICE_A, HOSTILE), {
      type: 'LEM_SESSION_OPEN',
      deviceId: DEVICE_A,
      serviceId: 'another-service',
    })
    await settle()

    harness.clients.add('blob-worker-2', BLOB_WORKER_URL)
    const result = await harness.dispatch(`${ORIGIN}/api/tags`, { clientId: 'blob-worker-2' })

    expect(result.response?.status).toBe(421)
    expect(harness.worker.hasSession(DEVICE_A, 'another-service')).toBe(false)
  })
})
