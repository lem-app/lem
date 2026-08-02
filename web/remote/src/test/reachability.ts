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
 * - Every `SlotProbe.read` succeeding - an internal-slot probe in each case
 *   (`[[MapData]]`, `[[SetData]]`, `[[WeakMapData]]`/`[[WeakSetData]]`,
 *   `[[StringData]]`, `[[ViewedArrayBuffer]]`/`[[ArrayBufferData]]`). All are
 *   realm-agnostic, and a `Proxy` can satisfy none of them.
 * - `SlotProbe.excluded` - `===` against built-in prototypes captured at load.
 * - `isHarnessRootValue` - `===` against objects captured at load.
 *
 * Each probe's mandatory `presentsAs` is what stops a failed slot read becoming
 * silence: a `Proxy` wrapping a real one is **reported**, not passed over. That
 * pairing is enforced by the type and by a suite test that enumerates
 * {@link SLOT_PROBE_NAMES}, because forgetting it has already happened twice.
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
 *   in the fiber sweep; both 16) - a value nested deeper than that.
 * - `MAX_DECODED_BYTES` - bytes in a buffer larger than this are not decoded.
 *   A JWT is a few hundred bytes, so the cap exists only to stop a
 *   multi-megabyte buffer turning the sweep into an allocation storm.
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
 * - A `presentsAs` returning `false` from its `catch` - a trap can throw from
 *   `getPrototypeOf`. This costs only a **report**, not a false all-clear, so
 *   it sits on the acceptable side of the asymmetry.
 * - **Re-encodings other than raw bytes**: `btoa`, URI-encoding, a XOR, or
 *   splitting the token across two properties. The leaf test is a substring
 *   match on strings; detecting arbitrary transformations is undecidable, and
 *   chasing them one at a time would rebuild the losing enumeration this design
 *   replaced.
 *
 *   **Raw bytes are the exception and are covered**, because they are the one
 *   re-encoding that needs no intent at all: this codebase moves the token as
 *   bytes constantly, so a `TextEncoder` round trip is the likeliest accidental
 *   hiding place there is. Buffers are decoded as UTF-8 and UTF-16LE and handed
 *   back as strings. This was first ruled irreducible and then reversed, on the
 *   evidence that detection is cheap and costs no false positives - the same
 *   test that got `Map`/`Set` covered.
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
// else - see the `boxed-string` probe.
const STRING_VALUE_OF = String.prototype.valueOf as (this: unknown) => string
/* eslint-enable @typescript-eslint/unbound-method */

/** A slot-reading accessor trio for a buffer-backed view. */
interface ViewAccessors {
  buffer: (this: unknown) => unknown
  byteOffset: (this: unknown) => unknown
  byteLength: (this: unknown) => unknown
}

// Unbound on purpose, as with the collection methods above: these getters are
// invoked with an explicit receiver via `.call`, which is what makes them a
// slot probe rather than a property read.
/* eslint-disable @typescript-eslint/unbound-method */
function captureViewAccessors(prototype: object): ViewAccessors | null {
  const get = (name: string): ((this: unknown) => unknown) | undefined =>
    Object.getOwnPropertyDescriptor(prototype, name)?.get
  const buffer = get('buffer')
  const byteOffset = get('byteOffset')
  const byteLength = get('byteLength')
  if (!buffer || !byteOffset || !byteLength) return null
  return { buffer, byteOffset, byteLength }
}

/** `%TypedArray%.prototype` - the shared prototype of every typed array. */
const TYPED_ARRAY_ACCESSORS = captureViewAccessors(
  Object.getPrototypeOf(Uint8Array.prototype) as object
)
const DATA_VIEW_ACCESSORS = captureViewAccessors(DataView.prototype)
const ARRAY_BUFFER_BYTE_LENGTH =
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get ?? null
/* eslint-enable @typescript-eslint/unbound-method */

/**
 * Encodings a token could plausibly be sitting in as raw bytes.
 *
 * UTF-8 is what `TextEncoder` produces and is the realistic accidental case;
 * UTF-16LE covers a buffer built from JavaScript string memory. Decoding is
 * lossy-tolerant on purpose - garbage decodes simply will not contain the
 * needle.
 */
const BYTE_DECODERS = ['utf-8', 'utf-16le'] as const

/**
 * Above this, bytes are not decoded.
 *
 * A JWT is a few hundred bytes, so this is enormous headroom; the cap exists
 * only so a multi-megabyte buffer somewhere in the graph cannot turn the sweep
 * into an allocation storm. It is a finite limit and is named in the taxonomy.
 */
const MAX_DECODED_BYTES = 1 << 20

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
 * Prototypes of every buffer-backed view, captured for identity comparison.
 *
 * `%TypedArray%.prototype` is the shared prototype of all nine typed-array
 * kinds, so one entry covers them all.
 */
const BYTE_VIEW_PROTOTYPES: readonly object[] = [
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  DataView.prototype,
  ArrayBuffer.prototype,
  ...(typeof SharedArrayBuffer === 'function' ? [SharedArrayBuffer.prototype as object] : []),
]

/** `Object.prototype.toString` tags for the same set. */
const BYTE_TAGS: readonly string[] = [
  '[object Int8Array]',
  '[object Uint8Array]',
  '[object Uint8ClampedArray]',
  '[object Int16Array]',
  '[object Uint16Array]',
  '[object Int32Array]',
  '[object Uint32Array]',
  '[object Float32Array]',
  '[object Float64Array]',
  '[object BigInt64Array]',
  '[object BigUint64Array]',
  '[object DataView]',
  '[object ArrayBuffer]',
  '[object SharedArrayBuffer]',
]

/**
 * The bytes behind a typed array, `DataView` or `ArrayBuffer`, or `null`.
 *
 * **Realm-agnostic and unforgeable**, and both words are load-bearing. The
 * obvious `value instanceof Uint8Array` does not work: `TextEncoder` output is
 * not `instanceof` this file's `Uint8Array` in this environment, so a check
 * written that way silently never fires. That is the fourth appearance of the
 * realm-mismatch class in this project - after the cross-realm `Map` here,
 * `instanceof Blob` in Phase 5 and `instanceof ArrayBuffer` in Phase 4 - and it
 * was found by accident while building something else, which is the whole
 * argument for not using `instanceof` at all.
 *
 * These captured accessors read `[[ViewedArrayBuffer]]` / `[[ArrayBufferData]]`
 * and throw without them, so they work across realms and a `Proxy` cannot
 * satisfy them. A detached buffer yields zero bytes, which is correct: there is
 * genuinely nothing left in it.
 */
function readBytes(value: object): Uint8Array | null {
  for (const accessors of [TYPED_ARRAY_ACCESSORS, DATA_VIEW_ACCESSORS]) {
    if (accessors === null) continue
    try {
      const buffer = accessors.buffer.call(value) as ArrayBufferLike
      const byteOffset = accessors.byteOffset.call(value) as number
      const byteLength = accessors.byteLength.call(value) as number
      return new Uint8Array(buffer, byteOffset, byteLength)
    } catch {
      // Not that kind of view; try the next.
    }
  }

  if (ARRAY_BUFFER_BYTE_LENGTH !== null) {
    try {
      const byteLength = ARRAY_BUFFER_BYTE_LENGTH.call(value) as number
      return new Uint8Array(value as ArrayBufferLike, 0, byteLength)
    } catch {
      // Not an ArrayBuffer either.
    }
  }
  return null
}

/**
 * An internal-slot probe, paired with the fallback that keeps it honest.
 *
 * ## Why this is a registry and not five loose functions
 *
 * Twice now a slot probe has shipped **without** a "presents as this, cannot be
 * read" fallback - boxed `String` in one round, byte views in the very next -
 * and each time the result was a `Proxy` wrapping a real instance becoming
 * *completely silent*: no value, no report, indistinguishable from clean. The
 * second one landed one round after the first was fixed, which means
 * remembering was already demonstrably not working.
 *
 * So the pairing is structural. `presentsAs` is a **required** field: a probe
 * that does not declare one is a type error, not a review finding. And
 * {@link SLOT_PROBE_NAMES} is exported so the suites can assert that every
 * registered probe has a Proxy-wrapping test - adding a probe without one fails
 * CI rather than waiting for a reviewer to notice.
 *
 * This is the same move that fixed the duplicated traversal: when a class of
 * defect recurs, the recurrence is the defect.
 */
interface SlotProbe {
  /** Stable identifier, used by the suites to enumerate coverage. */
  readonly name: string
  /**
   * Children to walk, or `null` if this object does not have the slot.
   *
   * An **empty array** is meaningful and different from `null`: it means "this
   * really is one of these, and there is legitimately nothing to read" - the
   * weak collections, which are non-enumerable by specification.
   */
  readonly read: (value: object, path: string) => Child[] | null
  /**
   * Does this object present as this kind while failing {@link read}?
   *
   * Required. This is the half that turns an unreadable wrapper into a report
   * instead of silence, and it is the half that has been forgotten twice.
   */
  readonly presentsAs: (value: object) => boolean
  /**
   * Objects that present as this kind but are excluded from reporting, matched
   * by **identity only** - the built-in prototypes, which hold no instance data.
   */
  readonly excluded: readonly object[]
}

/** Does `value` inherit from any of `prototypes`, by identity? */
function inheritsFrom(value: object, prototypes: readonly object[]): boolean {
  let proto: object | null = Object.getPrototypeOf(value) as object | null
  let hops = 0
  while (proto !== null && hops < PROTOTYPE_HOPS) {
    if (prototypes.includes(proto)) return true
    proto = Object.getPrototypeOf(proto) as object | null
    hops += 1
  }
  return false
}

/**
 * The shared shape of every `presentsAs`: an identity signal on the prototype
 * chain first, then `Symbol.toStringTag`.
 *
 * This one decides whether to **surface**, so a heuristic is acceptable - a
 * forged answer costs a missed report, not a false all-clear. A `Proxy`
 * forwards both signals unless it traps them specifically, and a wrapper that
 * suppresses them has given up being usable as the thing it wraps.
 */
function presenter(prototypes: readonly object[], tags: readonly string[]) {
  return (value: object): boolean => {
    try {
      if (inheritsFrom(value, prototypes)) return true
      return tags.includes(Object.prototype.toString.call(value))
    } catch {
      return false
    }
  }
}

/** A stable object to probe weak collections with; never stored anywhere. */
const WEAK_PROBE_KEY: object = Object.freeze({})

/**
 * Every slot probe, each with its mandatory fallback.
 *
 * There is deliberately **no type test before reading**. Asking "is this a
 * Map?" fails at the question - a poisoned `Symbol.hasInstance` says no for a
 * real one, a `Proxy` says yes for something unreadable, and an object from
 * another realm says no because `instanceof` compares against *this* realm's
 * prototype. Attempting the captured built-in and letting success be the test
 * removes the question: it only succeeds on a genuine slot, which is the one
 * thing that cannot be forged.
 */
const SLOT_PROBES: readonly SlotProbe[] = [
  {
    name: 'map',
    read: (value, path) => {
      const entries: [unknown, unknown][] = []
      try {
        // Buffered inside the `try` so a throw from our own handling can never
        // be mistaken for "not a Map".
        MAP_FOR_EACH.call(value, (entryValue: unknown, entryKey: unknown) => {
          entries.push([entryKey, entryValue])
        })
      } catch {
        return null
      }
      return entries.flatMap(([entryKey, entryValue], index) => [
        { value: entryKey, path: `${path}.<mapKey ${index}>` },
        { value: entryValue, path: `${path}.get(${String(entryKey)})` },
      ])
    },
    presentsAs: presenter([Map.prototype], ['[object Map]']),
    excluded: [Map.prototype],
  },
  {
    name: 'set',
    read: (value, path) => {
      const entries: unknown[] = []
      try {
        SET_FOR_EACH.call(value, (entry: unknown) => {
          entries.push(entry)
        })
      } catch {
        return null
      }
      return entries.map((entry, index) => ({
        value: entry,
        path: `${path}.<setEntry ${index}>`,
      }))
    },
    presentsAs: presenter([Set.prototype], ['[object Set]']),
    excluded: [Set.prototype],
  },
  {
    name: 'weak-collection',
    // `has` performs `RequireInternalSlot` before it looks at the key, so it
    // throws on anything that is not really a weak collection - including a
    // `Proxy` around one, whose traps `.call()` bypasses. A genuine one returns
    // an empty child list: non-enumerable by specification, for every caller,
    // so there is legitimately nothing to read and nothing to report.
    read: (value) => {
      try {
        WEAKMAP_HAS.call(value, WEAK_PROBE_KEY)
        return []
      } catch {
        // Not a WeakMap; try the other one.
      }
      try {
        WEAKSET_HAS.call(value, WEAK_PROBE_KEY)
        return []
      } catch {
        return null
      }
    },
    presentsAs: presenter(
      [WeakMap.prototype, WeakSet.prototype],
      ['[object WeakMap]', '[object WeakSet]']
    ),
    excluded: [WeakMap.prototype, WeakSet.prototype],
  },
  {
    name: 'boxed-string',
    // `new String(token)` is an object, so the caller's `typeof value ===
    // 'string'` leaf test never fires on it and its own properties are single
    // characters. Hand back the primitive so the leaf test does fire.
    read: (value, path) => {
      try {
        return [{ value: STRING_VALUE_OF.call(value), path: `${path}.valueOf()` }]
      } catch {
        return null
      }
    },
    presentsAs: presenter([String.prototype], ['[object String]']),
    excluded: [String.prototype],
  },
  {
    name: 'bytes',
    // The token crosses this codebase as bytes constantly, so a `TextEncoder`
    // round trip is the likeliest way it ends up somewhere unnoticed.
    //
    // Detection is by captured slot accessors, never `instanceof`: a
    // `TextEncoder`'s output is **not** `instanceof` this file's `Uint8Array`
    // in this environment, so a check written that way silently never fires.
    read: (value, path) => {
      const bytes = readBytes(value)
      if (bytes === null) return null
      if (bytes.byteLength > MAX_DECODED_BYTES) return []
      const children: Child[] = []
      for (const encoding of BYTE_DECODERS) {
        try {
          children.push({
            value: new TextDecoder(encoding).decode(bytes),
            path: `${path}.<decoded ${encoding}>`,
          })
        } catch {
          // An unsupported decoder in this runtime yields nothing to search.
        }
      }
      return children
    },
    presentsAs: presenter(BYTE_VIEW_PROTOTYPES, BYTE_TAGS),
    excluded: BYTE_VIEW_PROTOTYPES,
  },
]

/**
 * The registered probe names, for the suites to enumerate.
 *
 * Exported so a test can assert that every probe has a Proxy-wrapping case:
 * adding a probe without one then fails CI instead of shipping the silence that
 * boxed `String` and byte views each shipped once.
 */
export const SLOT_PROBE_NAMES: readonly string[] = SLOT_PROBES.map((probe) => probe.name)

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

  for (const [key, descriptor] of descriptorsOf(object)) {
    // The `__proto__` *accessor* (inherited from `Object.prototype`) is a
    // redundant edge, not a hiding place: `descriptorsOf` already merges the
    // whole prototype chain into this same descriptor set and reads each entry
    // with `object` as the receiver, so a token parked on a prototype is found
    // while walking the instance.
    //
    // An **own** property named `__proto__` is a different thing entirely.
    // `Object.defineProperty(o, '__proto__', { value })` creates ordinary data
    // and never touches the real `[[Prototype]]` slot, so the redundancy
    // argument does not apply to it and skipping it hid a token in plain sight.
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
        // `get` trap could throw deliberately to hide - see the taxonomy,
        // group D; there is no unforgeable alternative to reading it.
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
    // signal rather than a silent no-op. This is a *cost* boundary, not a
    // claim that functions are safe.
    if (typeof child === 'function') continue

    children.push({ value: child, path: `${path}.${String(key)}` })
  }

  // Internal-slot contents. Every probe pairs a slot read with a mandatory
  // `presentsAs` fallback, so an object that claims to be one of these and
  // cannot be read is *reported* rather than passed over - see `SlotProbe`.
  for (const probe of SLOT_PROBES) {
    const slotChildren = probe.read(object, path)
    if (slotChildren === null) continue
    children.push(...slotChildren)
    return { children, opaque: null }
  }

  for (const probe of SLOT_PROBES) {
    // Silence rests on identity: only the built-in prototypes themselves are
    // excluded, and they hold no instance data. A subclass prototype is not
    // identity-equal to one and is reported like anything else.
    if (probe.excluded.includes(object)) return { children, opaque: null }
  }

  for (const probe of SLOT_PROBES) {
    if (probe.presentsAs(object)) {
      // It behaves like the thing to application code but has no internal slot,
      // so its contents cannot be read - a `Proxy` around a real one is the
      // ordinary way to land here. We cannot unwrap it, so we cannot prove it
      // holds the token; we can decline to certify it clean, which is the
      // honest result. Silently skipping it would turn a bypass into a tick.
      return { children, opaque: `${path} ${OPAQUE_NOTE}` }
    }
  }

  return { children, opaque: null }
}
