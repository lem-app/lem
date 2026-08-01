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

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Schemes an `<a href>` built from server data may use. */
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Validate a URL that came from the local server before putting it in an
 * `href`. Service endpoints are server-supplied strings; rendering one
 * unchecked makes `javascript:` (and `data:`) a one-click XSS.
 *
 * @returns the normalised URL, or `null` when it must not be linked.
 */
export function safeExternalHref(raw: string | null | undefined): string | null {
  if (!raw) return null

  try {
    const parsed = new URL(raw)
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : null
  } catch {
    return null
  }
}
