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
 * Shared machinery for the two token-reachability sweeps.
 *
 * `token-persistence.test.ts` walks from `globalThis`; `fiber-reachability.test.tsx`
 * walks from React fibers hanging off the DOM. They stay **separate suites**
 * because they differ in *setup* - one renders a component tree and one does
 * not, which is the whole reason the storage sweep could be green while the
 * render tree leaked. They must not differ in *machinery*.
 *
 * They did, and it cost three rounds of review: every hardening fix landed in
 * one file and silently left the other on `instanceof` + `for...of`, so an
 * ordinary `useState(() => new Map(...))` was invisible to the fiber walk long
 * after the same hole had been closed next door. Two implementations of one
 * traversal is the defect; this module is the fix. **Add traversal behaviour
 * here, never in a suite.**
 *
 * ## The rule this module exists to enforce, in one place
 *
 * Review found the same bug four times - `instanceof`, `Symbol.hasInstance`, an
 * own `constructor` property, and a global's string *name*. Every one of them
 * decided what an object *was* by consulting something the object (or whoever
 * placed it) controls, and every one could be forged.
 *
 * - **A decision to stay quiet must rest on an unforgeable fact**: object
 *   identity (`===` against a reference captured at module load) or an
 *   internal-slot probe (a built-in that throws unless the slot is really
 *   there). A forged answer here is a *silent bypass*, which is strictly worse
 *   than a wrong answer, because it is indistinguishable from a clean result.
 * - **A decision to surface something may use a heuristic.** A forged answer
 *   there costs a missed report, not a false all-clear, and those are recorded
 *   as documented boundaries in the suites.
 *
 * ## What this sweep can and cannot see
 *
 * This is the primary artifact of the hardening work, and it is meant to be a
 * **complete and honest statement**, not a summary. Every place the walk stops
 * looking is listed. If you add one, add it here; if you find one that is not
 * here, that omission is itself the bug - two of the entries below were found
 * by auditing *these categories* rather than the code.
 *
 * ### A. Silence resting on an unforgeable fact - safe
 *
 * Nothing in this group can be talked out of looking.
 *
 * - `isBuiltinCollectionPrototype` - `===` against references captured at load.
 * - `isHarnessRootValue` - `===` against objects captured at load.
 * - `hasWeakCollectionSlot` returning `true` - internal-slot probe.
 * - `readMapEntries` / `readSetEntries` succeeding - internal-slot probe.
 * - `readBoxedString` - internal-slot probe (`[[StringData]]`).
 * - The `__proto__` skip, which applies **only** to the inherited accessor and
 *   rests on a structural argument (`descriptorsOf` already merges the chain).
 *   An *own* property named `__proto__` is ordinary data and is walked - it was
 *   not, once, and that was a real bypass.
 * - A descriptor with neither `value` nor `get`: a setter-only property holds
 *   no readable value.
 *
 * ### B. Silence resting on a cost decision - documented, deliberate
 *
 * - The `typeof child === 'function'` skip. Delete that line and the walk fails
 *   to terminate against jsdom's constructor graph. Properties hung on function
 *   objects are therefore not seen.
 *
 * ### C. Finite limits - reachable data beyond them is not seen
 *
 * Both were raised after an audit found real misses, and both were measured as
 * effectively free (the visited set bounds the walk, not these numbers). Raising
 * them does not make them infinite, which is why they are named:
 *
 * - `PROTOTYPE_HOPS` - a property defined further up a prototype chain.
 * - The caller's depth cap (`MAX_DEPTH` in the globals sweep, `PAYLOAD_DEPTH`
 *   in the fiber sweep) - a value nested deeper than that.
 *
 * ### D. Irreducible - no unforgeable alternative exists
 *
 * Stated rather than defended against. Each has a test asserting the miss, so
 * the boundary cannot silently drift.
 *
 * - **A getter that returns a decoy on first read.** A getter is arbitrary
 *   code: reading twice defeats a two-read decoy and loses to a three-read one,
 *   so *no finite read count is safe*. And accessors must be followed - that is
 *   what surfaces `history.state`, `window.name` and `location.href`, which was
 *   load-bearing in an earlier round. An attacker in a framed iframe simply
 *   reads twice.
 * - **A `Proxy` hiding properties** via `ownKeys` /
 *   `getOwnPropertyDescriptor`, or a `get` trap that throws. There is no other
 *   way to ask an object what it has.
 * - `presentsAsCollection`'s `catch` - a trap can throw from `getPrototypeOf`.
 *   This one costs only a **report**, not a false all-clear, so it sits on the
 *   acceptable side of the asymmetry.
 * - **Any re-encoding of the token**: `btoa`, a `TextEncoder` byte array, or
 *   splitting it across two properties. The leaf test is a substring match on
 *   strings; detecting arbitrary transformations is undecidable, and chasing
 *   them one at a time would rebuild the losing enumeration this design
 *   replaced. Bytes are worth singling out here - this codebase moves the token
 *   as bytes constantly, so it is the likeliest accidental miss.
 * - **Values in internal slots with no synchronous accessor**, such as a
 *   resolved `Promise`.
 * - **Closures.** Invisible to any property walk - and the mechanism that makes
 *   `session.ts` correct, which is why the clean case passes at all.
 * - The final `opaque: null`: an object that neither enumerates as a collection
 *   nor presents as one is indistinguishable from the tens of thousands of
 *   plain objects in the graph.
 *
 * The honest summary: this sweep is strong against *accidents* and against
 * *storage*, and it is not a defence against code that is actively hiding from
 * it. It was built to answer "did we leave the token somewhere", and that is
 * the question it answers.
 */

/**
 * Prototype links climbed per object, to reach platform accessors.
 *
 * Raised from 4 after an audit found a token on a 6-deep prototype chain was
 * missed. Measured across 4/8/12: no difference in suite wall time, because the
 * cost is bounded by the visited set rather than by this number. Still finite,
 * and named as a boundary below - a deep enough chain still escapes.
 */
export const PROTOTYPE_HOPS = 12

/** Appended to a path the walk could not read. Not a find - a refusal. */
export const OPAQUE_NOTE = '<unenumerable collection: cannot be read, not certified clean>'

// Unbound on purpose: these are invoked with an explicit receiver via `.call`,
// which is the entire mechanism - a method resolved off the object being
// inspected could be replaced by it.
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
// these two are used for.
const WEAKMAP_HAS = WeakMap.prototype.has as (this: unknown, key: object) => boolean
const WEAKSET_HAS = WeakSet.prototype.has as (this: unknown, key: object) => boolean
// Reads `[[StringData]]`, so it unwraps a boxed String and throws on anything
// else - see `readBoxedString`.
const STRING_VALUE_OF = String.prototype.valueOf as (this: unknown) => string
/* eslint-enable @typescript-eslint/unbound-method */

/**
 * The primitive inside a boxed `String`, or `null` if this is not one.
 *
 * `new String(token)` is an **object**, so the walk's `typeof value ===
 * 'string'` leaf test never fires on it, and its own properties are the
 * individual characters - no single one of which contains the needle. It was
 * therefore invisible. Found by auditing the taxonomy rather than the code.
 *
 * Fixed rather than documented, because the fix is an internal-slot probe and
 * so belongs in the unforgeable group: `String.prototype.valueOf` reads
 * `[[StringData]]` and throws on anything without it, including a `Proxy`
 * wrapping a boxed String - which is then reported by the ordinary path.
 */
function readBoxedString(value: object): string | null {
  try {
    return STRING_VALUE_OF.call(value)
  } catch {
    return null
  }
}

/** A stable object to probe weak collections with; never stored anywhere. */
const WEAK_PROBE_KEY: object = Object.freeze({})

/**
 * The built-in collection prototypes, captured at module load, for reference
 * comparison only. A `Proxy` wrapping `Map` is a different object from
 * `Map.prototype` no matter what its traps claim.
 */
const BUILTIN_COLLECTION_PROTOTYPES: readonly object[] = [
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
]

/**
 * The *objects* the test harness puts on the global, captured by reference at
 * module load.
 *
 * Identity, not name. Matching `'process'` / `'global'` / `__vitest*` as
 * strings was the fourth instance of the forgeable-classification bug: a name
 * is chosen by whoever places the data, so `window.global = new Map([['session',
 * token]])` was silently excluded - and `global` is a variable name an
 * unrelated developer could pick with no ill intent whatsoever. Capturing the
 * value means a later assignment is a *different object* and gets walked.
 */
const HARNESS_ROOT_VALUES: ReadonlySet<unknown> = captureHarnessRoots()

function captureHarnessRoots(): ReadonlySet<unknown> {
  const captured = new Set<unknown>()
  const root = globalThis as unknown as Record<PropertyKey, unknown>

  for (const key of Reflect.ownKeys(globalThis)) {
    const isHarnessName =
      typeof key === 'symbol'
        ? (key.description ?? '').includes('jest-matchers')
        : key === 'process' || key === 'global' || /^__vitest/.test(key)
    if (!isHarnessName) continue

    try {
      const value = root[key]
      if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
        captured.add(value)
      }
    } catch {
      // A global that throws on read holds nothing we could have stored.
    }
  }
  return captured
}

/**
 * Is this *the same object* the harness installed on the global at load time?
 *
 * Silence rests on identity. These exist only because the tests run in Node
 * under vitest and a browser never has them, so walking them makes the sweep
 * assert facts about vitest - `__vitest_mocker__` in particular retains the
 * **source text** of every loaded module, so it contains each suite's own
 * needle literal and every run would "find" a string constant in a test.
 */
export function isHarnessRootValue(value: unknown): boolean {
  return HARNESS_ROOT_VALUES.has(value)
}

/** Every own and inherited property descriptor, nearest definition winning. */
export function descriptorsOf(obj: object): Map<string | symbol, PropertyDescriptor> {
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
 * Read a `Map`'s entries through the captured built-in, or `null` if this
 * object has no `[[MapData]]` slot.
 *
 * There is deliberately **no type test first**. Asking "is this a Map?" fails
 * at the question - a poisoned `Symbol.hasInstance` says no for a real one, a
 * `Proxy` says yes for something unreadable, and a Map from another realm says
 * no because `instanceof` compares against *this* realm's prototype. Attempting
 * the built-in and letting success be the test removes the question: it only
 * succeeds on a genuine slot, which cannot be forged.
 *
 * Entries are buffered inside the `try` so a throw from the caller's handling
 * can never be mistaken for "not a Map".
 */
export function readMapEntries(value: object): [unknown, unknown][] | null {
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
export function readSetEntries(value: object): unknown[] | null {
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
 * Does this object hold a genuine `[[WeakMapData]]`/`[[WeakSetData]]` slot?
 *
 * Silence rests on an internal-slot probe. `WeakMap.prototype.has` performs
 * `RequireInternalSlot` before it looks at the key, so it throws on anything
 * that is not really a weak collection - including a `Proxy` around one, whose
 * traps `.call()` bypasses and which has no slot of its own. Such a wrapper
 * therefore still gets reported.
 *
 * A real one does not: weak collections are non-enumerable **by
 * specification**, for every caller, so finding one says nothing about whether
 * it holds a token.
 */
export function hasWeakCollectionSlot(value: object): boolean {
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
 * Is this object one of the built-in collection prototypes *itself*?
 *
 * Silence rests on identity - `===` against references captured at load. These
 * hold no instance data, so there is nothing to miss in them.
 *
 * A subclass prototype is **not** identity-equal to a built-in and so is *not*
 * excluded; it is reported like any other unreadable collection. The previous
 * `constructor`-based check quietened subclass prototypes and, in doing so, let
 * a `Proxy` with a lying `getOwnPropertyDescriptor` trap disappear entirely.
 */
export function isBuiltinCollectionPrototype(value: object): boolean {
  return BUILTIN_COLLECTION_PROTOTYPES.includes(value)
}

/**
 * Does this object present itself as a `Map`/`Set` while having no slot to read?
 *
 * This one decides whether to **surface**, so a heuristic is acceptable: a
 * forged answer costs a missed report rather than a false all-clear. It still
 * leads with the identity signal.
 *
 * 1. Its prototype chain contains a captured built-in collection prototype, by
 *    `===`. A `Proxy` forwards `getPrototypeOf` unless it traps it specifically.
 * 2. Its `Symbol.toStringTag` says `Map`/`Set`. A functional wrapper forwards
 *    this through the same `get` trap that makes it usable.
 *
 * An object that neither enumerates as a collection nor presents as one is
 * indistinguishable from a plain object, and there are tens of thousands of
 * those in the graph. That limit is irreducible.
 */
export function presentsAsCollection(value: object): boolean {
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

/** One reachable value and the path that reached it. */
export interface Child {
  value: unknown
  path: string
}

/** What one object exposes to the walk. */
export interface Expansion {
  /** Values to keep walking. */
  children: Child[]
  /** Set when the object presents as a collection but cannot be read. */
  opaque: string | null
}

/**
 * Everything reachable one step from `object`: its properties (own and
 * inherited, accessors invoked) plus its collection contents.
 *
 * Both suites call this, so a hardening fix lands once. Callers keep their own
 * roots, depth limits, visited sets and DOM policy - those genuinely differ.
 */
export function expandObject(object: object, path: string): Expansion {
  const children: Child[] = []

  // A boxed String is an object, so the caller's string leaf-test never fires
  // on it. Hand back the primitive so it does.
  const boxed = readBoxedString(object)
  if (boxed !== null) {
    children.push({ value: boxed, path: `${path}.valueOf()` })
  }

  for (const [key, descriptor] of descriptorsOf(object)) {
    // The `__proto__` *accessor* (inherited from `Object.prototype`) is a
    // redundant edge, not a hiding place: `descriptorsOf` already merges the
    // whole prototype chain into this same descriptor set and reads each entry
    // with `object` as the receiver, so a token parked on a prototype is found
    // while walking the instance. Following it only re-reaches class prototypes
    // as objects in their own right - which is how vitest's
    // `DefaultMap.prototype` and `process.allowedNodeEnvironmentFlags.__proto__`
    // turned up as unreadable collections.
    //
    // An **own** property named `__proto__` is a different thing entirely.
    // `Object.defineProperty(o, '__proto__', { value })` creates ordinary data
    // and never touches the real `[[Prototype]]` slot, so the redundancy
    // argument does not apply to it and skipping it hid a token in plain sight.
    // Skip only the inherited accessor; walk an own one like any other key.
    if (key === '__proto__' && Object.getOwnPropertyDescriptor(object, '__proto__') === undefined) {
      continue
    }

    let child: unknown
    if ('value' in descriptor) {
      child = descriptor.value
    } else if (descriptor.get) {
      try {
        child = descriptor.get.call(object)
      } catch {
        // Silence rests on the getter throwing: it yielded no value. A `Proxy`
        // `get` trap could throw deliberately to hide - see the silence audit,
        // third group; there is no unforgeable alternative to reading it.
        continue
      }
    } else {
      // Setter-only accessor: no readable value exists. Nothing to miss.
      continue
    }

    // THE function exclusion, and the only one. Deleting this single line
    // re-enables descent into function objects and makes the walk fail to
    // terminate against jsdom's constructor graph - it is not shadowed
    // anywhere, so a reverter testing the documented boundary gets a true
    // signal rather than a silent no-op. This is a *cost* boundary, documented
    // in both suites, not a claim that functions are safe.
    if (typeof child === 'function') continue

    children.push({ value: child, path: `${path}.${String(key)}` })
  }

  const mapEntries = readMapEntries(object)
  if (mapEntries !== null) {
    mapEntries.forEach(([entryKey, entryValue], index) => {
      children.push({ value: entryKey, path: `${path}.<mapKey ${index}>` })
      children.push({ value: entryValue, path: `${path}.get(${String(entryKey)})` })
    })
    return { children, opaque: null }
  }

  const setEntries = readSetEntries(object)
  if (setEntries !== null) {
    setEntries.forEach((entry, index) => {
      children.push({ value: entry, path: `${path}.<setEntry ${index}>` })
    })
    return { children, opaque: null }
  }

  if (
    presentsAsCollection(object) &&
    // Silence rests on identity...
    !isBuiltinCollectionPrototype(object) &&
    // ...and on an internal-slot probe.
    !hasWeakCollectionSlot(object)
  ) {
    return { children, opaque: `${path} ${OPAQUE_NOTE}` }
  }

  return { children, opaque: null }
}
