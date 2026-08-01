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
 * Authentication client for the signaling server.
 *
 * Every response goes through {@link request}, which turns a 401 into a session
 * expiry: the stored JWT is dropped and subscribers (the `useAuth` hook) send
 * the user back to the login screen. Without this a stale token produced a
 * dashboard that looked signed in and failed every call.
 */

import type { Token, UserLogin, UserRegister, Device } from './types'
import { config } from '../lib/env'
import { expireSession } from '../lib/session'

/** Thrown when the signaling server rejects our credentials. */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

interface ErrorBody {
  detail?: unknown
}

function apiBaseUrl(): string {
  if (!config) {
    throw new Error('Application configuration is invalid; see the startup error for details.')
  }
  return config.apiBaseUrl
}

async function readErrorDetail(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as ErrorBody
    return typeof body.detail === 'string' && body.detail.length > 0 ? body.detail : fallback
  } catch {
    return fallback
  }
}

/**
 * Perform a request against the signaling server.
 *
 * @param acceptStatuses Extra non-OK statuses treated as success (e.g. 409 for
 *   "device already registered").
 */
async function request(
  path: string,
  init: RequestInit,
  fallbackError: string,
  acceptStatuses: readonly number[] = []
): Promise<Response> {
  const response = await fetch(`${apiBaseUrl()}${path}`, init)

  if (response.ok || acceptStatuses.includes(response.status)) {
    return response
  }

  const detail = await readErrorDetail(response, fallbackError)

  if (response.status === 401) {
    // 401 interceptor: the session token is no longer good for anything.
    expireSession()
    throw new UnauthorizedError(detail)
  }

  throw new Error(detail)
}

/**
 * Login with email and password.
 */
export async function login(credentials: UserLogin): Promise<Token> {
  const response = await request(
    '/auth/login',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    },
    'Login failed'
  )

  return (await response.json()) as Token
}

/**
 * Register a new user.
 */
export async function register(userData: UserRegister): Promise<Token> {
  const response = await request(
    '/auth/register',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userData),
    },
    'Registration failed'
  )

  return (await response.json()) as Token
}

/**
 * Register a device with the signaling server.
 */
export async function registerDevice(
  deviceId: string,
  token: string,
  pubkey = 'browser-key'
): Promise<void> {
  await request(
    '/devices/register',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ device_id: deviceId, pubkey }),
    },
    'Device registration failed',
    // 409 means the device is already registered, which is fine.
    [409]
  )
}

/**
 * List all devices for the current user.
 */
export async function listDevices(token: string): Promise<Device[]> {
  const response = await request(
    '/devices/',
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    },
    'Failed to fetch devices'
  )

  return (await response.json()) as Device[]
}
