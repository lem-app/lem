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
import { REGISTER_CONTEXT, signedMessage } from './device-key'
import { onSessionExpired, storeToken, readToken } from '../lib/session'
import { memoryKeyStore } from '../test/fakes'

const CHALLENGE = 'Q0hBTExFTkdFLTAxMjM0NTY3ODlhYmNkZWZnaGlqa2w='

/** Parse a recorded request body, which our client always sends as a string. */
function requestBody(init: RequestInit | undefined): Record<string, string> {
  const body = init?.body
  if (typeof body !== 'string') {
    throw new Error('expected a JSON string body')
  }
  return JSON.parse(body) as Record<string, string>
}

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
    it('registers a real Ed25519 key and a signature, never "browser-key"', async () => {
      mockFetch(
        jsonResponse({ device_id: 'ignored', challenge: CHALLENGE, context: 'x', expires_in: 120 }),
        jsonResponse({ id: 'ignored', user_id: 1, pubkey: 'x', created_at: 'now' })
      )

      const deviceId = await registerDevice('token', memoryKeyStore())

      const [challengeUrl, challengeInit] = fetchMockCalls()[0]
      expect(challengeUrl).toBe('http://localhost:8000/devices/challenge')
      expect(requestBody(challengeInit)).toEqual({ device_id: deviceId })

      const [registerUrl, registerInit] = fetchMockCalls()[1]
      expect(registerUrl).toBe('http://localhost:8000/devices/register')
      const body = requestBody(registerInit)
      expect(body.device_id).toBe(deviceId)
      expect(body.pubkey).not.toBe('browser-key')
      expect(atob(body.pubkey)).toHaveLength(32)
      expect(body.challenge).toBe(CHALLENGE)
      expect(atob(body.signature)).toHaveLength(64)
    })

    it('signs the challenge verifiably under the key it registers', async () => {
      mockFetch(
        jsonResponse({ device_id: 'ignored', challenge: CHALLENGE, context: 'x', expires_in: 120 }),
        jsonResponse({ id: 'ignored', user_id: 1, pubkey: 'x', created_at: 'now' })
      )

      const deviceId = await registerDevice('token', memoryKeyStore())
      const body = requestBody(fetchMockCalls()[1][1])

      const publicKey = await crypto.subtle.importKey(
        'raw',
        Uint8Array.from(atob(body.pubkey), (c) => c.charCodeAt(0)),
        { name: 'Ed25519' },
        false,
        ['verify']
      )

      await expect(
        crypto.subtle.verify(
          'Ed25519',
          publicKey,
          Uint8Array.from(atob(body.signature), (c) => c.charCodeAt(0)),
          signedMessage(REGISTER_CONTEXT, deviceId, CHALLENGE)
        )
      ).resolves.toBe(true)
    })

    it('no longer swallows a 409, and does not swallow a 401', async () => {
      // A 401 here means the server has a different key on file for this
      // device. Treating that as success would be swallowing a hijack.
      mockFetch(
        jsonResponse({ device_id: 'ignored', challenge: CHALLENGE, context: 'x', expires_in: 120 }),
        jsonResponse({ detail: 'previous_signature required' }, 401)
      )

      await expect(registerDevice('token', memoryKeyStore())).rejects.toBeInstanceOf(
        UnauthorizedError
      )
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
