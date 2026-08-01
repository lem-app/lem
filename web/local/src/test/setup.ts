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
 * Vitest DOM harness.
 *
 * jsdom was already a dependency but nothing wired it up, so component tests
 * were impossible. This adds jest-dom matchers and unmounts React trees between
 * tests so one test's timers and effects cannot bleed into the next.
 */

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// jsdom does not implement ResizeObserver, and several Radix primitives (the
// ones shadcn/ui is built on) construct one in a layout effect - so a component
// using them throws on mount with "ResizeObserver is not defined" rather than
// failing an assertion. A no-op is the right stub: nothing under test asserts
// on measured sizes, and jsdom has no layout to measure anyway.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

afterEach(() => {
  cleanup()
})
