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
 * `localStorage`, deliberately, with the limits written down rather than
 * assumed:
 *
 * - The signaling server issues a **bearer JWT** and this dashboard is a static
 *   SPA on a different origin. There is no same-site session cookie to ride on,
 *   so the token has to be readable by JavaScript either way.
 * - Against XSS, `sessionStorage` and an in-memory variable are **not** a
 *   meaningful improvement: script running on the page can read all three, and
 *   in-memory tokens are still exfiltrated by the same injected script.
 * - What `localStorage` buys is surviving a reload and a second tab, which this
 *   app needs (a tunnel session outliving an accidental refresh is the whole
 *   point).
 * - The real fix is an httpOnly refresh cookie on the signaling origin plus
 *   short-lived access tokens. That is a server change and belongs with the
 *   cloud-authz work, not here.
 *
 * What this module does add, all of which was missing:
 *
 * 1. **Expiry is checked.** `isAuthenticated` used to be `!!getItem('token')`,
 *    so an expired JWT rendered a fully "signed-in" dashboard whose every
 *    request 401'd. `readToken()` decodes `exp` and drops expired tokens.
 * 2. **401 means logged out.** `api/auth.ts` calls {@link expireSession} on any
 *    401 so the UI drops back to the login screen instead of sitting broken.
 */

const TOKEN_STORAGE_KEY = 'token'

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
 * Read the stored token, discarding it if it has expired.
 */
export function readToken(): string | null {
  let stored: string | null
  try {
    stored = localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    // Private-mode / storage-disabled browsers.
    return null
  }

  if (stored === null || stored === '') return null

  if (isTokenExpired(stored)) {
    console.warn('[Session] Stored token has expired, discarding')
    clearToken()
    return null
  }

  return stored
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    console.warn('[Session] Could not persist token (storage unavailable)')
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // Nothing to do - storage is unavailable.
  }
}

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
