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
 * ### Why this is a separate file, and must stay one
 *
 * This and `token-persistence.test.ts` ask two independent questions - "is it
 * in a store" and "is it in the page" - and **neither walk can answer the
 * other's**. The proof is reproducible, not theoretical: put the token back
 * into `useAuth`'s React state and the storage suite stays at 30/30 while this
 * one fails three assertions. Those numbers are the reason both exist.
 *
 * So resist tidying them together, and resist re-rooting either walk to "cover
 * both". The two roots - `globalThis` and `document` - are the whole design.
 * A single merged sweep would have been green through the review round in which
 * the token was readable from the framed subtree.
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
 * `stateNode` points back at DOM elements, and a generic walk would go
 * element -> ownerDocument -> defaultView and re-enumerate the whole global
 * graph. Following the structural links a real attacker follows - `return`,
 * `child`, `sibling`, `alternate` - and deep-searching only the data payloads
 * is both cheaper and a more faithful model of the attack.
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

// `vi.hoisted` so the constant exists before the hoisted `vi.mock` factory runs.
const { NEEDLE } = vi.hoisted(() => ({ NEEDLE: 'eyJhbGciOiJIUzI1NiJ9.FIBER-NEEDLE-4c1f.sig' }))

// `useAuth` is statically imported above, so `vi.doMock` would be too late -
// the real `login` would run and try to reach the network.
vi.mock('../api/auth', () => ({
  login: vi.fn().mockResolvedValue({ access_token: NEEDLE, token_type: 'bearer' }),
  register: vi.fn(),
}))

/** Depth limit when deep-searching a single props/state payload. */
const PAYLOAD_DEPTH = 10

/** Fiber fields that carry component data rather than tree structure. */
const PAYLOAD_FIELDS = ['memoizedProps', 'pendingProps', 'memoizedState', 'updateQueue']

/** Fiber fields that link one fiber to another. */
const LINK_FIELDS = ['return', 'child', 'sibling', 'alternate']

function isDomNode(value: unknown): boolean {
  return typeof Node !== 'undefined' && value instanceof Node
}

/** Record every path within one payload at which `needle` appears. */
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
  // Following a DOM node leads back to `document` and then the whole global
  // graph, which `token-persistence.test.ts` already covers.
  if (isDomNode(value)) return
  if (seen.has(value)) return
  seen.add(value)
  if (depth >= PAYLOAD_DEPTH) return

  if (value instanceof Map) {
    let index = 0
    for (const [entryKey, entryValue] of value) {
      deepFind(entryKey, needle, `${path}.<mapKey ${index}>`, depth + 1, seen, out)
      deepFind(entryValue, needle, `${path}.get(${String(entryKey)})`, depth + 1, seen, out)
      index += 1
    }
    return
  }
  if (value instanceof Set) {
    let index = 0
    for (const entry of value) {
      deepFind(entry, needle, `${path}.<setEntry ${index}>`, depth + 1, seen, out)
      index += 1
    }
    return
  }

  for (const key of Reflect.ownKeys(value)) {
    let child: unknown
    try {
      child = (value as Record<PropertyKey, unknown>)[key]
    } catch {
      continue
    }
    if (typeof child === 'function') continue
    deepFind(child, needle, `${path}.${String(key)}`, depth + 1, seen, out)
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
