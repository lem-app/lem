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

// API client for Lem Local Server
// Based on docs/api.md §0.1 (v0.1 API surface)

import type {
  Model,
  TunnelStatus,
  StatusResponse,
  ModelPullRequest,
  ModelPullResponse,
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  LogoutResponse,
  AuthStatus,
  Service,
  Job,
  JobResponse,
} from './types'

// The bearer token is NOT compiled in. The dashboard has no credential until
// the operator supplies one at runtime; see api/session.ts for why a build-time
// `VITE_*` variable is not an option and what replaces it.
import { API_BASE_URL, ApiError, CLIENT_HEADER, CLIENT_NAME, toApiError } from './http'
import { clearSessionTokenIfCurrent, readSessionToken, requestCredential } from './session'

/**
 * Issue one request, attaching the given credential if there is one.
 *
 * @param path - API path beginning with /v1
 * @param options - fetch options from the caller
 * @param token - Session token to present, or null to send none
 * @returns The parsed response body
 * @throws ApiError on any non-2xx response or network failure
 */
async function sendRequest<T>(
  path: string,
  options: RequestInit | undefined,
  token: string | null
): Promise<T> {
  const auth: Record<string, string> = token === null ? {} : { Authorization: `Bearer ${token}` }

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: CLIENT_NAME,
        ...auth,
        ...options?.headers,
      },
    })
  } catch (error) {
    // Network or other pre-response failure.
    throw new ApiError(error instanceof Error ? error.message : 'Unknown error', 0)
  }

  if (!response.ok) {
    throw await toApiError(response)
  }

  return (await response.json()) as T
}

/**
 * Call the local API, prompting for a credential if the server demands one.
 *
 * A 401 is not a dead end here: it raises the credential prompt (once, however
 * many requests are in flight) and the original request is then retried, so the
 * operator lands back where they were rather than on an empty dashboard.
 *
 * @param path - API path beginning with /v1
 * @param options - fetch options
 * @returns The parsed response body
 * @throws ApiError if the request fails for any other reason, or if the
 *   operator declines to supply a credential
 */
async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const tokenUsed = readSessionToken()

  try {
    return await sendRequest<T>(path, options, tokenUsed)
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) {
      throw error
    }

    // A 401 on a request that already carried a session token means that
    // session is gone - expired, revoked, or invalidated by a server restart
    // (sessions live in the server's memory only). Drop it before prompting so
    // the retry cannot present the same dead credential again.
    if (tokenUsed !== null) {
      clearSessionTokenIfCurrent(tokenUsed)
    }

    const token = await requestCredential(tokenUsed)
    if (token === null) {
      throw error
    }

    // Exactly one retry. If a freshly minted credential is refused too, that is
    // a real 401 and the caller has to see it rather than loop on the prompt.
    return await sendRequest<T>(path, options, token)
  }
}

// Runners (§3)
export async function getRunnerModels(runnerId: string): Promise<Model[]> {
  return fetchApi<Model[]>(`/v1/runners/${runnerId}/models`)
}

export async function pullModel(
  runnerId: string,
  request: ModelPullRequest
): Promise<ModelPullResponse> {
  return fetchApi<ModelPullResponse>(`/v1/runners/${runnerId}/models/pull`, {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

// Tunnel (§6)
export async function getTunnelStatus(): Promise<TunnelStatus> {
  return fetchApi<TunnelStatus>('/v1/tunnel/status')
}

// Not called from the UI yet, but the endpoints exist and the remote-access
// panel is the obvious next consumer - keeping them saves re-deriving the shape.
export async function enableTunnel(): Promise<StatusResponse> {
  return fetchApi<StatusResponse>('/v1/tunnel/enable', {
    method: 'POST',
  })
}

export async function disableTunnel(): Promise<StatusResponse> {
  return fetchApi<StatusResponse>('/v1/tunnel/disable', {
    method: 'POST',
  })
}

// Auth (§6.5)
export async function register(request: RegisterRequest): Promise<AuthResponse> {
  return fetchApi<AuthResponse>('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export async function login(request: LoginRequest): Promise<AuthResponse> {
  return fetchApi<AuthResponse>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export async function logout(): Promise<LogoutResponse> {
  return fetchApi<LogoutResponse>('/v1/auth/logout', {
    method: 'POST',
  })
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return fetchApi<AuthStatus>('/v1/auth/status')
}

// Services (Catalog)
export async function getServices(): Promise<Service[]> {
  return fetchApi<Service[]>('/v1/services')
}

export async function installService(serviceId: string): Promise<JobResponse> {
  return fetchApi<JobResponse>(`/v1/services/${serviceId}/install`, {
    method: 'POST',
  })
}

export async function startService(serviceId: string): Promise<StatusResponse> {
  return fetchApi<StatusResponse>(`/v1/services/${serviceId}/start`, {
    method: 'POST',
  })
}

export async function stopService(serviceId: string): Promise<StatusResponse> {
  return fetchApi<StatusResponse>(`/v1/services/${serviceId}/stop`, {
    method: 'POST',
  })
}

export async function removeService(serviceId: string): Promise<JobResponse> {
  return fetchApi<JobResponse>(`/v1/services/${serviceId}/remove`, {
    method: 'POST',
  })
}

// Jobs
export async function getJobs(serviceId?: string): Promise<Job[]> {
  const params = serviceId ? `?service_id=${serviceId}` : ''
  return fetchApi<Job[]>(`/v1/jobs${params}`)
}

export async function getJob(jobId: string): Promise<Job> {
  return fetchApi<Job>(`/v1/jobs/${jobId}`)
}

// Re-exported so existing imports of `ApiError` from this module keep working
// now that the class lives in ./http (shared with the credential exchange).
export { ApiError }
