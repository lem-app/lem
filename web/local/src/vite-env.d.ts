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

// Declaring the variables we actually read gives them a real type. Without
// this they resolve through `vite/client`'s `[key: string]: any` index
// signature, and every value derived from one is implicitly `any`.
interface ImportMetaEnv {
  /** Backend base URL for production builds. Empty means "use relative URLs". */
  readonly VITE_API_URL?: string
  /** Default signaling server offered in the Remote Access panel. */
  readonly VITE_DEFAULT_SIGNALING_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
