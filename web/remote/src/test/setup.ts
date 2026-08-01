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

// jsdom's Blob does not implement arrayBuffer(); browsers have since 2020.
// (Its Blob is also not readable by undici's Response, so FileReader it is.)
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        resolve(reader.result as ArrayBuffer)
      }
      reader.onerror = () => {
        reject(reader.error ?? new Error('Failed to read Blob'))
      }
      reader.readAsArrayBuffer(this)
    })
  }
}

afterEach(() => {
  cleanup()
})
