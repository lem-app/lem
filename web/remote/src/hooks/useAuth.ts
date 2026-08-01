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
 * Authentication hook for managing login state.
 *
 * Token persistence, expiry checking and the 401 interceptor all live in
 * `lib/session.ts` - see the comment there for why the token is in
 * `localStorage` and what that does and does not buy us.
 */

import { useState, useCallback, useEffect } from 'react'
import { login as apiLogin, register as apiRegister } from '../api/auth'
import { clearToken, onSessionExpired, readToken, storeToken } from '../lib/session'
import type { UserLogin, UserRegister, Token } from '../api/types'

interface AuthState {
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
}

function initialState(): AuthState {
  // readToken() drops the token if its `exp` claim has passed, so a stale
  // session no longer renders a signed-in dashboard whose every call 401s.
  const token = readToken()
  return {
    token,
    isAuthenticated: token !== null,
    isLoading: false,
    error: null,
  }
}

export function useAuth() {
  const [state, setState] = useState<AuthState>(initialState)

  const logout = useCallback(() => {
    clearToken()
    setState({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    })
  }, [])

  // The 401 interceptor in `api/auth.ts` broadcasts here.
  useEffect(
    () =>
      onSessionExpired(() => {
        setState({
          token: null,
          isAuthenticated: false,
          isLoading: false,
          error: 'Your session has expired. Please sign in again.',
        })
      }),
    []
  )

  const authenticate = useCallback(
    async (run: () => Promise<Token>, fallbackError: string): Promise<Token> => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }))

      try {
        const response = await run()
        storeToken(response.access_token)

        setState({
          token: response.access_token,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        })

        return response
      } catch (error) {
        const message = error instanceof Error ? error.message : fallbackError
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: message,
        }))
        throw error
      }
    },
    []
  )

  const login = useCallback(
    (credentials: UserLogin) => authenticate(() => apiLogin(credentials), 'Login failed'),
    [authenticate]
  )

  const register = useCallback(
    (userData: UserRegister) => authenticate(() => apiRegister(userData), 'Registration failed'),
    [authenticate]
  )

  return {
    ...state,
    login,
    register,
    logout,
  }
}
