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
 * Session storage and prompt coordination, at unit level.
 *
 * CredentialPrompt.test.tsx covers the end-to-end flow; these cover the
 * interleavings that concurrent requests can produce and that a UI test cannot
 * reach deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  SESSION_STORAGE_KEY,
  clearSessionToken,
  clearSessionTokenIfCurrent,
  endSession,
  readSessionToken,
  requestCredential,
  resetCredentialState,
  resolveCredentialRequest,
  storeSessionToken,
  subscribeToCredentialPrompt,
} from './session'

describe('session storage', () => {
  beforeEach(() => {
    resetCredentialState()
    window.sessionStorage.clear()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults to sessionStorage', () => {
    storeSessionToken('abc', false)

    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe('abc')
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(readSessionToken()).toBe('abc')
  })

  it('uses localStorage only with the opt-in', () => {
    storeSessionToken('abc', true)

    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBe('abc')
    expect(window.sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(readSessionToken()).toBe('abc')
  })

  it('leaves no stale copy behind when the opt-in changes', () => {
    storeSessionToken('remembered', true)
    storeSessionToken('tab-only', false)

    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(readSessionToken()).toBe('tab-only')
  })

  it('clears both storages', () => {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, 'a')
    window.localStorage.setItem(SESSION_STORAGE_KEY, 'b')

    clearSessionToken()

    expect(readSessionToken()).toBeNull()
  })

  // Two requests can fail on the same dead token. The second must not wipe the
  // replacement the first one just obtained.
  it('does not clear a token that has already been replaced', () => {
    storeSessionToken('fresh', false)

    clearSessionTokenIfCurrent('dead')

    expect(readSessionToken()).toBe('fresh')
  })

  it('clears the token when it is still the current one', () => {
    storeSessionToken('dead', false)

    clearSessionTokenIfCurrent('dead')

    expect(readSessionToken()).toBeNull()
  })

  it('revokes server-side and forgets locally on sign-out', async () => {
    storeSessionToken('to-revoke', false)
    const fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 204 } as Response))
    vi.stubGlobal('fetch', fetchMock)

    await endSession()

    expect(readSessionToken()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('DELETE')
  })

  it('does not call the server when there is nothing to revoke', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await endSession()

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('credential prompt coordination', () => {
  beforeEach(() => {
    resetCredentialState()
    window.sessionStorage.clear()
    window.localStorage.clear()
  })

  it('resolves null when no prompt is mounted, rather than hanging', async () => {
    await expect(requestCredential(null)).resolves.toBeNull()
  })

  // A request that 401s late, after another one has already re-authenticated,
  // must pick up the new token instead of raising a second prompt.
  it('returns an already-refreshed token without prompting', async () => {
    const open = vi.fn()
    subscribeToCredentialPrompt(open)
    storeSessionToken('refreshed', false)

    await expect(requestCredential('stale')).resolves.toBe('refreshed')
    expect(open).not.toHaveBeenCalled()
  })

  it('prompts again when the refreshed token is the same dead one', async () => {
    const open = vi.fn()
    subscribeToCredentialPrompt(open)
    storeSessionToken('stale', false)

    const pending = requestCredential('stale')
    expect(open).toHaveBeenCalledTimes(1)

    resolveCredentialRequest('new-token')
    await expect(pending).resolves.toBe('new-token')
  })

  it('opens one prompt for many waiters and settles them all together', async () => {
    const open = vi.fn()
    subscribeToCredentialPrompt(open)

    const pending = [requestCredential(null), requestCredential(null), requestCredential(null)]
    expect(open).toHaveBeenCalledTimes(1)

    resolveCredentialRequest('shared-token')

    await expect(Promise.all(pending)).resolves.toEqual([
      'shared-token',
      'shared-token',
      'shared-token',
    ])
  })

  it('can prompt again after a cancelled round', async () => {
    const open = vi.fn()
    subscribeToCredentialPrompt(open)

    const first = requestCredential(null)
    resolveCredentialRequest(null)
    await expect(first).resolves.toBeNull()

    const second = requestCredential(null)
    expect(open).toHaveBeenCalledTimes(2)
    resolveCredentialRequest('token')
    await expect(second).resolves.toBe('token')
  })

  it('stops prompting once the subscriber unmounts', async () => {
    const open = vi.fn()
    const unsubscribe = subscribeToCredentialPrompt(open)
    unsubscribe()

    await expect(requestCredential(null)).resolves.toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})
