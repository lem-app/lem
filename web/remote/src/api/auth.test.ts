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
 * Tests for authentication API client.
 */

/// <reference types="vitest/globals" />

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { login, register } from './auth'

describe('Authentication API', () => {
  beforeEach(() => {
    // Mock fetch
    globalThis.fetch = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('login', () => {
    it('should return token on successful login', async () => {
      const mockToken = { access_token: 'test-token-123' }
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockToken,
      })

      const result = await login({ email: 'test@example.com', password: 'password123' })

      expect(result).toEqual(mockToken)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8000/auth/login',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
        })
      )
    })

    it('should throw error on failed login', async () => {
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ detail: 'Invalid credentials' }),
      })

      await expect(login({ email: 'test@example.com', password: 'wrong' })).rejects.toThrow(
        'Invalid credentials'
      )
    })

    it('should handle network errors', async () => {
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Network error')
      )

      await expect(login({ email: 'test@example.com', password: 'password123' })).rejects.toThrow(
        'Network error'
      )
    })
  })

  describe('register', () => {
    it('should return token on successful registration', async () => {
      const mockToken = { access_token: 'test-token-456' }
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockToken,
      })

      const result = await register({ email: 'new@example.com', password: 'password123' })

      expect(result).toEqual(mockToken)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8000/auth/register',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'new@example.com', password: 'password123' }),
        })
      )
    })

    it('should throw error on failed registration', async () => {
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        json: async () => ({ detail: 'Email already registered' }),
      })

      await expect(
        register({ email: 'existing@example.com', password: 'password123' })
      ).rejects.toThrow('Email already registered')
    })
  })
})
