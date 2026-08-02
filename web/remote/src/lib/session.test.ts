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
 * Tests for token custody and expiry (F-SEC-1, and spec section 8.4 req 1).
 *
 * The "is it persisted anywhere" question is deliberately *not* asked here -
 * this file can only see the surfaces it thinks to look at. It is asked
 * behaviourally, with positive controls, in `token-persistence.test.ts`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  clearToken,
  expireSession,
  isTokenExpired,
  onSessionExpired,
  purgeLegacyPersistedToken,
  readToken,
  readTokenExpiry,
  storeToken,
} from './session'

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function jwtWithExp(expSeconds: number): string {
  return `${base64Url('{"alg":"HS256"}')}.${base64Url(
    JSON.stringify({ sub: 'user', exp: expSeconds })
  )}.signature`
}

describe('session token storage', () => {
  afterEach(() => {
    clearToken()
    localStorage.clear()
    vi.useRealTimers()
  })

  it('round-trips a valid token', () => {
    const token = jwtWithExp(Math.floor(Date.now() / 1000) + 3600)
    storeToken(token)
    expect(readToken()).toBe(token)
  })

  it('returns null when nothing is stored', () => {
    expect(readToken()).toBeNull()
  })

  it('reads the exp claim', () => {
    expect(readTokenExpiry(jwtWithExp(1234567890))).toBe(1234567890)
  })

  it('returns null for tokens that are not JWTs', () => {
    expect(readTokenExpiry('not-a-jwt')).toBeNull()
    expect(readTokenExpiry('a.b')).toBeNull()
  })

  // F-SEC-1: `isAuthenticated: !!localStorage.getItem('token')` never checked exp.
  it('treats an expired token as expired', () => {
    expect(isTokenExpired(jwtWithExp(Math.floor(Date.now() / 1000) - 10))).toBe(true)
  })

  it('treats a token inside the skew window as expired', () => {
    expect(isTokenExpired(jwtWithExp(Math.floor(Date.now() / 1000) + 5))).toBe(true)
  })

  it('treats a fresh token as valid', () => {
    expect(isTokenExpired(jwtWithExp(Math.floor(Date.now() / 1000) + 3600))).toBe(false)
  })

  it('treats a token with no readable exp as valid (the server decides)', () => {
    expect(isTokenExpired('opaque-token')).toBe(false)
  })

  it('discards an expired token on read instead of reporting a signed-in user', () => {
    storeToken(jwtWithExp(Math.floor(Date.now() / 1000) - 60))

    expect(readToken()).toBeNull()
    // and it is dropped, not merely hidden: a second read agrees.
    expect(readToken()).toBeNull()
  })

  it('notifies subscribers when the session expires', () => {
    storeToken(jwtWithExp(Math.floor(Date.now() / 1000) + 3600))

    const listener = vi.fn()
    const unsubscribe = onSessionExpired(listener)

    expireSession()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(readToken()).toBeNull()

    unsubscribe()
    expireSession()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clearToken drops the held value', () => {
    storeToken('abc')
    expect(readToken()).toBe('abc')
    clearToken()
    expect(readToken()).toBeNull()
  })

  // Spec section 8.4 requirement 1. Shipping the in-memory switch without this
  // would leave every upgrading installation exactly as exposed as before: the
  // framed app reads `localStorage`, not the dashboard's variables.
  it('purges a token left behind by the persisting build', () => {
    localStorage.setItem('token', jwtWithExp(Math.floor(Date.now() / 1000) + 3600))

    purgeLegacyPersistedToken()

    expect(localStorage.getItem('token')).toBeNull()
  })

  it('does not adopt a persisted token as the live session', () => {
    localStorage.setItem('token', jwtWithExp(Math.floor(Date.now() / 1000) + 3600))

    // Reading must not resurrect it: a value an attacker can *write* to
    // localStorage must never become this session's bearer credential.
    expect(readToken()).toBeNull()
  })
})
