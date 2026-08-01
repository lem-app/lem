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
 * This browser's Ed25519 device identity.
 *
 * Every browser used to register the literal string `'browser-key'` as its
 * public key. The signaling server stored it and never checked it, so "device
 * authentication" was really just the account JWT: anyone holding a token was
 * every one of that account's devices.
 *
 * This module gives the browser a real keypair and answers the challenges the
 * signaling server issues, at device registration and at signaling connect.
 *
 * Signed payload layout
 * ---------------------
 * The signaling server owns this format - `cloud/signaling/app/core/crypto.py`
 * is the definition, and this must reproduce it exactly:
 *
 * ```
 * context ":" field_0 ":" field_1 [":" field_2 ...]
 * ```
 *
 * with every field UTF-8 encoded. For registration and signaling connect the
 * fields are `(deviceId, challenge)`.
 *
 * Nothing is JSON-encoded, on purpose: `JSON.stringify` and Python's
 * `json.dumps` do not agree at their defaults, and a signature over a
 * differently-encoded payload fails only on the wire - never in either
 * language's own test suite. `device-key.test.ts` pins the exact bytes against
 * a vector the two Python suites also assert.
 *
 * Note the fields after `deviceId` are all base64 of a fixed 32 bytes, so they
 * are 44 characters long and contain no `:`. That is what keeps the separator
 * unambiguous; a variable-length trailing field would need length prefixes.
 *
 * Key storage
 * -----------
 * The private key is generated non-extractable and kept in IndexedDB as a
 * `CryptoKey`. It is therefore usable for signing but cannot be read out of
 * the browser, not even by script running on this origin - so an XSS bug can
 * borrow this device's identity while the page is open, but cannot walk away
 * with it. Storing an extractable key in `localStorage` would have been much
 * simpler and would have handed the whole identity to the first XSS.
 *
 * No software fallback
 * --------------------
 * If WebCrypto Ed25519 is unavailable, registration fails with a clear error.
 * There is deliberately no fallback: shipping a JS implementation would put
 * raw key material back in reachable memory, and "allow through when crypto is
 * unavailable" is exactly the always-open bypass this work exists to remove.
 * Ed25519 is available in Chrome 137+, Firefox 129+ and Safari 17+.
 */

/** Domain separation for a device registration proof. */
export const REGISTER_CONTEXT = 'lem-device-register-v1'

/** Domain separation for a signaling connect proof. */
export const SIGNAL_CONTEXT = 'lem-signaling-connect-v1'

/** Domain separation for a key rotation proof, signed by the key on file. */
export const ROTATE_CONTEXT = 'lem-device-rotate-v1'

const DB_NAME = 'lem-device-identity'
const DB_VERSION = 1
const STORE_NAME = 'identity'
const RECORD_KEY = 'current'

/** Thrown when this browser cannot hold an Ed25519 device identity. */
export class DeviceKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeviceKeyUnavailableError'
  }
}

/** This browser's device identity: a stable id and the key that owns it. */
export interface DeviceIdentity {
  /** Device id registered with the signaling server. */
  readonly deviceId: string
  /** Base64 of the raw 32-byte Ed25519 public key. */
  readonly publicKeyB64: string
  /**
   * Sign a challenge payload.
   *
   * @param context One of the `*_CONTEXT` constants.
   * @param fields Payload fields, normally `(deviceId, challenge)`.
   * @returns Base64 of the 64-byte signature.
   */
  sign(context: string, ...fields: string[]): Promise<string>
}

/** An identity as it is persisted: the id plus its non-extractable keypair. */
export interface StoredIdentity {
  deviceId: string
  keyPair: CryptoKeyPair
}

/** Where a device identity is persisted between page loads. */
export interface DeviceKeyStore {
  load(): Promise<StoredIdentity | null>
  save(identity: StoredIdentity): Promise<void>
}

/**
 * Build the exact bytes to sign for a proof of possession.
 *
 * `TextEncoder` emits UTF-8, matching Python's `str.encode('utf-8')`. Joining
 * the strings first and encoding once is equivalent and simpler than encoding
 * each field, because the separator is ASCII.
 *
 * @param context Domain separation constant.
 * @param fields Ordered payload fields, encoded as UTF-8.
 * @returns The message bytes.
 */
export function signedMessage(context: string, ...fields: string[]): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode([context, ...fields].join(':'))
  // Copy into an ArrayBuffer-backed view so this satisfies BufferSource.
  const out = new Uint8Array(new ArrayBuffer(encoded.length))
  out.set(encoded)
  return out
}

/**
 * Base64-encode raw bytes.
 *
 * @param bytes Bytes to encode.
 * @returns Standard base64 with padding.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function subtleCrypto(): SubtleCrypto {
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle
  if (!subtle) {
    throw new DeviceKeyUnavailableError(
      'WebCrypto is unavailable. Lem needs a secure context (HTTPS or localhost) ' +
        'to hold this device‘s identity key.'
    )
  }
  return subtle
}

function isCryptoKeyPair(value: CryptoKey | CryptoKeyPair): value is CryptoKeyPair {
  return 'privateKey' in value && 'publicKey' in value
}

/**
 * Generate a fresh device identity.
 *
 * The private key is non-extractable: this browser can sign with it but no
 * script, including this one, can read it back out.
 *
 * @returns A new id and keypair.
 * @throws DeviceKeyUnavailableError If Ed25519 is not supported here.
 */
export async function generateIdentity(): Promise<StoredIdentity> {
  let generated: CryptoKey | CryptoKeyPair
  try {
    generated = await subtleCrypto().generateKey('Ed25519', false, ['sign', 'verify'])
  } catch (error) {
    throw new DeviceKeyUnavailableError(
      `This browser cannot generate an Ed25519 device key (${String(error)}). ` +
        'Ed25519 needs Chrome 137+, Firefox 129+ or Safari 17+.'
    )
  }

  if (!isCryptoKeyPair(generated)) {
    throw new DeviceKeyUnavailableError('Ed25519 key generation did not return a keypair.')
  }

  const random = new Uint8Array(8)
  crypto.getRandomValues(random)
  const suffix = Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { deviceId: `browser-${suffix}`, keyPair: generated }
}

async function toIdentity(stored: StoredIdentity): Promise<DeviceIdentity> {
  const subtle = subtleCrypto()
  const raw = await subtle.exportKey('raw', stored.keyPair.publicKey)
  const publicKeyB64 = bytesToBase64(new Uint8Array(raw))

  return {
    deviceId: stored.deviceId,
    publicKeyB64,
    async sign(context: string, ...fields: string[]): Promise<string> {
      const signature = await subtle.sign(
        'Ed25519',
        stored.keyPair.privateKey,
        signedMessage(context, ...fields)
      )
      return bytesToBase64(new Uint8Array(signature))
    },
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(
        new DeviceKeyUnavailableError(
          'IndexedDB is unavailable, so this browser cannot keep a device identity. ' +
            'Private browsing modes sometimes block it.'
        )
      )
      return
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('Could not open the device identity database'))
    }
  })
}

function transact<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME))
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('Device identity storage failed'))
    }
  })
}

/**
 * The production key store: IndexedDB, holding a non-extractable CryptoKey.
 *
 * @returns A store backed by IndexedDB.
 */
export function indexedDbKeyStore(): DeviceKeyStore {
  return {
    async load(): Promise<StoredIdentity | null> {
      const db = await openDatabase()
      try {
        const record = await transact<StoredIdentity | undefined>(
          db,
          'readonly',
          // IDBObjectStore.get is typed as IDBRequest<any>; the value is
          // whatever save() put there, which is a StoredIdentity.
          (store) => store.get(RECORD_KEY) as IDBRequest<StoredIdentity | undefined>
        )
        return record ?? null
      } finally {
        db.close()
      }
    },
    async save(identity: StoredIdentity): Promise<void> {
      const db = await openDatabase()
      try {
        await transact(db, 'readwrite', (store) => store.put(identity, RECORD_KEY))
      } finally {
        db.close()
      }
    },
  }
}

let cached: Promise<DeviceIdentity> | null = null

async function loadOrCreate(store: DeviceKeyStore): Promise<DeviceIdentity> {
  const existing = await store.load()
  if (existing) {
    return toIdentity(existing)
  }

  const created = await generateIdentity()
  await store.save(created)
  return toIdentity(created)
}

/**
 * Get this browser's device identity, creating one on first use.
 *
 * The id and the key are stored together, so they can never drift apart: a
 * browser that has lost its key gets a new id rather than an id it can no
 * longer prove it owns.
 *
 * @param store Key store to use; defaults to IndexedDB. Tests pass a fake.
 * @returns The device identity.
 * @throws DeviceKeyUnavailableError If this browser cannot hold a key.
 */
export function getDeviceIdentity(store?: DeviceKeyStore): Promise<DeviceIdentity> {
  if (store) {
    return loadOrCreate(store)
  }
  cached ??= loadOrCreate(indexedDbKeyStore()).catch((error: unknown) => {
    // A failed attempt must not poison every later one.
    cached = null
    throw error
  })
  return cached
}

/** Forget the memoized identity. Used by tests. */
export function resetDeviceIdentityCache(): void {
  cached = null
}
