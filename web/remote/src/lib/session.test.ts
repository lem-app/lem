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
 * Tests for token persistence and expiry (F-SEC-1).
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  clearToken,
  expireSession,
  isTokenExpired,
  onSessionExpired,
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
    expect(localStorage.getItem('token')).toBeNull()
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

  it('clearToken removes the stored value', () => {
    storeToken('abc')
    clearToken()
    expect(localStorage.getItem('token')).toBeNull()
  })
})
