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
 * silence: a `Proxy` wrapping a real one is **reported**, not passed over.
 *
 * That pairing is enforced three ways, because relying on care has now failed
 * four separate times:
 *
 * 1. `presentsAs` is a **required field** on `SlotProbe`, so an unpaired probe
 *    is a type error.
 * 2. A suite test enumerates {@link SLOT_PROBE_NAMES} and asserts each probe
 *    reports a `Proxy`-wrapped instance, so a probe that declares
 *    `presentsAs: () => false` fails CI.
 * 3. **Registration is the only path**, not the recommended one. The captured
 *    built-ins live in `./reachability-probes` and are module-private, and this
 *    module is barred by lint from `try`/`catch`, `.prototype` access and
 *    private identifiers - the three ways a brand check can be written. A
 *    reviewer defeated 1 and 2 by splicing a private-field brand check straight
 *    into `expandObject`, bypassing the registry entirely; 3 exists because of
 *    that, and blocks it.
 * 4. **This module may import from `./reachability-probes` and nothing else**,
 *    enforced by `no-restricted-imports`. Rule 3 is a per-file AST check, so it
 *    never saw through an import boundary: the same brand check moved into a
 *    helper module and imported went through completely clean. Extracting a
 *    helper when a lint rule complains is ordinary practice rather than
 *    evasion, which is what made that gap worth closing - the distance between
 *    the blocked technique and the working one was one `import` statement.
 *
 * ### Where this stops, stated plainly
 *
 * The residual is that a contributor can edit the lint allowlist in
 * `eslint.config.js`, or add an unpaired read to `reachability-probes.ts`
 * directly. Neither is prevented, and neither can be: at some point the
 * boundary stops being mechanical and becomes **social** - a reviewer noticing
 * a suspicious diff.
 *
 * That is a real difference in kind from where this started, and it is the
 * honest place to stop. What is closed is the route taken five times out of
 * five: extending the walker in place, or reaching a slot read through a
 * helper. Both of those looked like ordinary work and produced silence. What
 * remains looks like what it is, in a diff someone has to approve.
 *
 * ### And keep the proportion in view
 *
 * This is **test infrastructure**, not a runtime control. Its job is to catch a
 * future contributor who accidentally leaves the token somewhere, and the
 * closing note below says exactly that. Hardening it further buys less than
 * almost anything else this repository could spend the same effort on.
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
 * ### A note on failure modes
 *
 * A `presentsAs` that **throws** rather than returning `false` cascades into
 * most of the suite failing at once. That is fragility, not a security hole,
 * and it is the right side of the tradeoff this project has taken everywhere
 * else - loud beats quiet. It is written down only so the next person reading
 * a wall of red does not treat it as a mystery: check the probes first.
 *
 * The honest summary: this sweep is strong against *accidents* and against
 * *storage*, and it is not a defence against code that is actively hiding from
 * it. It was built to answer "did we leave the token somewhere", and that is
 * the question it answers.
 */

import {
  SLOT_PROBES,
  descriptorsOf,
  hasOwnProtoProperty,
  readPropertyValue,
} from './reachability-probes'
import type { Child } from './reachability-probes'

export {
  PROTOTYPE_HOPS,
  SLOT_PROBE_NAMES,
  descriptorsOf,
  isHarnessRootValue,
} from './reachability-probes'
export type { Child } from './reachability-probes'

/** Appended to a path the walk could not read. Not a find - a refusal. */
export const OPAQUE_NOTE = '<unenumerable collection: cannot be read, not certified clean>'

/** What one object exposes to the walk. */
export interface Expansion {
  /** Values to keep walking. */
  children: Child[]
  /** Set when the object presents as something readable that could not be read. */
  opaque: string | null
}

/**
 * Everything reachable one step from `object`: its properties (own and
 * inherited, accessors invoked) plus whatever the registered slot probes can
 * read out of it.
 *
 * Both suites call this, so a hardening fix lands once. Callers keep their own
 * roots, depth limits and visited sets - those genuinely differ.
 *
 * ## There is nothing type-specific in this function, on purpose
 *
 * Every slot read goes through {@link SLOT_PROBES}. This body contains no
 * `try`/`catch`, no `.prototype` access and no private identifiers - all three
 * banned by lint - and a brand check is by construction "attempt an operation
 * that throws unless the brand is present", so one cannot be written here.
 * The captured built-ins it would need are module-private to
 * `./reachability-probes` and are not exported.
 *
 * That is deliberate and load-bearing. Five slot reads once lived here as
 * ad-hoc branches; two of them shipped without the fallback that stops an
 * unreadable wrapper becoming silence. Adding a sixth read now means adding a
 * probe, and a probe cannot exist without its `presentsAs`.
 */
export function expandObject(object: object, path: string): Expansion {
  const children: Child[] = []

  for (const [key, descriptor] of descriptorsOf(object)) {
    // The inherited `__proto__` accessor is a redundant edge; an own property of
    // that name is ordinary data. See `hasOwnProtoProperty`.
    if (key === '__proto__' && !hasOwnProtoProperty(object)) continue

    const read = readPropertyValue(object, descriptor)
    if (!read.found) continue

    // THE function exclusion, and the only one. Deleting this single line
    // re-enables descent into function objects and makes the walk fail to
    // terminate against jsdom's constructor graph - it is not shadowed
    // anywhere, so a reverter testing the documented boundary gets a true
    // signal rather than a silent no-op. A *cost* boundary, not a claim that
    // functions are safe.
    if (typeof read.value === 'function') continue

    children.push({ value: read.value, path: `${path}.${String(key)}` })
  }

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
