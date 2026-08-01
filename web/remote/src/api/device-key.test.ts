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
 * The browser's Ed25519 device identity, and the cross-language golden vector.
 *
 * The signaling server owns the format; this client must reproduce it exactly.
 * The pinned signature below was produced by the signaling server's own Python
 * code, not by this module, so a drift in either direction fails loudly here
 * rather than silently on the wire.
 *
 * The vector constants below are duplicated verbatim in:
 *
 * - `cloud/signaling/tests/test_signed_payload_vectors.py`
 * - `server/tests/test_signed_payload_vectors.py`
 *
 * The device id deliberately contains a non-ASCII character and an
 * astral-plane emoji. JavaScript strings are UTF-16 and Python's are code
 * points; only the UTF-8 encoding of a surrogate pair pins the two together,
 * and that is exactly where a cross-language signing bug hides - it verifies
 * in each language's own tests and fails across the wire.
 */

import { describe, it, expect } from 'vitest'
import {
  REGISTER_CONTEXT,
  ROTATE_CONTEXT,
  SIGNAL_CONTEXT,
  bytesToBase64,
  generateIdentity,
  getDeviceIdentity,
  signedMessage,
} from './device-key'
import { memoryKeyStore } from '../test/fakes'

// --- Shared vector inputs (keep identical across all three suites) -----------

const VECTOR_DEVICE_ID = 'device-café-\u{1F511}'
const VECTOR_CHALLENGE = 'Q0hBTExFTkdFLTAxMjM0NTY3ODlhYmNkZWZnaGlqa2w='

// Test-only key: the 32-byte seed 0x00..0x1f. Never use this anywhere real.
const VECTOR_SEED_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const VECTOR_PUBKEY_B64 = 'A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg='

// --- Expected outputs -------------------------------------------------------

const VECTOR_REGISTER_PAYLOAD_HEX =
  '6c656d2d6465766963652d72656769737465722d7631' +
  '3a' +
  '6465766963652d636166c3a92df09f9491' +
  '3a' +
  '5130684254457846546b64464c5441784d6a4d304e5459334f446c68596d4e6b5a575a6e61476c716132773d'

const VECTOR_REGISTER_SIGNATURE_B64 =
  'Lzv8ombVVJZLmnvIdQ1LcGJJfaljNrukmUjQDfzDewGnbhqwTHDI2MYOHMUypxG8CC1tv+uzulnLja17u4bRAA=='

const VECTOR_ROTATE_PAYLOAD_HEX =
  '6c656d2d6465766963652d726f746174652d7631' +
  '3a' +
  '6465766963652d636166c3a92df09f9491' +
  '3a' +
  '5130684254457846546b64464c5441784d6a4d304e5459334f446c68596d4e6b5a575a6e61476c716132773d' +
  '3a' +
  '41364548762f504f454c3464634e3059353076416d57666b316a436270513166486479475a424a564d62673d'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const out = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

/**
 * Import the fixed vector key, so signatures here are comparable with Python's.
 *
 * @returns A signing key for VECTOR_SEED_B64.
 */
async function importVectorKey(): Promise<CryptoKey> {
  const toBase64Url = (value: string): string =>
    value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'OKP',
      crv: 'Ed25519',
      d: toBase64Url(VECTOR_SEED_B64),
      x: toBase64Url(VECTOR_PUBKEY_B64),
      key_ops: ['sign'],
      ext: true,
    },
    { name: 'Ed25519' },
    false,
    ['sign']
  )
}

describe('signed payload golden vectors', () => {
  it('builds the registration payload byte-for-byte', () => {
    const payload = signedMessage(REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE)
    expect(toHex(payload)).toBe(VECTOR_REGISTER_PAYLOAD_HEX)
  })

  it('builds the rotation payload byte-for-byte', () => {
    const payload = signedMessage(
      ROTATE_CONTEXT,
      VECTOR_DEVICE_ID,
      VECTOR_CHALLENGE,
      VECTOR_PUBKEY_B64
    )
    expect(toHex(payload)).toBe(VECTOR_ROTATE_PAYLOAD_HEX)
  })

  it('produces the pinned signature, matching both Python implementations', async () => {
    const key = await importVectorKey()
    const signature = await crypto.subtle.sign(
      'Ed25519',
      key,
      signedMessage(REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE)
    )
    expect(bytesToBase64(new Uint8Array(signature))).toBe(VECTOR_REGISTER_SIGNATURE_B64)
  })

  it('verifies a signature produced by the Python implementations', async () => {
    // The literal signature below was produced by the signaling server's
    // Python code. If this browser's payload ever drifts, this fails.
    const publicKey = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(VECTOR_PUBKEY_B64),
      { name: 'Ed25519' },
      false,
      ['verify']
    )
    const valid = await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      base64ToBytes(VECTOR_REGISTER_SIGNATURE_B64),
      signedMessage(REGISTER_CONTEXT, VECTOR_DEVICE_ID, VECTOR_CHALLENGE)
    )
    expect(valid).toBe(true)
  })

  it('pins the protocol constants', () => {
    expect(REGISTER_CONTEXT).toBe('lem-device-register-v1')
    expect(SIGNAL_CONTEXT).toBe('lem-signaling-connect-v1')
    expect(ROTATE_CONTEXT).toBe('lem-device-rotate-v1')
  })
})

describe('signedMessage', () => {
  it('separates contexts', () => {
    expect(toHex(signedMessage(REGISTER_CONTEXT, 'd', 'c'))).not.toBe(
      toHex(signedMessage(SIGNAL_CONTEXT, 'd', 'c'))
    )
  })

  it('encodes fields as UTF-8, not UTF-16', () => {
    // 'é' is one UTF-16 unit but two UTF-8 bytes; the emoji is two UTF-16
    // units and four UTF-8 bytes. Python encodes six bytes here, so a naive
    // charCode-per-unit encoding would diverge on exactly this input.
    const payload = signedMessage(REGISTER_CONTEXT, 'é\u{1F511}')
    const contextBytes = new TextEncoder().encode(REGISTER_CONTEXT).length
    expect(payload.length - contextBytes - 1).toBe(6)
  })
})

describe('device identity', () => {
  it('generates a real 32-byte Ed25519 public key, never "browser-key"', async () => {
    const identity = await getDeviceIdentity(memoryKeyStore())

    expect(identity.publicKeyB64).not.toBe('browser-key')
    expect(base64ToBytes(identity.publicKeyB64)).toHaveLength(32)
    expect(identity.deviceId).toMatch(/^browser-[0-9a-f]{16}$/)
  })

  it('signs challenges verifiably under its own public key', async () => {
    const identity = await getDeviceIdentity(memoryKeyStore())
    const challenge = 'Y2hhbGxlbmdlLXZhbHVl'
    const signature = await identity.sign(REGISTER_CONTEXT, identity.deviceId, challenge)

    const publicKey = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(identity.publicKeyB64),
      { name: 'Ed25519' },
      false,
      ['verify']
    )

    await expect(
      crypto.subtle.verify(
        'Ed25519',
        publicKey,
        base64ToBytes(signature),
        signedMessage(REGISTER_CONTEXT, identity.deviceId, challenge)
      )
    ).resolves.toBe(true)
  })

  it('rejects a signature presented for a different device', async () => {
    const identity = await getDeviceIdentity(memoryKeyStore())
    const challenge = 'Y2hhbGxlbmdlLXZhbHVl'
    const signature = await identity.sign(REGISTER_CONTEXT, identity.deviceId, challenge)

    const publicKey = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(identity.publicKeyB64),
      { name: 'Ed25519' },
      false,
      ['verify']
    )

    await expect(
      crypto.subtle.verify(
        'Ed25519',
        publicKey,
        base64ToBytes(signature),
        signedMessage(REGISTER_CONTEXT, 'browser-ffffffffffffffff', challenge)
      )
    ).resolves.toBe(false)
  })

  it('rejects a signature over a tampered challenge', async () => {
    const identity = await getDeviceIdentity(memoryKeyStore())
    const signature = await identity.sign(
      REGISTER_CONTEXT,
      identity.deviceId,
      'Y2hhbGxlbmdlLXZhbHVl'
    )

    const publicKey = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(identity.publicKeyB64),
      { name: 'Ed25519' },
      false,
      ['verify']
    )

    await expect(
      crypto.subtle.verify(
        'Ed25519',
        publicKey,
        base64ToBytes(signature),
        signedMessage(REGISTER_CONTEXT, identity.deviceId, 'dGFtcGVyZWQtY2hhbGxlbmdl')
      )
    ).resolves.toBe(false)
  })

  it('rejects a signature made by a different key', async () => {
    const mine = await getDeviceIdentity(memoryKeyStore())
    const theirs = await getDeviceIdentity(memoryKeyStore())
    const challenge = 'Y2hhbGxlbmdlLXZhbHVl'
    const signature = await theirs.sign(REGISTER_CONTEXT, mine.deviceId, challenge)

    const publicKey = await crypto.subtle.importKey(
      'raw',
      base64ToBytes(mine.publicKeyB64),
      { name: 'Ed25519' },
      false,
      ['verify']
    )

    await expect(
      crypto.subtle.verify(
        'Ed25519',
        publicKey,
        base64ToBytes(signature),
        signedMessage(REGISTER_CONTEXT, mine.deviceId, challenge)
      )
    ).resolves.toBe(false)
  })

  it('keeps the same id and key across calls', async () => {
    const store = memoryKeyStore()
    const first = await getDeviceIdentity(store)
    const second = await getDeviceIdentity(store)

    expect(second.deviceId).toBe(first.deviceId)
    expect(second.publicKeyB64).toBe(first.publicKeyB64)
  })

  it('binds the id to the key, so a lost key means a new id', async () => {
    const first = await getDeviceIdentity(memoryKeyStore())
    const second = await getDeviceIdentity(memoryKeyStore())

    expect(second.deviceId).not.toBe(first.deviceId)
    expect(second.publicKeyB64).not.toBe(first.publicKeyB64)
  })

  it('never exposes the private key', async () => {
    const { keyPair } = await generateIdentity()

    expect(keyPair.privateKey.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('pkcs8', keyPair.privateKey)).rejects.toThrow()
  })
})
