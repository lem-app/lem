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
 * User-facing text for the reasons a service cannot be framed.
 */

import type { SwUnavailableReason } from './sw-bridge'

const MESSAGES: Record<SwUnavailableReason, string> = {
  'insecure-context':
    'Service Workers need a secure context. Serve the dashboard over HTTPS, or open it at http://localhost.',
  unsupported: 'This browser does not expose Service Workers (private windows often do not).',
  'registration-failed': 'The Lem service worker could not be registered in this browser.',
  timeout: 'The Lem service worker did not become ready in time. Reload the page to retry.',
}

/**
 * Explain why the same-origin proxy is unavailable, and what to do about it.
 *
 * Deliberately names the fix: "unavailable" on its own sends the user looking
 * for a Lem bug when the answer is usually the URL they typed.
 */
export function swUnavailableMessage(reason: SwUnavailableReason): string {
  return MESSAGES[reason]
}
