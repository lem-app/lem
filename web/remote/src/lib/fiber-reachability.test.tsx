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
 * The token must not be reachable from the **rendered tree** either.
 *
 * ## Why this exists next to `token-persistence.test.ts`
 *
 * That file asserts the token is unreachable from `globalThis`. It passed
 * while the token was still trivially readable by a framed service, because
 * React does not hang component state off a global - it hangs it off the DOM.
 *
 * Every host element React renders gets a `__reactFiber$…` expando pointing at
 * its fiber node, and a fiber carries `memoizedProps` (this component's props)
 * and `memoizedState` (its hook chain), with `return` walking to the parent.
 * So a token in any component's props or state is reachable as
 *
 * ```js
 * parent.document.body[fiberKey].return.memoizedState.memoizedState…
 * ```
 *
 * from **inside the framed service's iframe**, which is same-origin with the
 * dashboard by construction (spec §3.1) and is rendered by `ClientViewer`, a
 * descendant of the very component that called `useAuth()`.
 *
 * Getting the token out of `localStorage` moved it; it did not remove it.
 * That was [#82](https://github.com/lem-app/lem/issues/82).
 *
 * ### Why this is a separate file - and the reason is not the obvious one
 *
 * It is **not** that `token-persistence.test.ts` is structurally blind to fiber
 * data. That was checked directly rather than argued: render a component
 * holding the token and its `globalThis`-rooted walk finds it through three
 * paths, because fiber expandos are own properties of DOM elements and
 * `document` hangs off `globalThis`. The algorithm is perfectly capable.
 *
 * The actual reason that file stayed green while the token was readable is
 * that **none of its cases call `render()`** - it exercises `storeToken()` and
 * a `renderHook` login, and a walk cannot find a rendered token when nothing
 * rendered one.
 *
 * So the split is by **setup, not by capability**, and that is what to preserve.
 * Merging the files would mean mounting a realistic component tree in every
 * storage case, which makes a failure ambiguous between "it was persisted" and
 * "it was rendered". Two files keeps each failure diagnostic: that one says
 * *stored*, this one says *rendered*.
 *
 * The reproducible check either way: put the token back into `useAuth`'s state
 * and the storage suite stays green while this one fails three assertions.
 *
 * ### Separate suites, **one** traversal
 *
 * Separate *setup* was always right. Separate *machinery* never was, and this
 * file proved it the hard way: it kept a private `instanceof` + `for...of` copy
 * of the collection walk, so three consecutive rounds of hardening landed next
 * door and never arrived here. An ordinary `useState(() => new Map(...))` was
 * invisible to this walk, and a hostile-iterator subclass crashed it, long
 * after both were fixed in the sibling suite.
 *
 * The traversal now lives in `../test/reachability.ts` and both suites call it.
 * **Put traversal behaviour there, not here.** The three tests marked as such
 * below are the standing check that it really is shared.
 *
 * ## The fix this file pins
 *
 * `useAuth()` returns `isAuthenticated`, never the token. Code that needs the
 * value calls `readToken()` at the point of use, so it exists as a local inside
 * a closure and in module scope - and a closure is invisible to a fiber walk
 * for exactly the reason it is invisible to the property walk next door.
 *
 * ## Why the walk follows fiber fields rather than every property
 *
 * The walk follows the structural links a real attacker follows - `return`,
 * `child`, `sibling`, `alternate` - and deep-searches the data payloads. It
 * does not enumerate `stateNode`, which points back at DOM elements, so it does
 * not re-derive the whole global graph the sibling sweep already covers.
 *
 * It does **not**, however, refuse to look at a DOM node it finds inside a
 * payload. It used to, via `instanceof Node`, and that was a silent bypass:
 * `instanceof` answers *yes* for a `Proxy` wrapping a node, so a token parked
 * on such a wrapper in component state was skipped. jsdom's DOM is not backed
 * by engine slots, so there is no unforgeable probe to replace it with either -
 * a trap-less `Proxy` passes a `nodeType` check just as happily.
 *
 * So the skip was removed rather than repaired. Measured cost of walking those
 * payloads properly: a few hundred milliseconds on this suite. Buying back a
 * whole category of silence for that is trivially worth it, and it leaves this
 * file with no `instanceof`-based decision anywhere.
 *
 * Every assertion has a positive control: {@link LeakyParent} reproduces the
 * pre-fix arrangement, and the walk must find it. Without that, "found
 * nothing" would mean nothing.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { useAuth } from '../hooks/useAuth'
import { clearToken, storeToken } from './session'
import { OPAQUE_NOTE, expandObject } from '../test/reachability'

// `vi.hoisted` so the constant exists before the hoisted `vi.mock` factory runs.
const { NEEDLE } = vi.hoisted(() => ({ NEEDLE: 'eyJhbGciOiJIUzI1NiJ9.FIBER-NEEDLE-4c1f.sig' }))

// `useAuth` is statically imported above, so `vi.doMock` would be too late -
// the real `login` would run and try to reach the network.
vi.mock('../api/auth', () => ({
  login: vi.fn().mockResolvedValue({ access_token: NEEDLE, token_type: 'bearer' }),
  register: vi.fn(),
}))

/**
 * Depth limit when deep-searching a single props/state payload.
 *
 * Raised from 10 to match the globals sweep's cap, and for the same measured
 * reason: the visited set bounds the walk, not this number, so a larger value
 * costs nothing. React hook chains and fiber payloads nest deeply, which makes
 * this the sweep where a low cap was most likely to bite. Still finite, and
 * named as a boundary in the shared taxonomy.
 */
const PAYLOAD_DEPTH = 16

/** Fiber fields that carry component data rather than tree structure. */
const PAYLOAD_FIELDS = ['memoizedProps', 'pendingProps', 'memoizedState', 'updateQueue']

/** Fiber fields that link one fiber to another. */
const LINK_FIELDS = ['return', 'child', 'sibling', 'alternate']

/**
 * Record every path within one payload at which `needle` appears.
 *
 * Object expansion - properties, prototype chain, and `Map`/`Set` contents -
 * comes from the **shared** `expandObject`, so every hardening fix made for the
 * globals sweep applies here automatically. This file previously carried its
 * own `instanceof` + `for...of` copy, which meant three rounds of fixes never
 * reached it: an ordinary `useState(() => new Map(...))` was invisible to this
 * walk, and a hostile-iterator subclass crashed it. That duplication was the
 * defect, not the individual misses.
 */
function deepFind(
  value: unknown,
  needle: string,
  path: string,
  depth: number,
  seen: WeakSet<object>,
  out: string[]
): void {
  if (typeof value === 'string') {
    if (value.includes(needle)) out.push(path)
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (depth >= PAYLOAD_DEPTH) return

  const { children, opaque } = expandObject(value, path)
  if (opaque !== null) out.push(opaque)
  for (const child of children) {
    deepFind(child.value, needle, child.path, depth + 1, seen, out)
  }
}

/** Fibers React attached to elements currently in the document. */
function fiberRoots(): { fiber: unknown; path: string }[] {
  const roots: { fiber: unknown; path: string }[] = []
  const elements: Element[] = [document.body, ...document.body.querySelectorAll('*')]

  for (const element of elements) {
    for (const key of Object.keys(element)) {
      if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactProps$')) continue
      roots.push({
        fiber: (element as unknown as Record<string, unknown>)[key],
        path: `${element.tagName.toLowerCase()}[${key.split('$')[0]}$]`,
      })
    }
  }
  return roots
}

/**
 * Every path from a DOM-attached React fiber at which `needle` is reachable.
 *
 * This is the same question `reachableFromGlobals` asks, rooted at the place a
 * framed service actually starts: `parent.document`.
 */
function reachableFromFibers(needle: string): string[] {
  const found: string[] = []
  const visitedFibers = new WeakSet<object>()
  const queue = fiberRoots()

  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined) continue
    const { fiber, path } = item
    if (fiber === null || typeof fiber !== 'object') continue
    if (visitedFibers.has(fiber)) continue
    visitedFibers.add(fiber)

    const node = fiber as Record<string, unknown>

    for (const field of PAYLOAD_FIELDS) {
      deepFind(node[field], needle, `${path}.${field}`, 0, new WeakSet<object>(), found)
    }
    for (const field of LINK_FIELDS) {
      const next = node[field]
      if (next !== null && typeof next === 'object') {
        queue.push({ fiber: next, path: `${path}.${field}` })
      }
    }
  }

  return found
}

// -- positive controls -------------------------------------------------------

/** A child that receives the token as a prop, as `DeviceSelector` used to. */
function LeakyChild({ token }: { token: string }): ReactElement {
  return <span data-testid="leaky-child">{token.length}</span>
}

/**
 * The pre-#82 arrangement, reproduced: a component holds the token in state and
 * hands it to a child as a prop. If the walk cannot find this, it cannot find
 * anything, and every "clean" result below would be worthless.
 */
function LeakyParent(): ReactElement {
  const [token] = useState(NEEDLE)
  return (
    <div>
      <LeakyChild token={token} />
    </div>
  )
}

/** The shipped arrangement: the component learns only whether a session exists. */
function SafeParent(): ReactElement {
  const { isAuthenticated } = useAuth()
  return <div data-testid="safe">{isAuthenticated ? 'in' : 'out'}</div>
}

describe('the fiber walk itself (positive controls)', () => {
  afterEach(() => {
    cleanup()
    clearToken()
  })

  it('finds nothing in an empty document', () => {
    expect(reachableFromFibers(NEEDLE)).toEqual([])
  })

  // The three cases below are the ones that proved this file had its own,
  // unhardened copy of the traversal. Each was already covered next door and
  // none of it had reached here. They are kept as the standing check that the
  // machinery really is shared: if someone reintroduces a private walk in this
  // file, these fail.

  // No tricks at all - a Map in component state is an ordinary thing to write.
  // Under the old `instanceof` gate with `Map[Symbol.hasInstance]` poisoned,
  // this was silently invisible.
  it('finds a token in a Map held in component state, with hasInstance poisoned', () => {
    const original = Object.getOwnPropertyDescriptor(Map, Symbol.hasInstance)
    Object.defineProperty(Map, Symbol.hasInstance, { value: () => false, configurable: true })

    try {
      function MapHolder(): ReactElement {
        const [sessions] = useState(() => new Map([['session', NEEDLE]]))
        return <span>{sessions.size}</span>
      }
      render(<MapHolder />)

      expect(new Map() instanceof Map).toBe(false)
      expect(reachableFromFibers(NEEDLE).length).toBeGreaterThan(0)
    } finally {
      if (original) Object.defineProperty(Map, Symbol.hasInstance, original)
      else Reflect.deleteProperty(Map, Symbol.hasInstance)
    }
  })

  // The DOM skip is a *scope* decision - the globals sweep owns that territory -
  // but it used to be made with `instanceof Node`, which answers **yes** for a
  // `Proxy` wrapping a node. A token parked on such a wrapper in component
  // state was therefore skipped in silence. The slot-style probe answers no, so
  // the wrapper is walked.
  it('finds a token on a Proxy-wrapped DOM node held in component state', () => {
    function NodeHolder(): ReactElement {
      const [wrapped] = useState(() => {
        const element = document.createElement('div')
        Reflect.set(element, 'stashed', NEEDLE)
        return new Proxy(element, {})
      })
      return <span>{typeof wrapped}</span>
    }
    render(<NodeHolder />)

    expect(reachableFromFibers(NEEDLE).length).toBeGreaterThan(0)
  })

  // Under `for...of` this threw rather than reporting, taking the walk with it.
  it('finds a token in a state Map whose Symbol.iterator is sabotaged', () => {
    class HostileMap<K, V> extends Map<K, V> {
      [Symbol.iterator](): MapIterator<[K, V]> {
        throw new Error('enumeration refused')
      }
    }

    function HostileHolder(): ReactElement {
      const [sessions] = useState(() => {
        const map = new HostileMap<string, string>()
        map.set('session', NEEDLE)
        return map
      })
      return <span>{sessions.get('session')?.length}</span>
    }
    render(<HostileHolder />)

    expect(reachableFromFibers(NEEDLE).length).toBeGreaterThan(0)
  })

  // A Proxy-wrapped Map in state cannot be read, so it must be reported rather
  // than passed over - the same refusal-to-certify the globals sweep makes.
  it('refuses to certify a Proxy-wrapped Map held in component state', () => {
    function WrappedHolder(): ReactElement {
      const [sessions] = useState(() => {
        const inner = new Map([['session', NEEDLE]])
        return new Proxy(inner, {
          get(target, key) {
            const value = Reflect.get(target, key, target) as unknown
            if (typeof value !== 'function') return value
            return (value as (...args: unknown[]) => unknown).bind(target)
          },
        })
      })
      return <span>{sessions.get('session')?.length}</span>
    }
    render(<WrappedHolder />)

    expect(reachableFromFibers(NEEDLE).some((path) => path.includes(OPAQUE_NOTE))).toBe(true)
  })

  it('finds a token held in component state and passed as a prop', () => {
    render(<LeakyParent />)

    const found = reachableFromFibers(NEEDLE)

    // Both the child's props and the parent's hook state are reachable.
    expect(found.length).toBeGreaterThan(0)
    expect(found.some((path) => path.includes('memoizedProps'))).toBe(true)
    expect(found.some((path) => path.includes('memoizedState'))).toBe(true)
  })

  it('reaches the token starting from document.body, which is the attack', () => {
    render(<LeakyParent />)

    // Exactly what a framed service runs: from the parent document's body,
    // find an element carrying a fiber expando and walk from there. React
    // attaches these to host elements it rendered, not to `body` itself - in
    // the real app that is everything under `#root`. No test-only handle.
    const carrier = [document.body, ...document.body.querySelectorAll('*')].find((element) =>
      Object.keys(element).some((key) => key.startsWith('__reactFiber$'))
    )

    expect(carrier).toBeDefined()
    expect(reachableFromFibers(NEEDLE).length).toBeGreaterThan(0)
  })
})

describe('the token is not reachable from the render tree (#82)', () => {
  afterEach(() => {
    cleanup()
    clearToken()
    vi.restoreAllMocks()
  })

  it('is absent from the fiber tree while signed in', () => {
    storeToken(NEEDLE)

    render(<SafeParent />)

    expect(reachableFromFibers(NEEDLE)).toEqual([])
  })

  it('is still absent after a login performed through the hook', async () => {
    let captured: ReturnType<typeof useAuth> | null = null

    function Harness(): ReactElement {
      const auth = useAuth()
      captured = auth
      return <div data-testid="harness">{auth.isAuthenticated ? 'in' : 'out'}</div>
    }

    render(<Harness />)
    await act(async () => {
      await captured?.login({ email: 'user@example.test', password: 'pw' })
    })

    // The session really is established...
    const { readToken } = await import('./session')
    expect(readToken()).toBe(NEEDLE)
    // ...and the credential is nowhere in the tree that hosts the iframe.
    expect(reachableFromFibers(NEEDLE)).toEqual([])
  })

  // The structural guarantee: with no `token` on the hook's return type, no
  // component *can* put it in props or state by accident. TypeScript enforces
  // it at build time; this asserts it at runtime too, so a loosened type or an
  // `any` cast cannot reintroduce it silently.
  it('useAuth exposes no token-shaped value at all', () => {
    storeToken(NEEDLE)
    let captured: ReturnType<typeof useAuth> | null = null

    function Harness(): ReactElement {
      captured = useAuth()
      return <div />
    }
    render(<Harness />)

    expect(captured).not.toBeNull()
    const exposed = captured as unknown as Record<string, unknown>
    expect(Object.keys(exposed)).not.toContain('token')
    for (const [key, value] of Object.entries(exposed)) {
      expect(typeof value === 'string' && value.includes(NEEDLE), `${key} leaks the token`).toBe(
        false
      )
    }
  })
})
