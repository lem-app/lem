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
 * `location`, `window.name`, and the contents of `Map` and `Set` — whose
 * entries live in internal slots that `Reflect.ownKeys` cannot see, and which
 * are covered rather than documented away because *a token in a `Map` keyed by
 * device id needs no adversarial intent at all*.
 *
 * `Map`/`Set` coverage includes **hostile subclasses**: enumeration goes through
 * the built-in `Map.prototype.forEach`, captured at module load, so overriding
 * `Symbol.iterator` or `entries()` to throw does not hide the contents. A
 * `for...of` walk would have left such a token sitting in plain sight behind
 * this file's `catch` while `.get()` kept working.
 *
 * ### One rule, learned three times: never classify an object by what it says
 *
 * Review found the same bug in three successive rounds - `instanceof`, then
 * `Symbol.hasInstance`, then an own `constructor` property. Each time the walk
 * decided what an object *was* by consulting something the object controls, and
 * each time a `Proxy` could lie about it. The third was the worst: a wrapped
 * `Map` claiming an own `constructor` was classified as an inert prototype and
 * dropped **silently**, which is indistinguishable from a clean result.
 *
 * The rule that came out of it, and the one to keep:
 *
 * - To decide whether to **stay quiet** about something, use only facts that
 *   cannot be forged - **object identity** (`===` against a prototype captured
 *   at module load) or an **internal-slot probe** (a built-in method that
 *   throws unless the slot is really there). A forged answer here is a silent
 *   bypass, and silence is the thing being exploited.
 * - To decide whether to **surface** something, a heuristic is acceptable,
 *   because a forged answer costs a missed report rather than a false
 *   all-clear. Those are documented as boundaries below.
 *
 * The asymmetry is the whole design. Anything that presents as a collection and
 * cannot be read is reported unless it is *identically* a built-in prototype or
 * *provably* a weak collection.
 *
 * There is also **no type test before enumerating**. Asking "is this a Map?"
 * with `instanceof` and then reading it fails at the question, three ways:
 * `Map[Symbol.hasInstance]` can be poisoned so a real Map answers no; a `Proxy`
 * over a Map answers yes and then cannot be read; and - the one that was a live
 * bug rather than an attack - **a Map from another realm answers no**, because
 * `instanceof` compares against this realm's `Map.prototype`. This dashboard
 * frames services by construction (spec §3.1), so cross-realm collections are
 * routine. The gated version was silently stepping over `console._times`,
 * `console[Symbol(counts)]` and `performance[Symbol(kEvents)]`, which are real
 * Maps with real contents; that was found by measuring, not by reasoning.
 *
 * Instead the captured built-in is simply attempted on every object, and
 * success is the test - it only succeeds on a genuine `[[MapData]]` slot, which
 * is precisely the property that matters and the one thing that cannot be
 * forged.
 *
 * When it fails on something that still *presents* as a collection - a `Proxy`
 * wrapping a Map, which is an ordinary method-binding or logging pattern and is
 * fully functional for the code holding it - the walk **reports it** rather
 * than skipping it. We cannot unwrap it and so cannot prove it holds the token;
 * we can decline to certify it clean, which is the honest answer.
 *
 * The false-positive cost of reporting was measured before adopting it, and is
 * currently **zero** against the real jsdom + vitest graph - which the
 * `starts clean` test asserts on every run, so it cannot rot. To see what the
 * rejected alternative cost, replace the body of {@link presentsAsCollection}
 * with a duck-type on method names:
 *
 * ```ts
 * const c = value as Record<string, unknown>
 * return typeof c.get === 'function' && typeof c.set === 'function' &&
 *        typeof c.has === 'function'
 * ```
 *
 * and run this file: `starts clean` fails and lists them, led by
 * `globalThis.Reflect`, which has all three methods and is not a collection.
 * (Stated as a procedure, not a count: an independent reimplementation of that
 * measurement got a different number, and the count is not the point - the
 * comparison is.)
 *
 * **Not covered. Every one of these is pinned by a test that asserts the miss**,
 * so closing a gap fails loudly and forces this list to be updated, rather than
 * letting the boundary drift while the file still reads as exhaustive:
 *
 * - **Closures.** A value captured in a closure is invisible to any property
 *   walk. This is not a defect to fix - it is precisely the mechanism
 *   `session.ts` uses, and it is why the clean case passes. A token parked in a
 *   closure reachable from a global (`window.get = () => token`) is missed.
 * - **`WeakMap` / `WeakSet`.** Non-enumerable *by specification*: no caller can
 *   list their contents. Unlike `Map`/`Set` this is not a hole that more code
 *   would close; it is closer in kind to a closure. A **genuine** one is
 *   therefore passed over quietly - but membership is settled by probing the
 *   internal slot ({@link hasWeakCollectionSlot}), never by asking the object,
 *   so a `Proxy` wrapping a weak collection has no slot of its own and **is**
 *   reported.
 * - **Properties hung on function objects.** Excluded for cost, and the number
 *   is real, and reproducible rather than quoted: delete the `typeof value ===
 *   'function'` guard in {@link reachableFromGlobals} and run this file. It
 *   crosses tens of thousands of objects without terminating - jsdom's
 *   constructor graph fans out through every interface prototype - against well
 *   under a second with the guard in place. A test that does not terminate is
 *   not a test. (Figures are deliberately not frozen here; the object count has
 *   moved twice in as many review rounds, so the command is the durable part.)
 * - **Any encoding of the token.** The leaf test is a literal substring match,
 *   so `btoa(token)`, URI-encoding or a XOR all defeat it. Detecting arbitrary
 *   transformations is undecidable in general; chasing them one at a time would
 *   rebuild the same losing enumeration this file exists to replace.
 * - **A `Proxy` with a lying `ownKeys` trap.** Returning `[]` for a
 *   non-existent configurable property violates no ES invariant, so the walker
 *   cannot enumerate what the trap hides.
 * - **Out-of-band stores that are not object properties**: IndexedDB, the Cache
 *   API and `document.cookie`. These are covered instead by {@link installProbe}
 *   below, which instruments the APIs directly.
 *
 * The last three all require deliberate intent; `Map`/`Set` did not, which is
 * the line used to decide what gets covered and what gets documented.
 *
 * One further exclusion, for correctness rather than cost: top-level **test
 * harness globals** (`process`, `__vitest_*`, the jest matcher symbol) are
 * skipped at depth 1. They do not exist in a browser, so including them makes
 * the walk assert facts about vitest - and `__vitest_mocker__` in particular
 * retains the *source text* of every loaded module, so it contains this file's
 * own `NEEDLE` literal and every run would report a "finding" that is a string
 * constant in a test. See {@link isHarnessRoot}; it matches by name at depth 1
 * only, so nothing in the page can hide behind it.
 *
 * The union of the two detectors - reachability plus instrumented out-of-band
 * stores - is what backs the criterion. Neither alone does.
 *
 * ## What this file does not cover: the React render tree
 *
 * This file was **green for an entire review round while the token was
 * trivially readable by a framed service** through React's fiber nodes. That
 * exposure was [#82](https://github.com/lem-app/lem/issues/82); it is fixed,
 * and `fiber-reachability.test.tsx` is what holds it fixed.
 *
 * ### Why the two files stay separate - and be careful about the reason
 *
 * The tempting explanation is that a `globalThis`-rooted walk structurally
 * cannot see fiber data. **That is false, and was checked rather than assumed:**
 * render a component holding the token and this very walk finds it, at
 *
 * ```
 * globalThis.document.body.firstElementChild.__reactContainer$…
 *   .alternate.child.memoizedState.memoizedState
 * ```
 *
 * and two other paths. Fiber expandos are own properties of DOM elements, and
 * `document` is reachable from `globalThis`, so the algorithm gets there fine.
 *
 * The real reason this file stayed green is duller and more useful: **none of
 * its cases call `render()`.** It exercises `storeToken()` and a `useAuth`
 * login through `renderHook`, neither of which mounts a component tree holding
 * a token. A walk finds nothing if the setup never creates the thing.
 *
 * So the two files are separated by **setup, not by capability**. Merging them
 * would mean rendering a realistic tree in every case here - which changes what
 * each storage assertion means and makes a failure ambiguous between "it was
 * persisted" and "it was rendered". Keeping them apart keeps each failure
 * diagnostic: this file says *stored*, that file says *rendered*.
 *
 * If you do merge or re-root them, the thing you must preserve is that some
 * case actually renders a component holding the token. That is the property
 * that was missing, and its absence cost a full review round.
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

/**
 * The built-in `forEach` for each collection, captured at module load.
 *
 * Held by reference so that neither a subclass overriding `Symbol.iterator`
 * nor later tampering with `Map.prototype` can change what the walk enumerates.
 * These functions read the [[MapData]] / [[SetData]] internal slots directly.
 */
// Unbound on purpose: these are invoked with an explicit receiver via `.call`,
// which is the entire mechanism - a bound or instance-resolved method could be
// replaced by the object being inspected.
/* eslint-disable @typescript-eslint/unbound-method */
const MAP_FOR_EACH = Map.prototype.forEach as (
  this: unknown,
  callback: (value: unknown, key: unknown) => void
) => void
const SET_FOR_EACH = Set.prototype.forEach as (
  this: unknown,
  callback: (value: unknown) => void
) => void
// `has` is the cheapest method with a `RequireInternalSlot` step, which is all
// these two are used for - see `hasWeakCollectionSlot`.
const WEAKMAP_HAS = WeakMap.prototype.has as (this: unknown, key: object) => boolean
const WEAKSET_HAS = WeakSet.prototype.has as (this: unknown, key: object) => boolean
/* eslint-enable @typescript-eslint/unbound-method */

/** A stable object to probe weak collections with; never stored anywhere. */
const WEAK_PROBE_KEY: object = Object.freeze({})

/**
 * Does this object hold a genuine `[[WeakMapData]]`/`[[WeakSetData]]` slot?
 *
 * Probed rather than asked: `WeakMap.prototype.has` performs
 * `RequireInternalSlot` before it looks at the key, so it throws on anything
 * that is not really a weak collection. A `Proxy` around one fails the probe,
 * because `.call()` bypasses its traps and the proxy has no slot of its own -
 * which is what we want, since such a wrapper *is* worth reporting.
 *
 * A real one is not. Weak collections are non-enumerable **by specification**,
 * for every caller, so finding one says nothing about whether it holds a token
 * and reporting them would be noise on an irreducible boundary rather than a
 * signal. jsdom and vitest between them put several on the graph
 * (`document[Symbol(impl)]._workingNodeIterators._refMap`,
 * `globalThis[Symbol(matchers-object)]`).
 */
function hasWeakCollectionSlot(value: object): boolean {
  try {
    WEAKMAP_HAS.call(value, WEAK_PROBE_KEY)
    return true
  } catch {
    // Not a WeakMap; try the other one.
  }
  try {
    WEAKSET_HAS.call(value, WEAK_PROBE_KEY)
    return true
  } catch {
    return false
  }
}

/**
 * Read a `Map`'s entries through the captured built-in, or `null` if this
 * object has no `[[MapData]]` slot.
 *
 * Entries are buffered inside the `try` so that a throw from the *caller's*
 * handling can never be mistaken for "not a Map".
 */
function readMapEntries(value: object): [unknown, unknown][] | null {
  const entries: [unknown, unknown][] = []
  try {
    MAP_FOR_EACH.call(value, (entryValue: unknown, entryKey: unknown) => {
      entries.push([entryKey, entryValue])
    })
  } catch {
    return null
  }
  return entries
}

/** As {@link readMapEntries}, for `[[SetData]]`. */
function readSetEntries(value: object): unknown[] | null {
  const entries: unknown[] = []
  try {
    SET_FOR_EACH.call(value, (entry: unknown) => {
      entries.push(entry)
    })
  } catch {
    return null
  }
  return entries
}

/**
 * The built-in collection prototypes, captured at module load.
 *
 * Held for **reference comparison only**. Three rounds of review found the same
 * bug three times - `instanceof`, then `Symbol.hasInstance`, then an own
 * `constructor` property - and every one of them classified an object using
 * something the object controls, which a `Proxy` can lie about. Object identity
 * is the one thing it cannot: a proxy wrapping `Map` is a *different object*
 * from `Map.prototype` no matter what its traps say.
 */
const BUILTIN_COLLECTION_PROTOTYPES: readonly object[] = [
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
]

/**
 * Is this object one of the built-in collection prototypes *itself*?
 *
 * The only thing excluded from reporting, and excluded by `===` alone. These
 * hold no instance data, so there is genuinely nothing to miss in them.
 *
 * A subclass prototype is **not** identity-equal to a built-in and is therefore
 * *not* excluded - it gets reported like any other unreadable collection. That
 * is deliberate: the previous `constructor`-based check quietened subclass
 * prototypes and, in doing so, let a `Proxy` with a lying
 * `getOwnPropertyDescriptor` trap disappear completely. A little noise that
 * cannot be forged beats silence that can.
 */
function isBuiltinCollectionPrototype(value: object): boolean {
  return BUILTIN_COLLECTION_PROTOTYPES.includes(value)
}

/**
 * Does this object present itself as a `Map`/`Set` while having no internal
 * slot to read?
 *
 * Two signals, the identity one first:
 *
 * 1. **Its prototype chain contains a captured built-in collection prototype,
 *    by `===`.** A `Proxy` forwards `getPrototypeOf` to its target unless it
 *    installs a trap specifically to lie about it.
 * 2. Its `Symbol.toStringTag` says `Map`/`Set`. A functional wrapper forwards
 *    this through the same `get` trap that makes it usable.
 *
 * Note the asymmetry, which is the point: this decides whether to **surface**
 * something, so a forged answer costs a missed report - a documented boundary.
 * {@link isBuiltinCollectionPrototype} decides whether to **stay quiet**, so a
 * forged answer there would be a silent bypass, and it is identity-only.
 *
 * An object that neither enumerates as a collection nor presents as one is
 * indistinguishable from a plain object, and there are tens of thousands of
 * those in the graph. That limit is irreducible, not an oversight.
 */
function presentsAsCollection(value: object): boolean {
  try {
    let proto: object | null = Object.getPrototypeOf(value) as object | null
    let hops = 0
    while (proto !== null && hops < PROTOTYPE_HOPS) {
      if (BUILTIN_COLLECTION_PROTOTYPES.includes(proto)) return true
      proto = Object.getPrototypeOf(proto) as object | null
      hops += 1
    }

    const tag = Object.prototype.toString.call(value)
    return tag === '[object Map]' || tag === '[object Set]'
  } catch {
    return false
  }
}

/**
 * Top-level globals that exist only because these tests run in Node under
 * vitest, and that a browser never has.
 *
 * This is a **modelling** decision, not a convenience: the question the walk
 * asks is "can code in the framed realm reach the token", and code in a browser
 * cannot reach `process` or `__vitest_worker__` because they do not exist. Left
 * in, the walk asserts facts about vitest instead - concretely,
 * `__vitest_worker__` holds the **source text of every loaded module**, so it
 * contains this file's own `NEEDLE` literal and every run would "find" a token
 * that is nothing but a string constant in a test.
 *
 * Kept deliberately narrow: matched by name, at depth 1 only, so a production
 * value can never hide behind it. Anything reachable by a second path is still
 * found by that path.
 */
const HARNESS_ONLY_ROOTS = new Set(['process', 'global'])

/** Vitest hangs several registries off `__vitest_*` globals; none exist in a browser. */
const HARNESS_ROOT_PATTERN = /^__vitest/

/** True for a top-level global that belongs to the test harness, not the page. */
function isHarnessRoot(key: string | symbol): boolean {
  if (typeof key === 'symbol') return (key.description ?? '').includes('jest-matchers')
  return HARNESS_ONLY_ROOTS.has(key) || HARNESS_ROOT_PATTERN.test(key)
}

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

    // Only objects and functions have properties worth following; everything
    // else is a leaf that is not a string.
    const traversable = value !== null && (typeof value === 'object' || typeof value === 'function')
    if (!traversable) continue

    // THE function exclusion. Deleting this single line genuinely re-enables
    // descent into function objects (and makes the walk take ~23 s against
    // jsdom's constructor graph) - it is not shadowed by the check above, so a
    // reverter testing the documented boundary gets a true signal rather than a
    // silent no-op. See the module comment for the measurement.
    if (typeof value === 'function') continue

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
      // Depth 0 is `globalThis` itself, so this only ever skips a top-level
      // harness global - see HARNESS_ONLY_ROOTS.
      if (depth === 0 && isHarnessRoot(key)) continue

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

      queue.push({ value: child, path: `${path}.${String(key)}`, depth: depth + 1 })
    }

    // `Map` and `Set` hold their contents in internal slots, not in own
    // properties, so `Reflect.ownKeys` cannot see them. A token in a `Map`
    // keyed by device or session id is an ordinary thing to write - no
    // adversarial intent required - which is why this is traversed rather than
    // documented as a boundary.
    //
    // Enumeration goes through the **built-in** `forEach`, captured at module
    // load, rather than `for...of`, and with **no `instanceof` gate at all**.
    //
    // There is no type test here on purpose. Asking "is this a Map?" with a
    // tamperable operator and *then* enumerating fails at the question, in both
    // directions: `Map[Symbol.hasInstance]` can be poisoned so a real Map
    // answers no, and a `Proxy` wrapping a Map answers yes but cannot be
    // enumerated. Attempting the captured built-in and letting success be the
    // test removes the question. `Map.prototype.forEach` only succeeds on a
    // genuine `[[MapData]]` internal slot, which is exactly the property we
    // care about and is the one thing that cannot be forged.
    const mapEntries = readMapEntries(object)
    const setEntries = mapEntries === null ? readSetEntries(object) : null

    if (mapEntries !== null) {
      mapEntries.forEach(([entryKey, entryValue], index) => {
        queue.push({ value: entryKey, path: `${path}.<mapKey ${index}>`, depth: depth + 1 })
        queue.push({
          value: entryValue,
          path: `${path}.get(${String(entryKey)})`,
          depth: depth + 1,
        })
      })
    } else if (setEntries !== null) {
      setEntries.forEach((entry, index) => {
        queue.push({ value: entry, path: `${path}.<setEntry ${index}>`, depth: depth + 1 })
      })
    } else if (
      presentsAsCollection(object) &&
      !isBuiltinCollectionPrototype(object) &&
      !hasWeakCollectionSlot(object)
    ) {
      // It behaves like a collection to application code but has no internal
      // slot, so its contents cannot be read - a `Proxy` around a real Map is
      // the ordinary way to land here, and a method-binding or logging wrapper
      // is a perfectly normal thing to write.
      //
      // We cannot unwrap it, so we cannot prove it holds the token. We can
      // refuse to certify it clean, which is the honest result. Silently
      // skipping it would turn a bypass into a green tick.
      found.push(`${path} <unenumerable collection: cannot be read, not certified clean>`)
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

  // Map/Set contents live in internal slots, invisible to `Reflect.ownKeys`.
  // This one needs no adversarial intent at all - "a Map of sessions keyed by
  // device id" is what an ordinary implementation looks like - which is why it
  // is covered rather than documented away.
  it('finds a token held as a Map value', () => {
    plantGlobal('__lemSessions', new Map([['dev-7f3a', NEEDLE]]))

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemSessions.get(dev-7f3a)')
  })

  it('finds a token used as a Map key', () => {
    plantGlobal('__lemSeen', new Map([[NEEDLE, { at: 1 }]]))

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemSeen.<mapKey 0>')
  })

  it('finds a token inside a Set', () => {
    plantGlobal('__lemIssued', new Set([NEEDLE]))

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemIssued.<setEntry 0>')
  })

  it('finds a token in a Map nested inside a plain object', () => {
    plantGlobal('__lemState', { cache: new Map([['t', NEEDLE]]) })

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemState.cache.get(t)')
  })

  // A `for...of` walk calls the object's own `Symbol.iterator`, so a subclass
  // that throws from it would hide its contents behind the walk's `catch` while
  // `.get()` kept working perfectly. Going through the built-in `forEach`
  // defeats that, because it reads the internal slot rather than the iterator.
  it('finds a token in a Map whose Symbol.iterator has been sabotaged', () => {
    class HostileMap<K, V> extends Map<K, V> {
      [Symbol.iterator](): MapIterator<[K, V]> {
        throw new Error('enumeration refused')
      }
      override entries(): MapIterator<[K, V]> {
        throw new Error('enumeration refused')
      }
    }

    const hostile = new HostileMap<string, string>()
    hostile.set('session', NEEDLE)
    plantGlobal('__lemHostile', hostile)

    // The sabotage is real: a naive walk would throw here and give up.
    expect(() => [...hostile]).toThrow('enumeration refused')
    // ...and the value is still trivially available to anyone holding the Map.
    expect(hostile.get('session')).toBe(NEEDLE)

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemHostile.get(session)')
  })

  // The type gate used to be `instanceof`, which the object being inspected can
  // answer for itself. Poisoning `Symbol.hasInstance` made an ordinary,
  // untampered Map invisible - the walker simply stopped recognising it. There
  // is no gate any more: the captured built-in is attempted on everything, and
  // only a genuine [[MapData]] slot lets it succeed.
  it('finds a token in a real Map even when Map[Symbol.hasInstance] is poisoned', () => {
    const original = Object.getOwnPropertyDescriptor(Map, Symbol.hasInstance)
    Object.defineProperty(Map, Symbol.hasInstance, { value: () => false, configurable: true })

    try {
      const real = new Map([['session', NEEDLE]])
      // The poisoning is real: a gated walker would now skip this entirely.
      expect(real instanceof Map).toBe(false)
      plantGlobal('__lemPoisoned', real)

      expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemPoisoned.get(session)')
    } finally {
      if (original) Object.defineProperty(Map, Symbol.hasInstance, original)
      else Reflect.deleteProperty(Map, Symbol.hasInstance)
    }
  })

  // Removing the gate fixed a live correctness bug as well as a tampering one,
  // and this is the case that matters most here: **a Map from another realm**.
  // `instanceof` compares against *this* realm's `Map.prototype`, so a Map made
  // in an iframe is not `instanceof Map` and was skipped in silence - contents
  // and all. This dashboard frames services by construction (spec §3.1), so
  // cross-realm objects are routine, not hypothetical.
  //
  // Found by measurement, not by reasoning: with the gate restored, the walk
  // reports `console._times`, `console[Symbol(counts)]` and
  // `performance[Symbol(kEvents)]` as unreadable - real Node-realm Maps that
  // the gated walk had been stepping over for two rounds.
  it('finds a token in a Map created in another realm', () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)

    try {
      const foreign = frame.contentWindow as (Window & typeof globalThis) | null
      if (foreign === null) throw new Error('jsdom gave the iframe no contentWindow')

      const foreignMap = new foreign.Map<string, string>([['session', NEEDLE]])
      // The premise: this really is invisible to `instanceof`.
      expect(foreignMap instanceof Map).toBe(false)
      // ...and really is a working Map holding the token.
      expect(foreignMap.get('session')).toBe(NEEDLE)

      plantGlobal('__lemForeign', foreignMap)

      expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemForeign.get(session)')
    } finally {
      frame.remove()
    }
  })

  // A `Proxy` whose `get` trap rebinds methods to the real target is an
  // ordinary pattern - method-binding wrappers, logging, validation. It is
  // fully functional for application code and completely opaque to the walker,
  // because `.call()` bypasses the trap and the proxy has no internal slot.
  //
  // We cannot unwrap it, so we cannot prove it holds the token. Reporting it is
  // the honest answer; skipping it silently would be a green tick over a
  // bypass.
  it('refuses to certify a Proxy-wrapped Map, rather than skipping it silently', () => {
    const target = new Map([['session', NEEDLE]])
    const wrapper = new Proxy(target, {
      // Receiver is the *target*, not the proxy - which is what a real binding
      // wrapper does, and what makes accessors like `size` keep working.
      get(inner, key) {
        const value = Reflect.get(inner, key, inner) as unknown
        if (typeof value !== 'function') return value
        return (value as (...args: unknown[]) => unknown).bind(inner)
      },
    })
    plantGlobal('__lemWrapped', wrapper)

    // The wrapper genuinely works - this is not a broken object nobody would
    // write. Application code holding it is entirely happy.
    expect(wrapper.get('session')).toBe(NEEDLE)
    expect(wrapper.size).toBe(1)

    const found = reachableFromGlobals(NEEDLE)

    // Not "found the token" - we cannot see it. "Cannot certify this clean."
    expect(found).toContain(
      'globalThis.__lemWrapped <unenumerable collection: cannot be read, not certified clean>'
    )
  })

  // Round 5's finding, and the third instance of one root cause: the walk used
  // to skip "class prototypes" by looking for an own `constructor`, which a
  // `Proxy` can simply claim to have. That made a wrapped Map vanish
  // *completely* - not reported, not flagged, indistinguishable from clean.
  // Exclusion is now by object identity against captured built-ins, which no
  // trap can forge: a proxy is a different object from `Map.prototype`.
  it('reports a Proxy that lies about being a class prototype', () => {
    const target = new Map([['session', NEEDLE]])
    const wrapper = new Proxy(target, {
      get(inner, key) {
        const value = Reflect.get(inner, key, inner) as unknown
        if (typeof value !== 'function') return value
        return (value as (...args: unknown[]) => unknown).bind(inner)
      },
      // The lie: "I have an own `constructor`, so I am an inert prototype."
      getOwnPropertyDescriptor(inner, key) {
        if (key === 'constructor') {
          return { value: Map, writable: true, enumerable: false, configurable: true }
        }
        return Reflect.getOwnPropertyDescriptor(inner, key)
      },
    })
    plantGlobal('__lemFakePrototype', wrapper)

    // The lie works against the old check, and the wrapper still functions.
    expect(Object.getOwnPropertyDescriptor(wrapper, 'constructor')).toBeDefined()
    expect(wrapper.get('session')).toBe(NEEDLE)

    expect(reachableFromGlobals(NEEDLE)).toContain(
      'globalThis.__lemFakePrototype <unenumerable collection: cannot be read, not certified clean>'
    )
  })

  // The weak-collection probe must not become the next hiding place: a real
  // WeakMap is quiet (non-enumerable by spec, for everyone), but a Proxy around
  // one has no slot of its own and is reported.
  it('reports a Proxy wrapping a WeakMap, while a real WeakMap stays quiet', () => {
    const key = { id: 'dev-7f3a' }
    const real = new WeakMap<object, string>([[key, NEEDLE]])
    plantGlobal('__lemRealWeak', real)
    plantGlobal('__lemRealWeakKey', key)

    // A genuine WeakMap is not reported - nobody can enumerate one.
    expect(reachableFromGlobals(NEEDLE)).toEqual([])

    plantGlobal(
      '__lemWrappedWeak',
      new Proxy(real, {
        get(inner, prop) {
          const value = Reflect.get(inner, prop, inner) as unknown
          if (typeof value !== 'function') return value
          return (value as (...args: unknown[]) => unknown).bind(inner)
        },
      })
    )

    expect(reachableFromGlobals(NEEDLE)).toContain(
      'globalThis.__lemWrappedWeak <unenumerable collection: cannot be read, not certified clean>'
    )
  })

  it('finds a token in a Set whose Symbol.iterator has been sabotaged', () => {
    class HostileSet<T> extends Set<T> {
      [Symbol.iterator](): SetIterator<T> {
        throw new Error('enumeration refused')
      }
    }

    const hostile = new HostileSet<string>()
    hostile.add(NEEDLE)
    plantGlobal('__lemHostileSet', hostile)

    expect(() => [...hostile]).toThrow('enumeration refused')

    expect(reachableFromGlobals(NEEDLE)).toContain('globalThis.__lemHostileSet.<setEntry 0>')
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

  // `WeakMap`/`WeakSet` are non-enumerable *by specification* - there is no way
  // to list their contents, for any caller. Unlike Map/Set this is not a hole
  // in the walk that could be closed with more code; it is closer in kind to a
  // closure, and is recorded as such.
  it('does NOT see a token held in a WeakMap — non-enumerable by spec', () => {
    const key = { id: 'dev-7f3a' }
    const weak = new WeakMap<object, string>([[key, NEEDLE]])
    plantGlobal('__lemWeak', weak)
    plantGlobal('__lemWeakKey', key)

    expect(reachableFromGlobals(NEEDLE)).toEqual([])
  })

  // The leaf test is a literal substring match, so any encoding defeats it.
  // Detecting arbitrary transformations is undecidable in general - we would be
  // chasing base64, then URI-encoding, then a XOR. Stated as a limit instead.
  it('does NOT see a base64-encoded token — the leaf check is a substring match', () => {
    plantGlobal('__lemEncoded', btoa(NEEDLE))

    expect(reachableFromGlobals(NEEDLE)).toEqual([])
  })

  // A Proxy may return whatever it likes from `ownKeys` for a non-existent,
  // configurable property without violating any ES invariant, so the walker
  // cannot enumerate what the trap chooses to hide. Requires deliberate intent,
  // which puts it in the same class as the closure and function boundaries.
  it('does NOT see a token behind a lying Proxy ownKeys trap', () => {
    const target = { hidden: NEEDLE }
    plantGlobal(
      '__lemProxy',
      new Proxy(target, {
        ownKeys: () => [],
        getOwnPropertyDescriptor: () => undefined,
      })
    )

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
    // The hook exposes no token to assert on - that is the #82 fix. Confirm the
    // login really took by asking the session module, which is where it lives.
    const { readToken } = await import('./session')
    expect(readToken()).toBe(token)
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
    const { readToken } = await import('./session')
    expect(readToken()).toBeNull()
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
