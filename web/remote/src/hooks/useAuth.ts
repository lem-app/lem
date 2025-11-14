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
 */

import { useState, useCallback } from 'react'
import { login as apiLogin, register as apiRegister } from '../api/auth'
import type { UserLogin, UserRegister } from '../api/types'

interface AuthState {
  token: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    token: localStorage.getItem('token'),
    isAuthenticated: !!localStorage.getItem('token'),
    isLoading: false,
    error: null,
  })

  const login = useCallback(async (credentials: UserLogin) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiLogin(credentials)
      localStorage.setItem('token', response.access_token)

      setState({
        token: response.access_token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })

      return response
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
      throw error
    }
  }, [])

  const register = useCallback(async (userData: UserRegister) => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }))

    try {
      const response = await apiRegister(userData)
      localStorage.setItem('token', response.access_token)

      setState({
        token: response.access_token,
        isAuthenticated: true,
        isLoading: false,
        error: null,
      })

      return response
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed'
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: message,
      }))
      throw error
    }
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem('token')
    setState({
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    })
  }, [])

  return {
    ...state,
    login,
    register,
    logout,
  }
}
