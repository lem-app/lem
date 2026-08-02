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
 * Token custody, expiry checking and the 401 interceptor all live in
 * `lib/session.ts`. The token is held in a module-scoped variable and is **not
 * persisted anywhere**, because the framed app at `/app/<deviceId>/<serviceId>/`
 * shares this origin and can read any store the dashboard writes (tunnel proxy
 * spec §8.4). The consequence is visible right here: `initialState()` finds no
 * token after a reload, so a reload is a logout.
 *
 * ## This hook deliberately does not return the token
 *
 * It returns `isAuthenticated`, a boolean, and nothing that a component could
 * put in props or state. That is not tidiness - it is the second half of the
 * §8.4 requirement, and it was missing until
 * [#82](https://github.com/lem-app/lem/issues/82).
 *
 * React stores hook state and props on fiber nodes, and attaches those fibers
 * to DOM elements as `__reactFiber$…` expandos. A token returned from here
 * therefore ends up in the DOM subtree that hosts the framed service's iframe,
 * where same-origin code reads it through `parent.document`. Taking it out of
 * `localStorage` and putting it in the render tree would have moved the
 * exposure, not removed it.
 *
 * Code that genuinely needs the value calls `readToken()` at the point of use,
 * so it lives on the stack for the duration of a call and in module scope the
 * rest of the time - neither of which a fiber walk can reach.
 * `lib/fiber-reachability.test.tsx` asserts this.
 */

import { useState, useCallback, useEffect } from 'react'
import { login as apiLogin, register as apiRegister } from '../api/auth'
import { clearToken, onSessionExpired, readToken, storeToken } from '../lib/session'
import type { UserLogin, UserRegister, Token } from '../api/types'

interface AuthState {
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
}

function initialState(): AuthState {
  // Always false on a fresh realm - see the module comment. readToken() also
  // drops a token whose `exp` claim has passed, so a stale session never
  // renders a signed-in dashboard whose every call 401s.
  return {
    isAuthenticated: readToken() !== null,
    isLoading: false,
    error: null,
  }
}

export function useAuth() {
  const [state, setState] = useState<AuthState>(initialState)

  const logout = useCallback(() => {
    clearToken()
    setState({
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
          isAuthenticated: false,
          isLoading: false,
          error: 'Your session has expired. Please sign in again.',
        })
      }),
    []
  )

  // Returns void, not the `Token`: handing the credential back to a component
  // is how it gets into props and state, which is the exposure this hook exists
  // to avoid. Callers that need the value call `readToken()`.
  const authenticate = useCallback(
    async (run: () => Promise<Token>, fallbackError: string): Promise<void> => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }))

      try {
        const response = await run()
        storeToken(response.access_token)

        setState({
          isAuthenticated: true,
          isLoading: false,
          error: null,
        })
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
