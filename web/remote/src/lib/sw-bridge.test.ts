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
 * The dashboard side of the bridge, on its own.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  ServiceWorkerBridge,
  SW_SCOPE,
  SW_SCRIPT_URL,
  appPath,
  detectUnavailability,
  upstreamUrl,
} from './sw-bridge'
import { LOCAL_API_BASE_URL } from './env'

describe('appPath', () => {
  it('builds the same-origin path a service is framed at', () => {
    expect(appPath('dev-7f3a', 'webui')).toBe('/app/dev-7f3a/webui/')
  })

  it.each([
    ['../etc', 'webui'],
    ['dev/other', 'webui'],
    ['dev-7f3a', 'a/b'],
    ['', 'webui'],
    ['dev-7f3a', 'x'.repeat(65)],
  ])('refuses (%s, %s), which would not survive the URL', (deviceId, serviceId) => {
    expect(() => appPath(deviceId, serviceId)).toThrow(/cannot appear in a service URL/)
  })
})

describe('upstreamUrl', () => {
  it('keeps the path on the local API origin', () => {
    const origin = new URL(LOCAL_API_BASE_URL).origin
    expect(upstreamUrl('/api/models?x=1')).toBe(`${origin}/api/models?x=1`)
  })

  it('refuses a network-path reference, which would name another host', () => {
    // `new URL('//evil.example/x', base)` resolves to https://evil.example/x.
    // Concatenation onto a parsed origin cannot do that; this check makes the
    // refusal explicit rather than incidental.
    expect(() => upstreamUrl('//evil.example/x')).toThrow(/host-relative/)
    expect(() => upstreamUrl('http://evil.example/x')).toThrow(/host-relative/)
  })
})

describe('detectUnavailability', () => {
  const container = {} as ServiceWorkerContainer

  it('names an insecure context first, because it is the common case', () => {
    expect(detectUnavailability(container, false)).toBe('insecure-context')
    expect(detectUnavailability(undefined, false)).toBe('insecure-context')
  })

  it('names a missing container in a secure context', () => {
    expect(detectUnavailability(undefined, true)).toBe('unsupported')
  })

  it('reports nothing when both hold', () => {
    expect(detectUnavailability(container, true)).toBeNull()
  })
})

describe('ServiceWorkerBridge.start', () => {
  function containerStub(register = vi.fn(() => Promise.resolve({}))) {
    const container = {
      controller: null,
      register,
      ready: Promise.resolve({ active: { postMessage: vi.fn() } }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as ServiceWorkerContainer
    return { container, register }
  }

  it('registers at the origin root with the /app/ scope', async () => {
    const { container, register } = containerStub()
    const bridge = new ServiceWorkerBridge({
      proxyFetch: () => Promise.resolve(new Response()),
      container,
      secureContext: true,
    })

    expect(await bridge.start()).toEqual({ state: 'ready' })
    // The script must sit at the origin root: a worker may only claim a scope
    // at or below its own path, and `/app/` is above `/assets/…`.
    expect(register).toHaveBeenCalledWith(SW_SCRIPT_URL, { scope: SW_SCOPE, type: 'module' })
    expect(SW_SCRIPT_URL.lastIndexOf('/')).toBe(0)
    bridge.dispose()
  })

  it('reports a registration failure rather than throwing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { container } = containerStub(vi.fn(() => Promise.reject(new Error('nope'))))
    const bridge = new ServiceWorkerBridge({
      proxyFetch: () => Promise.resolve(new Response()),
      container,
      secureContext: true,
    })

    expect(await bridge.start()).toEqual({ state: 'unavailable', reason: 'registration-failed' })
    consoleError.mockRestore()
    bridge.dispose()
  })

  it('reports an insecure context without touching the container', async () => {
    const { container, register } = containerStub()
    const bridge = new ServiceWorkerBridge({
      proxyFetch: () => Promise.resolve(new Response()),
      container,
      secureContext: false,
    })

    expect(await bridge.start()).toEqual({ state: 'unavailable', reason: 'insecure-context' })
    expect(register).not.toHaveBeenCalled()
    bridge.dispose()
  })
})
