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
  ProblemDetails,
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  LogoutResponse,
  AuthStatus,
  Service,
  Job,
  JobResponse,
} from './types'

// Use relative URLs - Vite dev server proxies /v1/* to the backend
// For production builds, set VITE_API_URL to the full backend URL
const API_BASE_URL = import.meta.env.VITE_API_URL || ''

// The server requires this custom header on every state-changing request.
// A browser cannot attach a custom header to a cross-origin request without a
// CORS preflight, so it proves the request came from a real Lem client rather
// than from a malicious page doing fetch(..., { mode: "no-cors" }).
const CLIENT_HEADER = 'X-Lem-Client'
const CLIENT_NAME = 'lem-dashboard'

// On a loopback bind the server accepts requests without a token. When the
// server is bound to the LAN (LEM_HOST), every /v1/* request needs the bearer
// token from ~/.lem/api_token - a browser cannot read that file, so it has to
// be handed to the dashboard at build/dev time via VITE_LEM_API_TOKEN.
const API_TOKEN: string = import.meta.env.VITE_LEM_API_TOKEN || "";

function authHeaders(): Record<string, string> {
  return API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};
}

class ApiError extends Error {
  status: number
  problemDetails?: ProblemDetails

  constructor(message: string, status: number, problemDetails?: ProblemDetails) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.problemDetails = problemDetails
  }
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API_BASE_URL}${path}`

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        [CLIENT_HEADER]: CLIENT_NAME,
        ...authHeaders(),
        ...options?.headers,
      },
    })

    if (!response.ok) {
      // Try to parse Problem+JSON error
      let problemDetails: ProblemDetails | undefined
      try {
        problemDetails = (await response.json()) as ProblemDetails
      } catch {
        // If not JSON, just use status text
      }

      throw new ApiError(
        problemDetails?.detail || response.statusText,
        response.status,
        problemDetails
      )
    }

    return (await response.json()) as T
  } catch (error) {
    if (error instanceof ApiError) {
      throw error
    }
    // Network or other errors
    throw new ApiError(error instanceof Error ? error.message : 'Unknown error', 0)
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

export { ApiError }
