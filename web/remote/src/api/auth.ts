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

import type { Token, UserLogin, UserRegister, Device, DeviceChallenge } from './types'
import { config } from '../lib/env'
import { expireSession } from '../lib/session'
import { REGISTER_CONTEXT, getDeviceIdentity, type DeviceKeyStore } from './device-key'

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
 * Ask the signaling server for a single-use registration challenge.
 *
 * @param deviceId Device the challenge is for.
 * @param token Account JWT.
 * @returns The issued challenge.
 */
export async function requestDeviceChallenge(
  deviceId: string,
  token: string
): Promise<DeviceChallenge> {
  const response = await request(
    '/devices/challenge',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ device_id: deviceId }),
    },
    'Could not obtain a device challenge'
  )

  return (await response.json()) as DeviceChallenge
}

/**
 * Register this browser's device key with the signaling server.
 *
 * The browser used to register the literal string `'browser-key'` and prove
 * nothing. It now signs a server-issued challenge with the private half of the
 * key it is registering, so the stored key means something.
 *
 * Note there is no 409 tolerance any more. Re-registering is a normal 200 when
 * the key is unchanged, and a 401 when it is not - which means the signaling
 * server has a different key on file for this id and the caller cannot prove
 * possession of it. Swallowing that would be swallowing a hijack attempt.
 *
 * @param token Account JWT.
 * @param store Key store to use; defaults to IndexedDB. Tests pass a fake.
 * @returns The device id that was registered.
 */
export async function registerDevice(token: string, store?: DeviceKeyStore): Promise<string> {
  const identity = await getDeviceIdentity(store)
  const { challenge } = await requestDeviceChallenge(identity.deviceId, token)

  await request(
    '/devices/register',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        device_id: identity.deviceId,
        pubkey: identity.publicKeyB64,
        challenge,
        signature: await identity.sign(REGISTER_CONTEXT, identity.deviceId, challenge),
      }),
    },
    'Device registration failed'
  )

  return identity.deviceId
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
