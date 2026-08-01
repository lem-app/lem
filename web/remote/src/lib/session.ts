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
 * Session token storage for the remote dashboard.
 *
 * ## Where the token lives, and why
 *
 * **A module-scoped variable. Nowhere else.** Not `localStorage`, not
 * `sessionStorage`, not IndexedDB, not a cookie, not the URL.
 *
 * This module used to keep the JWT in `localStorage`, and argued for it on the
 * grounds that an in-memory token is no better against XSS. That argument was
 * sound while the dashboard's origin ran only the dashboard's own code. Phase 4
 * of the tunnel proxy spec ended that: a service is now framed at
 * `/app/<deviceId>/<serviceId>/`, which is **genuinely same-origin with this
 * document** — that is precisely what lets a Service Worker control the frame
 * and proxy its traffic. `sandbox="allow-scripts allow-same-origin"` is not a
 * boundary against it (spec §8.4).
 *
 * So the threat is no longer "an XSS bug we do not have". It is **the framed
 * app itself**, which is third-party code we invited onto this origin and which
 * can read `localStorage` synchronously with three lines of script. A token in
 * `localStorage` is a token handed to every service the user launches.
 *
 * A module-scoped variable does not fix XSS — nothing here does — but it does
 * remove the *durable, enumerable, cross-tab* copy that the framed realm can
 * lift without the dashboard ever running. See spec §8.4 requirement 1.
 *
 * ### The cost, stated plainly
 *
 * **Every full page reload logs the user out.** That is a real regression
 * against the previous behaviour and it is a deliberate trade, not an
 * oversight. The fix is an `HttpOnly` refresh cookie on the signaling origin
 * plus short-lived access tokens — a `cloud/signaling` change that does not
 * exist and is not in this spec's scope (§8.4 requirement 1, and
 * [#79](https://github.com/lem-app/lem/issues/79) tracks it).
 *
 * ### What else this module does
 *
 * 1. **Expiry is checked.** `isAuthenticated` used to be `!!getItem('token')`,
 *    so an expired JWT rendered a fully "signed-in" dashboard whose every
 *    request 401'd. `readToken()` decodes `exp` and drops expired tokens.
 * 2. **401 means logged out.** `api/auth.ts` calls {@link expireSession} on any
 *    401 so the UI drops back to the login screen instead of sitting broken.
 * 3. **The old persisted token is purged on load**, once, so upgrading users do
 *    not keep a readable credential in the exact place this change exists to
 *    empty. Shipping the in-memory switch without the purge would leave every
 *    existing installation exactly as exposed as before.
 */

/** The key the pre-Phase-6 build persisted the JWT under. */
const LEGACY_TOKEN_STORAGE_KEY = 'token'

/**
 * The one and only copy of the signaling JWT.
 *
 * Module-scoped on purpose: it dies with the JavaScript realm, which is what
 * makes a reload a logout and what keeps it out of every store a framed app can
 * enumerate.
 */
let inMemoryToken: string | null = null

/** Treat a token as expired this many seconds early, to cover clock skew. */
const EXPIRY_SKEW_SECONDS = 30

type SessionListener = () => void

const listeners = new Set<SessionListener>()

interface JwtPayload {
  exp?: unknown
}

function base64UrlDecode(segment: string): string | null {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
    return atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
  } catch {
    return null
  }
}

/**
 * Read the `exp` claim (seconds since epoch) from a JWT.
 * Returns `null` for anything that isn't a JWT with a numeric `exp`.
 */
export function readTokenExpiry(token: string): number | null {
  const segments = token.split('.')
  if (segments.length !== 3) return null

  const json = base64UrlDecode(segments[1])
  if (json === null) return null

  let payload: JwtPayload
  try {
    payload = JSON.parse(json) as JwtPayload
  } catch {
    return null
  }

  return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : null
}

/**
 * Whether a token is past its `exp` claim.
 * Tokens with no readable `exp` are treated as valid - the server is the
 * authority, and a 401 will clear them.
 */
export function isTokenExpired(token: string, nowMs: number = Date.now()): boolean {
  const exp = readTokenExpiry(token)
  if (exp === null) return false
  return exp - EXPIRY_SKEW_SECONDS <= nowMs / 1000
}

/**
 * Read the in-memory token, discarding it if it has expired.
 *
 * Returns `null` after a reload by construction: the variable it reads is gone
 * with the realm. That is the documented interim cost of §8.4 requirement 1.
 */
export function readToken(): string | null {
  const held = inMemoryToken
  if (held === null || held === '') return null

  if (isTokenExpired(held)) {
    console.warn('[Session] Token has expired, discarding')
    clearToken()
    return null
  }

  return held
}

/**
 * Hold the token for the lifetime of this JavaScript realm.
 *
 * Deliberately does not persist. If you are here to "just cache it so reloads
 * work", read the module comment first and then §8.4 — the framed app shares
 * this origin, and anything you write is readable by it.
 */
export function storeToken(token: string): void {
  inMemoryToken = token
}

export function clearToken(): void {
  inMemoryToken = null
}

/**
 * Delete a JWT left behind by a build that persisted it.
 *
 * Runs once at module load. Exported so a test can drive it directly rather
 * than through import side effects.
 */
export function purgeLegacyPersistedToken(): void {
  try {
    // The single permitted `localStorage` reference in this app: it only ever
    // *removes* the key the pre-Phase-6 build wrote. Adding a `setItem` here
    // re-creates the exact exposure section 8.4 requirement 1 exists to close.
    // eslint-disable-next-line no-restricted-globals
    localStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY)
  } catch {
    // Private-mode / storage-disabled browsers have nothing to purge.
  }
}

purgeLegacyPersistedToken()

/**
 * Subscribe to "the session is no longer valid" notifications.
 * Returns an unsubscribe function.
 */
export function onSessionExpired(listener: SessionListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Drop the stored token and tell every subscriber the session is gone.
 * Called by the 401 interceptor in `api/auth.ts`.
 */
export function expireSession(): void {
  clearToken()
  listeners.forEach((listener) => {
    listener()
  })
}
