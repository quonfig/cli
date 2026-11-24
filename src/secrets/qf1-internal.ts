/**
 * INTERNAL qf1 implementation (bead qfg-mol-hle). Commands MUST NOT import
 * this module: they import src/secrets/qf1.ts, the curated public API. Only
 * that module and tests import this one (test/secrets/dependency-direction
 * and an eslint no-restricted-imports rule enforce it).
 *
 * Why the split: this module holds the deterministic seams the known-answer
 * vectors need (sealWithEphemeralKey, mintKeypairWith) and the raw KDF and
 * X25519 primitives. A reused ephemeral key to one recipient repeats the AES
 * key and nonce, so no production code path may reach a seam; no environment
 * switch guards them, the module boundary does.
 *
 * Normative spec: project/plans/secrets-qf1-spec.md (APPROVED 2026-11-24).
 *   qf1:<KEYSET>:<FINGERPRINT>:<base64url(E || C || T)>
 *   X25519 (RFC 7748) + HKDF-SHA256 (RFC 5869, written out from HMAC) + AES-256-GCM
 * `node:crypto` only. The keyless pieces come from src/verify/secrets.ts
 * (compiled alone into the pre-receive hook); nothing there imports from here.
 * Error text follows spec 9.2: keysets and fingerprints, never key material,
 * env values or plaintext.
 */

/* eslint-disable no-bitwise -- X25519 encodings and bit tests are bitwise by definition */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
} from 'node:crypto'

import {
  KEYSET_NAME_RE,
  PUBLIC_KEY_PREFIX,
  decodeBase64UrlStrict,
  fingerprintOf,
  parsePublicKeyEntry as parsePublicKeyEntryKeyless,
  parseQf1Structure,
  quoteUntrustedName,
} from '../verify/secrets.js'

export {FINGERPRINT_RE, KEYSET_NAME_RE, PUBLIC_KEY_PREFIX} from '../verify/secrets.js'

// ── Constants (spec 5.1, 6.1) ────────────────────────────────────────────

/** HKDF info: the 22 ASCII bytes `quonfig.com/qf1/X25519`. Private: never hand out the live buffer. */
const HKDF_INFO: Uint8Array = new Uint8Array(Buffer.from('quonfig.com/qf1/X25519', 'ascii'))

/** A fresh copy of the HKDF info bytes (for tests); mutating it cannot affect encryption. */
export function hkdfInfo(): Uint8Array {
  return Uint8Array.from(HKDF_INFO)
}

/** HKDF output length: 32-byte AES-256 key || 12-byte GCM nonce. */
export const OKM_LENGTH = 44
export const TAG_LENGTH = 16
/** Payload minimum: 32-byte E + 16-byte tag (empty plaintext). */
export const MIN_PAYLOAD = 48
/** Text prefix of a private key entry (spec 6.1, decision 23). The prefix alone: no key body appears in this repo. */
export const PRIVATE_KEY_PREFIX = 'qf1-priv-'
const ENTRY_BODY_CHARS = 43

// ── Errors (spec 9) ──────────────────────────────────────────────────────

export type Qf1ErrorCode =
  | 'decrypt_failed'
  | 'invalid_ephemeral_key'
  | 'invalid_key_entry'
  | 'invalid_keyset_name'
  | 'invalid_plaintext'
  | 'invalid_public_key'
  | 'key_not_held'
  | 'keyset_invalid'
  | 'keyset_missing'
  | 'malformed'
  | 'unsupported_version'

/** Public facts an error may carry (spec 9.2). Never key material, env values or plaintext. */
export type Qf1ErrorFields = {
  /** keyset_invalid: 1-based position of the bad entry in the keyset env var. */
  entry?: number
  fingerprint?: string
  /** key_not_held: the fingerprints this machine holds for the keyset, sorted. */
  held?: string[]
  keyset?: string
}

export class Qf1Error extends Error {
  readonly code: Qf1ErrorCode
  entry?: number
  fingerprint?: string
  held?: string[]
  keyset?: string

  /** `detail` must be built from public facts only (names, fingerprints, positions, lengths). */
  constructor(code: Qf1ErrorCode, detail: string, fields: Qf1ErrorFields = {}) {
    super(`qf1 ${code}: ${detail}`)
    this.name = 'Qf1Error'
    this.code = code
    if (fields.entry !== undefined) this.entry = fields.entry
    if (fields.fingerprint !== undefined) this.fingerprint = fields.fingerprint
    if (fields.held !== undefined) this.held = fields.held
    if (fields.keyset !== undefined) this.keyset = fields.keyset
  }
}

const fail = (code: Qf1ErrorCode, detail: string, fields?: Qf1ErrorFields): never => {
  throw new Qf1Error(code, detail, fields)
}

// ── HKDF-SHA256 from HMAC (RFC 5869; spec 5.3) ──────────────────────────

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest())
}

/** RFC 5869 2.2 Extract. An empty salt is HashLen zero bytes (HMAC zero-pads the key, so it is the same PRK). */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return hmacSha256(salt.length === 0 ? new Uint8Array(32) : salt, ikm)
}

/** RFC 5869 2.3 Expand: T(i) = HMAC(PRK, T(i-1) || info || i), OKM = first `length` bytes. */
export function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || length > 255 * 32) throw new RangeError('HKDF length out of range')
  const okm = new Uint8Array(length)
  let t: Uint8Array = new Uint8Array(0)
  for (let i = 1, filled = 0; filled < length; i++) {
    t = hmacSha256(prk, Buffer.concat([t, info, Uint8Array.of(i)]))
    okm.set(t.subarray(0, Math.min(t.length, length - filled)), filled)
    filled += t.length
  }

  return okm
}

export function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length)
}

// ── X25519 (RFC 7748; spec 5.2) ─────────────────────────────────────────

const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const BASE_POINT = (() => {
  const u = new Uint8Array(32)
  u[0] = 9
  return u
})()

const isAllZero = (b: Uint8Array): boolean => b.every((x) => x === 0)

/**
 * X25519(scalar, u) per RFC 7748 section 5: the scalar is clamped, the top bit
 * of u masked and a non-canonical u reduced mod p (OpenSSL does all three).
 * OpenSSL refuses an all-zero result with ERR_OSSL_FAILED_DURING_DERIVATION;
 * ONLY that refusal becomes 32 zero bytes, so callers' all-zero checks cover
 * both behaviours. Any other error propagates.
 */
export function x25519(
  scalar: Uint8Array,
  u: Uint8Array,
  /** Injectable for tests of the error mapping only; production always uses node:crypto. */
  dh: typeof diffieHellman = diffieHellman,
): Uint8Array {
  if (scalar.length !== 32 || u.length !== 32) throw new Error('x25519 needs 32-byte inputs')
  const privateKey = createPrivateKey({format: 'der', key: Buffer.concat([PKCS8_X25519_PREFIX, scalar]), type: 'pkcs8'})
  const publicKey = createPublicKey({format: 'der', key: Buffer.concat([SPKI_X25519_PREFIX, u]), type: 'spki'})
  try {
    return new Uint8Array(dh({privateKey, publicKey}))
  } catch (error) {
    if ((error as {code?: unknown})?.code === 'ERR_OSSL_FAILED_DURING_DERIVATION') return new Uint8Array(32)
    throw error
  }
}

/** The public key of a private key (spec 5.2): X25519(priv, 9). */
export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return x25519(privateKey, BASE_POINT)
}

const P25519 = 2n ** 255n - 19n

function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

// ── Fingerprint and key entries (spec 4, 6.1) ───────────────────────────

/** Spec 4: lowercase hex of SHA-256(pub)[0:4]. */
export function fingerprint(publicKey: Uint8Array): string {
  return fingerprintOf(publicKey)
}

/**
 * Parse a private key entry: `qf1-priv-` + exactly 43 canonical base64url
 * characters (32 bytes). Any 32 bytes are valid (stored unclamped, spec 5.2).
 */
export function parsePrivateKeyEntry(entry: string): Uint8Array {
  if (typeof entry !== 'string' || !entry.startsWith(PRIVATE_KEY_PREFIX)) {
    return fail('invalid_key_entry', `private key entry does not start with "${PRIVATE_KEY_PREFIX}"`)
  }

  const body = entry.slice(PRIVATE_KEY_PREFIX.length)
  const bytes = body.length === ENTRY_BODY_CHARS ? decodeBase64UrlStrict(body) : undefined
  if (!bytes || bytes.length !== 32) {
    return fail(
      'invalid_key_entry',
      `private key entry is not "${PRIVATE_KEY_PREFIX}" followed by ${ENTRY_BODY_CHARS} canonical base64url characters (32 bytes)`,
    )
  }

  return bytes
}

/**
 * Parse a public key entry (`quonfig.json` `publicKeys`): the qfg-verify parser,
 * so writer and hook agree. Rejects top bit set, u >= p and small order.
 */
export function parsePublicKeyEntry(entry: string): Uint8Array {
  const parsed = parsePublicKeyEntryKeyless(entry)
  if (!parsed.ok) return fail('invalid_key_entry', `public key entry ${parsed.reason}`)
  return parsed.publicKey
}

export function formatPrivateKeyEntry(privateKey: Uint8Array): string {
  if (privateKey.length !== 32) throw new Error('a private key is 32 bytes')
  return PRIVATE_KEY_PREFIX + Buffer.from(privateKey).toString('base64url')
}

export function formatPublicKeyEntry(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('a public key is 32 bytes')
  return PUBLIC_KEY_PREFIX + Buffer.from(publicKey).toString('base64url')
}

// ── The keyset env var (spec 6.2) ───────────────────────────────────────

export type HeldKey = {privateKey: Uint8Array; publicKey: Uint8Array}

/** Spec 6.2 step 2: ONLY space, tab, CR and LF; never the platform trim (it also strips VT, FF, NBSP, U+2028, ...). */
const ENV_STRIP_RE = /^[\t\n\r ]+|[\t\n\r ]+$/g

/**
 * Parse a keyset env var value into fingerprint -> key. `value` undefined means
 * the variable is unset. Entries with the same public key collapse; two
 * different public keys with one fingerprint make the keyset invalid.
 */
export function parseKeysetEnv(keyset: string, value: string | undefined): Map<string, HeldKey> {
  return parseKeysetEnvWith(parsePrivateKeyEntry, keyset, value)
}

/**
 * parseKeysetEnv with the entry parser injectable (tests only). Only a
 * Qf1Error `invalid_key_entry` from the parser becomes `keyset_invalid`; any
 * other error is a bug and propagates.
 */
export function parseKeysetEnvWith(
  parseEntry: (entry: string) => Uint8Array,
  keyset: string,
  value: string | undefined,
): Map<string, HeldKey> {
  if (value === undefined || value === null) {
    return fail('keyset_missing', `this machine has no ${keyset}`, {keyset})
  }

  const entries = String(value)
    .split(',')
    .map((piece) => piece.replaceAll(ENV_STRIP_RE, ''))
    .filter((piece) => piece.length > 0)
  if (entries.length === 0) return fail('keyset_missing', `${keyset} is set but holds no keys`, {keyset})

  const held = new Map<string, HeldKey>()
  for (const [index, entry] of entries.entries()) {
    let privateKey: Uint8Array
    try {
      privateKey = parseEntry(entry)
    } catch (error) {
      if (!(error instanceof Qf1Error) || error.code !== 'invalid_key_entry') throw error
      return fail('keyset_invalid', `${keyset} entry ${index + 1} is not a qf1 private key`, {
        entry: index + 1,
        keyset,
      })
    }

    const publicKey = publicKeyFromPrivate(privateKey)
    const fp = fingerprint(publicKey)
    const existing = held.get(fp)
    if (existing) {
      if (Buffer.from(existing.publicKey).equals(publicKey)) continue // one key, written twice or clamp-equivalent
      return fail('keyset_invalid', `${keyset} holds two different keys with fingerprint ${fp}`, {
        fingerprint: fp,
        keyset,
      })
    }

    held.set(fp, {privateKey, publicKey})
  }

  return held
}

// ── Ciphertext string (spec 3) ──────────────────────────────────────────

export type Qf1Parsed = {
  aad: Uint8Array
  ciphertextAndTag: Uint8Array
  ephemeralPublicKey: Uint8Array
  fingerprint: string
  keyset: string
}

/**
 * Spec 3.5 parse, in order. Does NOT reject a small-order E: a reader must
 * first look up the key (spec 8 steps 2-3), and decrypt checks S instead.
 */
export function parseQf1(value: string): Qf1Parsed {
  const parsed = parseQf1Structure(value)
  if (!parsed.ok) return fail(parsed.errorClass, parsed.reason)
  const {aad, ciphertextAndTag, ephemeralPublicKey, fingerprint, keyset} = parsed
  return {aad, ciphertextAndTag, ephemeralPublicKey, fingerprint, keyset}
}

/** True for any string that starts `qf1:`: the one predicate display and redaction paths use (fail closed). */
export function isQf1String(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('qf1:')
}

// ── Derivation (spec 5.3, 5.4) ──────────────────────────────────────────

export type DerivedKey = {aesKey: Uint8Array; hkdfSalt: Uint8Array; nonce: Uint8Array; okm: Uint8Array; prk: Uint8Array}

/** salt = E || pub_r (E as transmitted); PRK = HMAC(salt, S); OKM = Expand(PRK, INFO, 44); K = OKM[0:32], N = OKM[32:44]. */
export function deriveKeyAndNonce(
  sharedSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): DerivedKey {
  const hkdfSalt = new Uint8Array(Buffer.concat([ephemeralPublicKey, recipientPublicKey]))
  const prk = hkdfExtract(hkdfSalt, sharedSecret)
  const okm = hkdfExpand(prk, HKDF_INFO, OKM_LENGTH)
  return {aesKey: okm.subarray(0, 32), hkdfSalt, nonce: okm.subarray(32, 44), okm, prk}
}

/** AAD = ASCII `qf1:<KEYSET>:<FINGERPRINT>:` (spec 5.4). */
export function buildAad(keyset: string, fp: string): Uint8Array {
  return new Uint8Array(Buffer.from(`qf1:${keyset}:${fp}:`, 'latin1'))
}

// ── Encrypt (spec 7) ────────────────────────────────────────────────────

/** True when the UTF-16 string has no unpaired surrogate (spec 3.3); an own scan, not String.prototype.isWellFormed. */
function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i) // eslint-disable-line unicorn/prefer-code-point -- UTF-16 code units are the point
    if (c >= 0xd8_00 && c <= 0xdb_ff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1 // eslint-disable-line unicorn/prefer-code-point
      if (next < 0xdc_00 || next > 0xdf_ff) return false
      i++ // a valid pair
    } else if (c >= 0xdc_00 && c <= 0xdf_ff) {
      return false
    }
  }

  return true
}

export type SealInput = {
  keyset: string
  plaintext: string
  /** The recipient public key as 32 raw bytes. */
  publicKey: Uint8Array
}

/** Spec 2 keyset-name check, as the writer's first step (spec 7 step 1). */
export function checkWriterKeysetName(keyset: unknown): asserts keyset is string {
  if (typeof keyset !== 'string') {
    // Never String() an arbitrary value into the message: it may be anything.
    throw new Qf1Error(
      'invalid_keyset_name',
      `keyset name is not a string (got ${keyset === null ? 'null' : typeof keyset})`,
    )
  }

  if (!KEYSET_NAME_RE.test(keyset)) {
    throw new Qf1Error(
      'invalid_keyset_name',
      `keyset name ${quoteUntrustedName(keyset)} does not match ${KEYSET_NAME_RE.source}`,
    )
  }
}

/**
 * THE DETERMINISTIC SEAM (spec 7 with a caller-chosen priv_e). Holds ALL writer
 * checks, in the decision-47 order: keyset name, recipient key (length, top
 * bit, canonical), plaintext well-formedness, then the small-order check on S.
 * Only the public `encrypt` (fresh randomBytes(32) per call) and the vector
 * tests call it; reusing an ephemeral key repeats the AES key and nonce.
 */
export function sealWithEphemeralKey(
  {keyset, plaintext, publicKey}: SealInput,
  ephemeralPrivateKey: Uint8Array,
): string {
  // Step 1, in this order (decision 47).
  checkWriterKeysetName(keyset)
  if (
    !(publicKey instanceof Uint8Array) ||
    publicKey.length !== 32 ||
    (publicKey[31] & 0x80) !== 0 ||
    littleEndian(publicKey) >= P25519
  ) {
    return fail('invalid_public_key', 'recipient public key must be 32 canonical bytes with the top bit clear', {
      keyset,
    })
  }

  if (typeof plaintext !== 'string' || !isWellFormedUtf16(plaintext)) {
    return fail('invalid_plaintext', 'plaintext is not a well-formed Unicode string', {keyset})
  }

  // Step 2 is the caller's: priv_e.
  if (!(ephemeralPrivateKey instanceof Uint8Array) || ephemeralPrivateKey.length !== 32) {
    throw new Error('qf1 seal: the ephemeral private key must be 32 bytes')
  }

  // Step 3.
  const ephemeralPublicKey = publicKeyFromPrivate(ephemeralPrivateKey)
  const sharedSecret = x25519(ephemeralPrivateKey, publicKey)
  if (isAllZero(sharedSecret)) {
    return fail('invalid_public_key', 'recipient public key is a point of small order', {keyset})
  }

  // Steps 4-6.
  const fp = fingerprint(publicKey)
  const {aesKey, nonce} = deriveKeyAndNonce(sharedSecret, ephemeralPublicKey, publicKey)
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce, {authTagLength: TAG_LENGTH})
  cipher.setAAD(buildAad(keyset, fp))
  const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `qf1:${keyset}:${fp}:${Buffer.concat([ephemeralPublicKey, sealed]).toString('base64url')}`
}

/**
 * The 32 bytes of a `qf1-pub-` entry, structure only (prefix, 43 canonical
 * base64url characters). Canonical-u, top-bit and small-order checks are left
 * to sealWithEphemeralKey so the writer keeps the decision-47 order.
 */
export function decodePublicKeyEntryForWriter(entry: unknown): Uint8Array {
  if (typeof entry !== 'string' || !entry.startsWith(PUBLIC_KEY_PREFIX)) {
    return fail('invalid_public_key', `recipient is not a "${PUBLIC_KEY_PREFIX}" public key entry`)
  }

  const body = entry.slice(PUBLIC_KEY_PREFIX.length)
  const bytes = body.length === ENTRY_BODY_CHARS ? decodeBase64UrlStrict(body) : undefined
  if (!bytes || bytes.length !== 32) {
    return fail(
      'invalid_public_key',
      `recipient is not "${PUBLIC_KEY_PREFIX}" followed by ${ENTRY_BODY_CHARS} canonical base64url characters (32 bytes)`,
    )
  }

  return bytes
}

// ── Decrypt (spec 8) ────────────────────────────────────────────────────

export type EnvLookup = Readonly<Record<string, string | undefined>>

/**
 * Decrypt a qf1 value with the private keys in `env` (default: this program's environment).
 * Reads ONLY the variable named by the value's keyset, and only after that name
 * passed spec 2; looks the key up by (keyset, fingerprint), never by trying
 * keys. Throws Qf1Error.
 */
export function decrypt(value: string, env: EnvLookup = process.env): string {
  // 1. parse (malformed, unsupported_version, invalid_keyset_name)
  const parsed = parseQf1(value)
  const {aad, ciphertextAndTag, ephemeralPublicKey, keyset} = parsed
  const fp = parsed.fingerprint
  // 2. the one env var (own property only), parsed per 6.2 (keyset_missing, keyset_invalid)
  const raw = Object.hasOwn(env, keyset) ? env[keyset] : undefined
  let held: Map<string, HeldKey>
  try {
    held = parseKeysetEnv(keyset, raw)
  } catch (error) {
    if (error instanceof Qf1Error && error.code === 'keyset_missing') {
      return fail(
        'keyset_missing',
        `value is encrypted to ${keyset} fingerprint ${fp}; this machine has no ${keyset}`,
        {
          fingerprint: fp,
          keyset,
        },
      )
    }

    throw error
  }

  // 3. lookup by fingerprint (key_not_held)
  const key = held.get(fp)
  if (!key) {
    const heldFps = [...held.keys()].sort()
    return fail(
      'key_not_held',
      `value is encrypted to ${keyset} fingerprint ${fp}; this machine holds ${keyset} fingerprints [${heldFps.join(', ')}]`,
      {fingerprint: fp, held: heldFps, keyset},
    )
  }

  // 4. shared secret (invalid_ephemeral_key)
  const sharedSecret = x25519(key.privateKey, ephemeralPublicKey)
  if (isAllZero(sharedSecret)) {
    return fail('invalid_ephemeral_key', `the ephemeral key of a ${keyset} fingerprint ${fp} value is of small order`, {
      fingerprint: fp,
      keyset,
    })
  }

  // 5-6. derive, then GCM with the header as AAD (decrypt_failed)
  const {aesKey, nonce} = deriveKeyAndNonce(sharedSecret, ephemeralPublicKey, key.publicKey)
  const tagStart = ciphertextAndTag.length - TAG_LENGTH
  const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce, {authTagLength: TAG_LENGTH})
  decipher.setAAD(aad)
  decipher.setAuthTag(ciphertextAndTag.subarray(tagStart))
  let plaintextBytes: Buffer
  try {
    plaintextBytes = Buffer.concat([decipher.update(ciphertextAndTag.subarray(0, tagStart)), decipher.final()])
  } catch {
    return fail('decrypt_failed', `authentication failed for ${keyset} fingerprint ${fp}`, {fingerprint: fp, keyset})
  }

  // 7. strict UTF-8; a leading U+FEFF is part of the value (decrypt_failed)
  try {
    return new TextDecoder('utf8', {fatal: true, ignoreBOM: true}).decode(plaintextBytes)
  } catch {
    return fail('decrypt_failed', `the ${keyset} fingerprint ${fp} plaintext is not valid UTF-8`, {
      fingerprint: fp,
      keyset,
    })
  } finally {
    plaintextBytes.fill(0)
  }
}

// ── Minting (spec 4, decision 42) ───────────────────────────────────────

export type Keypair = {fingerprint: string; privateKey: Uint8Array; publicKey: Uint8Array}

/**
 * DETERMINISTIC SEAM for key minting: draw from `random` until the
 * fingerprint is not in `existingFingerprints` (decision 42). The public
 * `mintKeypair` passes node:crypto randomBytes; tests inject a sequence.
 */
export function mintKeypairWith(
  existingFingerprints: ReadonlySet<string>,
  random: (size: number) => Uint8Array,
): Keypair {
  for (;;) {
    const privateKey = new Uint8Array(random(32))
    const publicKey = publicKeyFromPrivate(privateKey)
    const fp = fingerprint(publicKey)
    if (!existingFingerprints.has(fp)) return {fingerprint: fp, privateKey, publicKey}
  }
}
