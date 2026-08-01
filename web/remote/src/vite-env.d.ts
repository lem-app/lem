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

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Signaling server HTTP base URL, e.g. `https://signal.lem.gg`. */
  readonly VITE_API_BASE_URL?: string
  /** Signaling server WebSocket URL, e.g. `wss://signal.lem.gg/signal`. */
  readonly VITE_SIGNAL_URL?: string
  /** Relay server WebSocket base URL, e.g. `wss://relay.lem.gg`. */
  readonly VITE_RELAY_URL?: string
  /**
   * Local Lem server as addressed from the far side of the tunnel.
   * Defaults to `http://localhost:5142`.
   */
  readonly VITE_LOCAL_API_URL?: string
  /**
   * Opt-in STUN/TURN servers, comma-separated (e.g.
   * `stun:stun.example.org:3478,turns:turn.example.org:5349`).
   * Empty by default: Lem does not talk to third-party STUN servers unasked.
   */
  readonly VITE_ICE_SERVERS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
