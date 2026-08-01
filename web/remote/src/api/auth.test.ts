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
 * Tests for authentication API client, including the 401 interceptor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { login, register, listDevices, registerDevice, UnauthorizedError } from './auth'
import { onSessionExpired, storeToken, readToken } from '../lib/session'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mockFetch(...responses: Response[]): void {
  const fetchMock = vi.fn<typeof fetch>()
  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response))
  globalThis.fetch = fetchMock
}

function fetchMockCalls(): Parameters<typeof fetch>[] {
  return (globalThis.fetch as unknown as { mock: { calls: Parameters<typeof fetch>[] } }).mock.calls
}

describe('Authentication API', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  describe('login', () => {
    it('returns a token on success', async () => {
      mockFetch(jsonResponse({ access_token: 'test-token-123' }))

      await expect(login({ email: 'test@example.com', password: 'password123' })).resolves.toEqual({
        access_token: 'test-token-123',
      })

      const [url, init] = fetchMockCalls()[0]
      expect(url).toBe('http://localhost:8000/auth/login')
      expect(init).toMatchObject({ method: 'POST' })
    })

    it('throws the server-supplied detail on failure', async () => {
      mockFetch(jsonResponse({ detail: 'Invalid credentials' }, 400))

      await expect(login({ email: 'test@example.com', password: 'wrong' })).rejects.toThrow(
        'Invalid credentials'
      )
    })

    it('propagates network errors', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('Network error'))
      globalThis.fetch = fetchMock

      await expect(login({ email: 'a@b.c', password: 'x' })).rejects.toThrow('Network error')
    })
  })

  describe('register', () => {
    it('returns a token on success', async () => {
      mockFetch(jsonResponse({ access_token: 'test-token-456' }))

      await expect(
        register({ email: 'new@example.com', password: 'password123' })
      ).resolves.toEqual({ access_token: 'test-token-456' })
    })

    it('throws the server-supplied detail on failure', async () => {
      mockFetch(jsonResponse({ detail: 'Email already registered' }, 409))

      await expect(
        register({ email: 'existing@example.com', password: 'password123' })
      ).rejects.toThrow('Email already registered')
    })
  })

  describe('registerDevice', () => {
    it('treats 409 as success (device already registered)', async () => {
      mockFetch(jsonResponse({ detail: 'already registered' }, 409))

      await expect(registerDevice('browser-1', 'token')).resolves.toBeUndefined()
    })
  })

  // F-SEC-1: there was no 401 handling anywhere.
  describe('401 interceptor', () => {
    beforeEach(() => {
      storeToken('stale-token')
    })

    it('drops the stored token and notifies subscribers', async () => {
      mockFetch(jsonResponse({ detail: 'Token expired' }, 401))

      const expired = vi.fn()
      const unsubscribe = onSessionExpired(expired)

      await expect(listDevices('stale-token')).rejects.toBeInstanceOf(UnauthorizedError)

      expect(expired).toHaveBeenCalledTimes(1)
      expect(readToken()).toBeNull()

      unsubscribe()
    })

    it('does not fire for non-401 failures', async () => {
      mockFetch(jsonResponse({ detail: 'Server error' }, 500))

      const expired = vi.fn()
      const unsubscribe = onSessionExpired(expired)

      await expect(listDevices('stale-token')).rejects.toThrow('Server error')

      expect(expired).not.toHaveBeenCalled()
      expect(readToken()).toBe('stale-token')

      unsubscribe()
    })
  })
})
