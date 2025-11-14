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
 * Authentication client for signaling server.
 */

import type { Token, UserLogin, UserRegister, Device } from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

/**
 * Login with email and password.
 */
export async function login(credentials: UserLogin): Promise<Token> {
  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(credentials),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Login failed' }))
    throw new Error(error.detail || 'Login failed')
  }

  return (await response.json()) as Token
}

/**
 * Register a new user.
 */
export async function register(userData: UserRegister): Promise<Token> {
  const response = await fetch(`${API_BASE_URL}/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(userData),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Registration failed' }))
    throw new Error(error.detail || 'Registration failed')
  }

  return (await response.json()) as Token
}

/**
 * Register a device with the signaling server.
 */
export async function registerDevice(
  deviceId: string,
  token: string,
  pubkey: string = 'browser-key'
): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/devices/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      device_id: deviceId,
      pubkey,
    }),
  })

  if (!response.ok && response.status !== 409) {
    // 409 means device already registered, which is fine
    const error = await response.json().catch(() => ({ detail: 'Device registration failed' }))
    throw new Error(error.detail || 'Device registration failed')
  }
}

/**
 * List all devices for the current user.
 */
export async function listDevices(token: string): Promise<Device[]> {
  const response = await fetch(`${API_BASE_URL}/devices/`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Failed to fetch devices' }))
    throw new Error(error.detail || 'Failed to fetch devices')
  }

  return (await response.json()) as Device[]
}
