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

// API types for Lem Local Server v1
// Based on docs/api.md

// Runner types (§3)
export type RunnerStatus = 'running' | 'stopped' | 'error';

export interface Runner {
  id: string;
  name: string;
  status: RunnerStatus;
  capabilities: string[];
  endpoint: string;
  harbor_service: string;
  version: string;
}

// Client types (§4)
export type ClientStatus = 'running' | 'stopped' | 'error';

export interface Client {
  id: string;
  name: string;
  status: ClientStatus;
  url: string;
  binds_to_runner: string;
  harbor_service: string;
  version: string;
}

// Model types (§3.4)
export type ModelStatus = 'ready' | 'pulling' | 'stopped' | 'error';

export interface Model {
  id: string;
  name: string;
  tag?: string;
  status: ModelStatus;
  modality: string[];
}

export interface ModelPullRequest {
  model_ref: string;
}

export interface ModelPullResponse {
  id: string;
  status: ModelStatus;
}

// Tunnel types (§6)
export type TunnelMode = 'webrtc' | 'turn' | 'relay-ws' | 'offline' | 'connecting' | 'connected' | 'failed';

export interface TunnelStatus {
  mode: TunnelMode;
  authenticated?: boolean;
  device_id?: string;
  connection_state?: string;
  data_channel_state?: string;
  last_error?: string | null;
}

// Auth types (§6.5)
export interface RegisterRequest {
  email: string;
  password: string;
  signaling_url: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  signaling_url: string;
}

export interface AuthResponse {
  status: string;
  device_id: string;
  tunnel_status: string;
}

export interface LogoutResponse {
  status: string;
  tunnel_status: string;
}

export interface AuthStatus {
  authenticated: boolean;
  email?: string;
  device_id?: string;
  tunnel_status: string;
}

// Health types (§2.1)
export interface Health {
  status: 'ok' | 'degraded' | 'error';
  components: {
    docker: string;
    runners: Record<string, RunnerStatus>;
    clients: Record<string, ClientStatus>;
    tunnel: TunnelMode;
  };
}

// System types (§2.2)
export interface System {
  machine_id: string;
  version: string;
  device_pubkey: string;
  platform: {
    os: string;
    arch: string;
  };
  harbor: {
    version: string;
    cli_path: string;
  };
}

// Standard response types
export interface StatusResponse {
  status: 'ok';
}

// Error types (§10)
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  harbor_stderr?: string;
}
