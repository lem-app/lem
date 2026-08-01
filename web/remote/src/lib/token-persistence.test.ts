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
 * Spec section 8.4 requirement 1: the signaling JWT is held in a module-scoped
 * variable and persisted **nowhere**.
 *
 * ## Why this file exists separately from the lint rule
 *
 * The spec says it outright: *"A green lint rule with the token silently
 * re-persisted elsewhere must fail this criterion."* The ESLint rule in
 * `eslint.config.js` bans the `localStorage` and `sessionStorage` globals. It
 * cannot see IndexedDB, `document.cookie`, the Cache API, `window.name`, or a
 * URL fragment, and it cannot see a store reached through an alias. So the rule
 * is a tripwire, and **this file is the criterion**.
 *
 * ## How it avoids proving nothing
 *
 * A sweep that finds nothing is worthless until you have shown it can find
 * something. Every surface below is therefore covered twice:
 *
 * 1. A **positive control** writes a known needle through that surface's own
 *    public API and asserts the probe reports it. A surface whose control is
 *    deleted or broken stops being evidence, loudly.
 * 2. The **real assertion** runs a genuine login through `useAuth` and asserts
 *    the probe reports nothing.
 *
 * The controls are not decoration. The failure this project keeps finding is a
 * green suite whose premise was never checked (#72), and an undetectable
 * detector is exactly that failure in miniature.
 *
 * ## What jsdom does and does not give us
 *
 * Real, and scanned by content: `localStorage`, `sessionStorage`,
 * `document.cookie`, `location`, `window.name`, `history`.
 *
 * **Absent in jsdom**: `indexedDB` and `caches`. Those two are installed here
 * as recording fakes, so the claim they support is narrower and is stated
 * plainly: *if this code called those APIs, the call would be recorded.* It is
 * not a claim about a real IndexedDB's behaviour, and it does not need to be -
 * persistence requires making the call.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

/** A value distinctive enough that finding it anywhere is unambiguous. */
const NEEDLE = 'eyJhbGciOiJIUzI1NiJ9.NEEDLE-9f3c1a7e-token.sig'

/** Names of every persistence surface this probe knows how to inspect. */
type Surface =
  | 'localStorage'
  | 'sessionStorage'
  | 'cookie'
  | 'indexedDB'
  | 'caches'
  | 'location'
  | 'history'
  | 'window.name'

/** Everything an out-of-band store recorded, flattened to searchable strings. */
interface Recorder {
  indexedDB: string[]
  caches: string[]
  history: string[]
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * A stand-in for `indexedDB` that records every value written through it.
 *
 * Deliberately minimal: enough shape for a caller to open a database and put a
 * value, which is all persistence needs.
 */
function recordingIndexedDb(recorder: Recorder): IDBFactory {
  const objectStore = {
    put: (value: unknown) => {
      recorder.indexedDB.push(stringify(value))
      return {}
    },
    add: (value: unknown) => {
      recorder.indexedDB.push(stringify(value))
      return {}
    },
  }
  const database = {
    transaction: () => ({ objectStore: () => objectStore }),
    createObjectStore: () => objectStore,
    objectStoreNames: { contains: () => true },
    close: () => undefined,
  }
  return {
    open: () => {
      const request: { result: unknown; onsuccess?: () => void } = { result: database }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
    deleteDatabase: () => ({}),
    // The probe only needs `open`; the rest of IDBFactory is not exercised.
  } as unknown as IDBFactory
}

/** A stand-in for `caches` that records the body of everything stored. */
function recordingCaches(recorder: Recorder): CacheStorage {
  const cache = {
    put: async (_request: unknown, response: Response) => {
      recorder.caches.push(await response.clone().text())
    },
    add: () => Promise.resolve(undefined),
    match: () => Promise.resolve(undefined),
    delete: () => Promise.resolve(false),
  }
  return {
    open: () => Promise.resolve(cache),
    match: () => Promise.resolve(undefined),
    has: () => Promise.resolve(false),
    delete: () => Promise.resolve(false),
    keys: () => Promise.resolve([]),
  } as unknown as CacheStorage
}

/**
 * Install the probe, returning a function that lists every surface currently
 * holding `needle` and a teardown.
 */
function installProbe(): {
  findings: (needle: string) => Surface[]
  restore: () => void
} {
  const recorder: Recorder = { indexedDB: [], caches: [], history: [] }

  const originalIndexedDb = Reflect.get(globalThis, 'indexedDB') as unknown
  const originalCaches = Reflect.get(globalThis, 'caches') as unknown
  const originalPushState = window.history.pushState.bind(window.history)
  const originalReplaceState = window.history.replaceState.bind(window.history)
  const originalName = window.name

  Reflect.set(globalThis, 'indexedDB', recordingIndexedDb(recorder))
  Reflect.set(globalThis, 'caches', recordingCaches(recorder))

  // jsdom implements history, but recording the arguments catches a token
  // smuggled into a URL that a later navigation would drop from `location`.
  window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    recorder.history.push(`${stringify(data)} ${String(url ?? '')}`)
    originalPushState(data, unused, url)
  }
  window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
    recorder.history.push(`${stringify(data)} ${String(url ?? '')}`)
    originalReplaceState(data, unused, url)
  }

  function webStorageContents(store: Storage): string {
    const parts: string[] = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (key === null) continue
      parts.push(key, store.getItem(key) ?? '')
    }
    return parts.join('\n')
  }

  return {
    findings: (needle: string): Surface[] => {
      const found: Surface[] = []
      if (webStorageContents(localStorage).includes(needle)) found.push('localStorage')
      if (webStorageContents(sessionStorage).includes(needle)) found.push('sessionStorage')
      if (document.cookie.includes(needle)) found.push('cookie')
      if (recorder.indexedDB.some((entry) => entry.includes(needle))) found.push('indexedDB')
      if (recorder.caches.some((entry) => entry.includes(needle))) found.push('caches')
      if (window.location.href.includes(needle)) found.push('location')
      if (recorder.history.some((entry) => entry.includes(needle))) found.push('history')
      if (window.name.includes(needle)) found.push('window.name')
      return found
    },
    restore: () => {
      Reflect.set(globalThis, 'indexedDB', originalIndexedDb)
      Reflect.set(globalThis, 'caches', originalCaches)
      window.history.pushState = originalPushState
      window.history.replaceState = originalReplaceState
      window.name = originalName
    },
  }
}

function clearRealStores(): void {
  localStorage.clear()
  sessionStorage.clear()
  window.name = ''
  for (const pair of document.cookie.split(';')) {
    const key = pair.split('=')[0]?.trim()
    if (key) document.cookie = `${key}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
  }
  window.history.replaceState(null, '', '/')
}

describe('the persistence probe itself (positive controls)', () => {
  let probe: ReturnType<typeof installProbe>

  beforeEach(() => {
    clearRealStores()
    probe = installProbe()
  })

  afterEach(() => {
    probe.restore()
    clearRealStores()
  })

  it('starts clean, so a finding is never left over from another test', () => {
    expect(probe.findings(NEEDLE)).toEqual([])
  })

  it('detects a token in localStorage', () => {
    localStorage.setItem('anything', NEEDLE)
    expect(probe.findings(NEEDLE)).toContain('localStorage')
  })

  // Renaming the key is the obvious way to satisfy a lint rule that matches on
  // `setItem('token', ...)`. The probe scans values, so it is unaffected.
  it('detects a token in localStorage under an innocuous key name', () => {
    localStorage.setItem('ui-preferences', JSON.stringify({ theme: 'dark', t: NEEDLE }))
    expect(probe.findings(NEEDLE)).toContain('localStorage')
  })

  it('detects a token in sessionStorage', () => {
    sessionStorage.setItem('anything', NEEDLE)
    expect(probe.findings(NEEDLE)).toContain('sessionStorage')
  })

  it('detects a token in a cookie', () => {
    document.cookie = `session=${NEEDLE}; path=/`
    expect(probe.findings(NEEDLE)).toContain('cookie')
  })

  it('detects a token written to IndexedDB', async () => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('lem')
      request.onsuccess = () => {
        resolve(request.result)
      }
    })
    database.transaction('store', 'readwrite').objectStore('store').put({ token: NEEDLE })

    expect(probe.findings(NEEDLE)).toContain('indexedDB')
  })

  it('detects a token written to the Cache API', async () => {
    const cache = await caches.open('lem')
    await cache.put(new Request('https://dashboard.lem.test/t'), new Response(NEEDLE))

    expect(probe.findings(NEEDLE)).toContain('caches')
  })

  it('detects a token in the URL fragment', () => {
    window.history.replaceState(null, '', `/#access_token=${NEEDLE}`)
    expect(probe.findings(NEEDLE)).toEqual(expect.arrayContaining<Surface>(['location', 'history']))
  })

  it('detects a token in window.name', () => {
    window.name = NEEDLE
    expect(probe.findings(NEEDLE)).toContain('window.name')
  })
})

describe('the signaling JWT is not persisted anywhere (spec 8.4 req 1)', () => {
  let probe: ReturnType<typeof installProbe>

  beforeEach(() => {
    clearRealStores()
    vi.resetModules()
    probe = installProbe()
  })

  afterEach(() => {
    probe.restore()
    clearRealStores()
    vi.resetModules()
    vi.doUnmock('../api/auth')
  })

  /** Log in through the real hook, with only the network call faked. */
  async function loginThroughUseAuth(token: string): Promise<void> {
    vi.doMock('../api/auth', () => ({
      login: vi.fn().mockResolvedValue({ access_token: token, token_type: 'bearer' }),
      register: vi.fn(),
    }))

    const { useAuth } = await import('../hooks/useAuth')
    const { result } = renderHook(() => useAuth())

    await act(async () => {
      await result.current.login({ email: 'user@example.test', password: 'pw' })
    })

    expect(result.current.isAuthenticated).toBe(true)
    expect(result.current.token).toBe(token)
  }

  it('leaves no trace of the token on any surface after a real login', async () => {
    await loginThroughUseAuth(NEEDLE)

    expect(probe.findings(NEEDLE)).toEqual([])
  })

  it('leaves no trace after a logout either', async () => {
    vi.doMock('../api/auth', () => ({
      login: vi.fn().mockResolvedValue({ access_token: NEEDLE, token_type: 'bearer' }),
      register: vi.fn(),
    }))

    const { useAuth } = await import('../hooks/useAuth')
    const { result } = renderHook(() => useAuth())

    await act(async () => {
      await result.current.login({ email: 'user@example.test', password: 'pw' })
    })
    act(() => {
      result.current.logout()
    })

    expect(result.current.isAuthenticated).toBe(false)
    expect(probe.findings(NEEDLE)).toEqual([])
  })

  // The interim cost of section 8.4 requirement 1, asserted rather than
  // described. `vi.resetModules()` discards the module registry, so the next
  // import evaluates `session.ts` afresh and its module-scoped variable starts
  // at null - which is exactly what a page reload does to it. If the token were
  // being re-hydrated from any store, this hook would come back authenticated.
  it('forces re-authentication after a reload', async () => {
    await loginThroughUseAuth(NEEDLE)

    vi.resetModules()

    const { useAuth: useAuthAfterReload } = await import('../hooks/useAuth')
    const { result } = renderHook(() => useAuthAfterReload())

    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.token).toBeNull()
    expect(probe.findings(NEEDLE)).toEqual([])
  })

  // Upgrading users arrive with a token already in localStorage. Importing the
  // session module must empty it, or the change protects only new installs.
  it('purges a token the previous build persisted, on import', async () => {
    localStorage.setItem('token', NEEDLE)
    expect(probe.findings(NEEDLE)).toContain('localStorage')

    await import('./session')

    expect(probe.findings(NEEDLE)).toEqual([])
  })
})
