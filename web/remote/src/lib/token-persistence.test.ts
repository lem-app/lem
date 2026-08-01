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
 * ## Enumerating surfaces was not enough, and this is the second attempt
 *
 * The first version of this file listed eight storage surfaces and scanned each
 * one. A reviewer defeated it with a single line inside `storeToken`:
 *
 * ```js
 * Reflect.set(window, '__lemDebugCache', token)
 * ```
 *
 * That passes the lint rule (it names no banned identifier), passes a
 * surface-by-surface sweep (a global property is not one of the eight), and is
 * **worse than `localStorage` would have been**: a same-origin framed iframe
 * reads it as `window.parent.__lemDebugCache` with no API call at all - nothing
 * to intercept, nothing to lint, no storage event.
 *
 * The lesson is that the surface set is open-ended, so enumerating it always
 * loses. This file therefore asserts a **positive property** instead:
 *
 * > After `storeToken()` runs, the token string must not be **reachable** from
 * > a global root.
 *
 * {@link reachableFromGlobals} walks the object graph from `globalThis`,
 * following data properties and accessor getters, and reports every path at
 * which the token turns up. It tests the thing we care about rather than the
 * ways we happened to think of violating it.
 *
 * ## What this covers, and what it does not - measured, not assumed
 *
 * **Covered by the reachability walk**: arbitrary global properties (the
 * reviewer's case), values nested under innocuous keys to depth, DOM element
 * properties and `dataset`, attributes and serialised HTML, `history.state`,
 * `location`, and `window.name`.
 *
 * **Not covered, and the walk cannot be quietly assumed to cover it:**
 *
 * - **Closures.** A value captured in a closure is invisible to any property
 *   walk. This is not a defect to fix - it is precisely the mechanism
 *   `session.ts` uses, and it is why the clean case passes. A token parked in a
 *   closure reachable from a global (`window.get = () => token`) would also be
 *   missed.
 * - **Properties hung on function objects.** Excluded for cost, and the number
 *   is real: including functions makes the walk cross 20,000 nodes in **23
 *   seconds** without terminating, because jsdom's constructor graph fans out
 *   through every interface prototype. Excluding them, the same walk completes
 *   in **671 nodes and ~120 ms**. A 23-second unbounded test is not a test.
 * - **Out-of-band stores that are not object properties**: IndexedDB, the Cache
 *   API and `document.cookie`. These are covered instead by {@link installProbe}
 *   below, which instruments the APIs directly.
 *
 * The union of the two - reachability plus instrumented out-of-band stores - is
 * what backs the criterion. Neither alone does.
 *
 * ## How both halves avoid proving nothing
 *
 * A sweep that finds nothing is worthless until you have shown it can find
 * something, so every detector here is covered twice: a **positive control**
 * that plants a needle through the real API and asserts it is reported, and
 * then the **real assertion**. The controls are not decoration - the failure
 * this project keeps finding is a green suite whose premise was never checked
 * (#72), and an undetectable detector is that failure in miniature.
 *
 * ## What jsdom does and does not give us
 *
 * Real: `localStorage`, `sessionStorage`, `document.cookie`, `location`,
 * `window.name`, `history`, and a DOM to walk.
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

// -- reachability from a global root -----------------------------------------

/** How far from `globalThis` the walk follows references. */
const MAX_DEPTH = 8

/**
 * Hard ceiling on objects visited. Exceeding it **fails**; it never degrades to
 * a quiet partial scan reported as "clean". The observed cost of a full walk is
 * ~670 objects, so this is roughly 300x headroom - if it is ever hit, something
 * structural changed and a human should look, not a green tick.
 */
const MAX_NODES = 200_000

/** Prototype links climbed per object, to reach platform accessors. */
const PROTOTYPE_HOPS = 4

/** Every own and inherited property descriptor, nearest definition winning. */
function descriptorsOf(obj: object): Map<string | symbol, PropertyDescriptor> {
  const collected = new Map<string | symbol, PropertyDescriptor>()
  let current: object | null = obj
  let hops = 0

  while (current !== null && hops < PROTOTYPE_HOPS) {
    // Symbol keys are kept deliberately: jsdom hangs its implementation objects
    // off symbols, and dropping them would blind the walk to the whole DOM.
    let keys: (string | symbol)[]
    try {
      keys = Reflect.ownKeys(current)
    } catch {
      break
    }
    for (const key of keys) {
      if (collected.has(key)) continue
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, key)
      } catch {
        continue
      }
      if (descriptor !== undefined) collected.set(key, descriptor)
    }
    try {
      // `getPrototypeOf` is typed `any` by the standard lib.
      current = Object.getPrototypeOf(current) as object | null
    } catch {
      break
    }
    hops += 1
  }

  return collected
}

/**
 * Every path from `globalThis` at which `needle` is reachable as a string.
 *
 * Breadth-first, so the shallowest (most damning) path is reported first.
 * Accessors are invoked with the object as receiver, which is what surfaces
 * `document.body`, `history.state`, `location.href` and `window.name` — they
 * are prototype accessors, not own data properties, and an own-properties-only
 * walk would silently miss all of them.
 *
 * @throws if the node budget is exhausted, so an incomplete walk can never be
 * mistaken for a clean one.
 */
function reachableFromGlobals(needle: string): string[] {
  const found: string[] = []
  const visited = new WeakSet<object>()
  const queue: { value: unknown; path: string; depth: number }[] = [
    { value: globalThis, path: 'globalThis', depth: 0 },
  ]
  let nodes = 0

  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined) break
    const { value, path, depth } = item

    if (typeof value === 'string') {
      if (value.includes(needle)) found.push(path)
      continue
    }
    if (value === null || typeof value !== 'object') continue

    const object: object = value
    if (visited.has(object)) continue
    visited.add(object)

    nodes += 1
    if (nodes > MAX_NODES) {
      throw new Error(
        `reachability walk exceeded ${MAX_NODES} objects; the result is not trustworthy`
      )
    }
    if (depth >= MAX_DEPTH) continue

    for (const [key, descriptor] of descriptorsOf(object)) {
      let child: unknown
      if ('value' in descriptor) {
        child = descriptor.value
      } else if (descriptor.get) {
        try {
          child = descriptor.get.call(object)
        } catch {
          // Getters that throw hold nothing we could have stored.
          continue
        }
      } else {
        continue
      }

      // Functions are deliberately not descended into - see the module comment
      // for the measurement (23 s and still running, versus ~120 ms without).
      if (typeof child === 'function') continue
      queue.push({ value: child, path: `${path}.${String(key)}`, depth: depth + 1 })
    }
  }

  return found
}

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

/** Global keys a test planted, removed in teardown. */
const plantedGlobals = new Set<string>()

function plantGlobal(key: string, value: unknown): void {
  plantedGlobals.add(key)
  Reflect.set(window, key, value)
}

function clearPlantedGlobals(): void {
  for (const key of plantedGlobals) Reflect.deleteProperty(window, key)
  plantedGlobals.clear()
  delete document.body.dataset.lemToken
  document.body.replaceChildren()
}

// -- the reachability walk ---------------------------------------------------

describe('the reachability walk itself (positive controls)', () => {
  afterEach(() => {
    clearPlantedGlobals()
    clearRealStores()
  })

  it('starts clean, so a finding is never left over', () => {
    expect(reachableFromGlobals(NEEDLE)).toEqual([])
  })

  // The exact line the reviewer used to defeat the surface-enumeration version.
  // It passed the lint rule and all thirteen surface assertions. If this test
  // ever goes green while the walk is broken, the whole file is worthless.
  it("finds a token stashed on an arbitrary global — the reviewer's case", () => {
    plantGlobal('__lemDebugCache', NEEDLE)

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemDebugCache')
  })

  it('finds a token nested under an innocuous-looking global key', () => {
    plantGlobal('__prefs', { ui: { theme: 'dark', session: { t: NEEDLE } } })

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__prefs.ui.session.t')
  })

  it('finds a token in history.state, which no storage API touches', () => {
    window.history.pushState({ t: NEEDLE }, '')

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.history.state.t')
  })

  it('finds a token parked on a DOM element', () => {
    document.body.dataset.lemToken = NEEDLE

    // Reported via `dataset`, and again through the serialised HTML - a token
    // in the document is reachable by several routes, which is the point.
    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.document.body.dataset.lemToken')
  })

  it('finds a token in window.name, which survives cross-origin navigation', () => {
    window.name = NEEDLE

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.name')
  })

  // Stated as a test rather than a comment so that closing the gap fails here
  // and forces the module docs to be updated, instead of the boundary quietly
  // drifting out of date. See the module comment for the 23 s measurement.
  it('does NOT see a property on a function object — a documented boundary', () => {
    const helper = function lemHelper(): void {}
    Reflect.set(helper, 'cached', NEEDLE)
    plantGlobal('__lemHelper', helper)

    expect(reachableFromGlobals(NEEDLE)).toEqual([])
  })

  it('does NOT see a value captured in a closure — by design, not by accident', () => {
    const token = NEEDLE
    plantGlobal('__lemGetToken', () => token)

    // This is the same invisibility that makes `session.ts` correct. A property
    // walk cannot distinguish "safely held" from "hidden"; that is why the
    // reload assertion below exists as a separate, behavioural check.
    expect(reachableFromGlobals(NEEDLE)).toEqual([])
  })
})

describe('the token is not reachable from any global root (spec 8.4 req 1)', () => {
  afterEach(() => {
    clearPlantedGlobals()
    clearRealStores()
  })

  // The criterion, stated positively. No React tree is mounted: a rendered,
  // signed-in dashboard legitimately holds the token in component state, which
  // React attaches to DOM nodes as fiber expandos and which a walk would
  // therefore report. That is inherent to displaying an authenticated UI and is
  // not what requirement 1 governs - it governs *custody*, so custody is what
  // is measured here, in isolation.
  it('is unreachable after storeToken(), the whole criterion in one assertion', async () => {
    const { storeToken } = await import('./session')

    storeToken(NEEDLE)

    expect(reachableFromGlobals(NEEDLE)).toEqual([])
  })

  // The reviewer's mutation, reproduced end to end: a `storeToken` that also
  // parks the token on a global must fail, and must fail *here* rather than in
  // the lint rule, which stays green.
  it('fails when storeToken additionally parks the token on a global', async () => {
    const { storeToken } = await import('./session')

    const leakyStoreToken = (token: string): void => {
      storeToken(token)
      Reflect.set(window, '__lemDebugCache', token)
    }
    plantedGlobals.add('__lemDebugCache')

    leakyStoreToken(NEEDLE)

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemDebugCache')
  })
})

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
