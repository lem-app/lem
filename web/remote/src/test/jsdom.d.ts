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
 * The one thing the test suite imports from `jsdom`, declared locally.
 *
 * `jsdom` ships no type declarations. It does re-export tough-cookie's
 * `CookieJar` - the very implementation it drives `document.cookie` with -
 * which is what the `Set-Cookie` re-scoping tests use to answer "would the
 * browser attach this cookie to *that* request?" without inventing a matcher.
 *
 * Declared here rather than pulling in `@types/jsdom` so the surface the tests
 * depend on is exactly the surface that is written down.
 */
declare module 'jsdom' {
  export class CookieJar {
    setCookieSync(cookie: string, currentUrl: string): unknown
    getCookieStringSync(currentUrl: string): string
  }
}
