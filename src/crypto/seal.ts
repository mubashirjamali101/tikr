import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { counterHome } from '../core/paths.js'
import { ensureHome } from '../core/state.js'
import { machineIdentity } from './machine.js'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
/** scrypt cost. 2^15 keeps derivation near 100ms, which is fine once per process. */
const SCRYPT_COST = 32_768

function saltPath(): string {
  return join(counterHome(), 'keyring.json')
}

/**
 * Per-install random salt, stored beside the data with owner-only permissions.
 *
 * The salt alone is useless: the key is derived from salt **and** machine identity, so copying the
 * whole directory to another machine still yields an underivable key. Its job is to make the key
 * unique per install rather than a pure function of the machine.
 */
function loadOrCreateSalt(): Buffer {
  const path = saltPath()
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { salt?: unknown }
      if (typeof parsed.salt === 'string') return Buffer.from(parsed.salt, 'base64')
    } catch {
      // Regenerating would make existing records unreadable, so fail loudly instead.
      throw new Error(`keyring at ${path} is unreadable; the encrypted history cannot be opened`)
    }
  }
  ensureHome()
  const salt = randomBytes(32)
  writeFileSync(path, `${JSON.stringify({ salt: salt.toString('base64') }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return salt
}

let cachedKey: Buffer | null = null

/** Derive the record key. Cached per process because scrypt is deliberately slow. */
export function recordKey(): Buffer {
  if (cachedKey !== null) return cachedKey
  const salt = loadOrCreateSalt()
  const { id } = machineIdentity()
  cachedKey = scryptSync(id, salt, KEY_BYTES, {
    N: SCRYPT_COST,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  })
  return cachedKey
}

/** Test seam: drop the cached key so a new home directory derives its own. */
export function resetKeyCache(): void {
  cachedKey = null
}

export interface Sealed {
  v: 1
  iv: string
  ct: string
  tag: string
}

export function isSealed(value: unknown): value is Sealed {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Sealed>
  return (
    candidate.v === 1 &&
    typeof candidate.iv === 'string' &&
    typeof candidate.ct === 'string' &&
    typeof candidate.tag === 'string'
  )
}

/**
 * Encrypt with AES-256-GCM.
 *
 * GCM is authenticated encryption: the tag covers the ciphertext, so any edit to a stored record -
 * a flipped digit in a token count, a truncated field - makes `open` fail rather than silently
 * returning altered data. That is what makes stored history non-editable in practice.
 */
export function seal(plaintext: string, key: Buffer = recordKey()): Sealed {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  }
}

export class SealError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealError'
  }
}

/** Decrypt and authenticate. Throws `SealError` if the record was altered or is from elsewhere. */
export function open(sealed: Sealed, key: Buffer = recordKey()): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new SealError(
      'record failed authentication: it was modified, or it was written on another machine',
    )
  }
}
