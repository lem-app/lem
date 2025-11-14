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
  Runner,
  Client,
  Model,
  TunnelStatus,
  Health,
  StatusResponse,
  ModelPullRequest,
  ModelPullResponse,
  ProblemDetails,
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  LogoutResponse,
  AuthStatus,
} from './types';

const API_BASE_URL = 'http://127.0.0.1:5142';

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public problemDetails?: ProblemDetails
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchApi<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      // Try to parse Problem+JSON error
      let problemDetails: ProblemDetails | undefined;
      try {
        problemDetails = await response.json() as ProblemDetails;
      } catch {
        // If not JSON, just use status text
      }

      throw new ApiError(
        problemDetails?.detail || response.statusText,
        response.status,
        problemDetails
      );
    }

    return await response.json() as T;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // Network or other errors
    throw new ApiError(
      error instanceof Error ? error.message : 'Unknown error',
      0
    );
  }
}

// Health & System (§2)
export async function getHealth(): Promise<Health> {
  return fetchApi<Health>('/v1/health');
}

// Runners (§3)
export async function getRunners(): Promise<Runner[]> {
  return fetchApi<Runner[]>('/v1/runners');
}

export async function installRunner(runnerId: string): Promise<StatusResponse> {
  return fetchApi<StatusResponse>(`/v1/runners/${runnerId}/install`, {
    method: 'POST',
  });
}

export async function startRunner(runnerId: string): Promise<StatusResponse> {
  return fetchApi<StatusResponse>(`/v1/runners/${runnerId}/start`, {
    method: 'POST',
  });
}

export async function stopRunner(runnerId: string): Promise<StatusResponse> {
  return fetchApi<StatusResponse>(`/v1/runners/${runnerId}/stop`, {
    method: 'POST',
  });
}

export async function getRunnerModels(runnerId: string): Promise<Model[]> {
  return fetchApi<Model[]>(`/v1/runners/${runnerId}/models`);
}

export async function pullModel(
  runnerId: string,
  request: ModelPullRequest
): Promise<ModelPullResponse> {
  return fetchApi<ModelPullResponse>(`/v1/runners/${runnerId}/models/pull`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// Clients (§4)
export async function getClients(): Promise<Client[]> {
  return fetchApi<Client[]>('/v1/clients');
}

export async function installClient(clientId: string): Promise<StatusResponse> {
  return fetchApi<StatusResponse>(`/v1/clients/${clientId}/install`, {
    method: 'POST',
  });
}

export async function startClient(clientId: string): Promise<StatusResponse> {
  return fetchApi<StatusResponse>(`/v1/clients/${clientId}/start`, {
    method: 'POST',
  });
}

export async function stopClient(clientId: string): Promise<StatusResponse> {
  return fetchApi<StatusResponse>(`/v1/clients/${clientId}/stop`, {
    method: 'POST',
  });
}

// Tunnel (§6)
export async function getTunnelStatus(): Promise<TunnelStatus> {
  return fetchApi<TunnelStatus>('/v1/tunnel/status');
}

export async function enableTunnel(): Promise<StatusResponse> {
  return fetchApi<StatusResponse>('/v1/tunnel/enable', {
    method: 'POST',
  });
}

export async function disableTunnel(): Promise<StatusResponse> {
  return fetchApi<StatusResponse>('/v1/tunnel/disable', {
    method: 'POST',
  });
}

// Auth (§6.5)
export async function register(request: RegisterRequest): Promise<AuthResponse> {
  return fetchApi<AuthResponse>('/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function login(request: LoginRequest): Promise<AuthResponse> {
  return fetchApi<AuthResponse>('/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export async function logout(): Promise<LogoutResponse> {
  return fetchApi<LogoutResponse>('/v1/auth/logout', {
    method: 'POST',
  });
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return fetchApi<AuthStatus>('/v1/auth/status');
}

export { ApiError };
