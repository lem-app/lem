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

// Shared HTTP plumbing for the Lem local API.
//
// Extracted from client.ts so that session.ts (the credential exchange) can
// reuse it without the two modules importing each other in a cycle.

import type { ProblemDetails } from './types'

// Use relative URLs - Vite dev server proxies /v1/* to the backend.
// For production builds, set VITE_API_URL to the full backend URL.
//
// Note what is NOT here: a VITE_* variable holding a credential. Vite inlines
// those as plaintext string literals into dist/assets/*.js, so a token put here
// would ship to every browser that can load the page - which is exactly the LAN
// population the token exists to keep out of Docker. The credential arrives at
// runtime instead; see session.ts.
export const API_BASE_URL: string = import.meta.env.VITE_API_URL || ''

// The server requires this custom header on every state-changing request.
// A browser cannot attach a custom header to a cross-origin request without a
// CORS preflight, so it proves the request came from a real Lem client rather
// than from a malicious page doing fetch(..., { mode: "no-cors" }).
export const CLIENT_HEADER = 'X-Lem-Client'
export const CLIENT_NAME = 'lem-dashboard'

export class ApiError extends Error {
  status: number
  problemDetails?: ProblemDetails

  constructor(message: string, status: number, problemDetails?: ProblemDetails) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.problemDetails = problemDetails
  }
}

/**
 * Turn a non-2xx response into an ApiError, parsing Problem+JSON when present.
 *
 * @param response - The failed response
 * @returns An ApiError carrying the status and any problem details
 */
export async function toApiError(response: Response): Promise<ApiError> {
  let problemDetails: ProblemDetails | undefined
  try {
    problemDetails = (await response.json()) as ProblemDetails
  } catch {
    // Not JSON - fall back to the status text.
  }
  return new ApiError(
    problemDetails?.detail || response.statusText,
    response.status,
    problemDetails
  )
}
