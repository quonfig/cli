// TEST-ONLY COPY, NON-NORMATIVE. Vendored from the Quonfig project repo,
// plans/secrets-qf1/reference.mjs at commit 7449be4 (bead qfg-8seuf.2), for the cli's
// qf1 known-answer tests (bead qfg-mol-hle). The normative text is the spec,
// project/plans/secrets-qf1-spec.md. Not compiled (tsc includes src/ only) and
// not published (package.json "files" is /bin, /dist, /oclif.manifest.json).
// test/secrets/qf1-vectors.test.ts regenerates vectors.json from this copy and
// requires its SHA-256 to equal the approved spec file's, so any edit here
// that changed the output would fail that test.
//
// qf1 reference implementation (Node, node:crypto only, no dependencies).
//
// Normative text: project/plans/secrets-qf1-spec.md. This file exists to
// generate and check the known-answer vectors; it is not a shipped library.
// Section numbers in comments refer to the spec.
//
// qf1:<KEYSET>:<fingerprint>:<base64url(ephemeralPub32 || ciphertext || tag16)>
// X25519 (RFC 7748) + HKDF-SHA256 (RFC 5869) + AES-256-GCM.

import {createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman} from 'node:crypto'

// ---- Constants (spec section 5) ----

export const VERSION = 'qf1'
export const HKDF_INFO = Buffer.from('quonfig.com/qf1/X25519', 'ascii')
export const OKM_LENGTH = 44 // 32-byte AES-256 key || 12-byte GCM nonce
export const KEY_LENGTH = 32
export const TAG_LENGTH = 16
export const MIN_BLOB_LENGTH = KEY_LENGTH + TAG_LENGTH // 48: empty plaintext
export const PRIVATE_KEY_PREFIX = 'qf1-priv-'
export const PUBLIC_KEY_PREFIX = 'qf1-pub-'
export const KEYSET_NAME_RE = /^QUONFIG_KEYSET(_[A-Z0-9]+)*$/
export const FINGERPRINT_RE = /^[0-9a-f]{8}$/
const B64URL_RE = /^[A-Za-z0-9_-]+$/
const VERSION_PREFIX_RE = /^qf[1-9][0-9]*:/
const ENV_TRIM_RE = /^[ \t\r\n]+|[ \t\r\n]+$/g

// ---- Errors (spec section 9) ----

export const ErrorCode = Object.freeze({
  MALFORMED: 'malformed',
  UNSUPPORTED_VERSION: 'unsupported_version',
  INVALID_KEYSET_NAME: 'invalid_keyset_name',
  KEYSET_MISSING: 'keyset_missing',
  KEYSET_INVALID: 'keyset_invalid',
  KEY_NOT_HELD: 'key_not_held',
  INVALID_EPHEMERAL_KEY: 'invalid_ephemeral_key',
  DECRYPT_FAILED: 'decrypt_failed',
  INVALID_KEY_ENTRY: 'invalid_key_entry',
  INVALID_PUBLIC_KEY: 'invalid_public_key',
  INVALID_PLAINTEXT: 'invalid_plaintext',
})

export class Qf1Error extends Error {
  constructor(code, message) {
    super(`qf1 ${code}: ${message}`)
    this.name = 'Qf1Error'
    this.code = code
  }
}

const fail = (code, message) => {
  throw new Qf1Error(code, message)
}

// ---- base64url, strict (spec section 3.4) ----

export function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64url') // RFC 4648 section 5, no padding
}

// Returns the decoded bytes, or null if `s` is not canonical unpadded base64url.
export function b64urlDecodeStrict(s) {
  if (typeof s !== 'string' || s.length === 0 || !B64URL_RE.test(s)) return null
  if (s.length % 4 === 1) return null
  const bytes = Buffer.from(s, 'base64url')
  if (bytes.toString('base64url') !== s) return null // non-zero trailing bits
  return bytes
}

// ---- HKDF-SHA256 from HMAC (RFC 5869; spec section 5.3) ----

export function hmacSha256(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

export function hkdfExtract(salt, ikm) {
  // RFC 5869 2.2: an absent salt is HashLen zero bytes; HMAC pads a short key
  // with zeros anyway, so an empty salt gives the same PRK.
  return hmacSha256(salt.length === 0 ? Buffer.alloc(32) : salt, ikm)
}

export function hkdfExpand(prk, info, length) {
  if (length > 255 * 32) throw new Error('HKDF length too large')
  const blocks = []
  let t = Buffer.alloc(0)
  for (let i = 1; Buffer.concat(blocks).length < length; i++) {
    t = hmacSha256(prk, Buffer.concat([t, info, Buffer.from([i])]))
    blocks.push(t)
  }
  return Buffer.concat(blocks).subarray(0, length)
}

export function hkdf(salt, ikm, info, length) {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length)
}

// ---- X25519 (RFC 7748; spec section 5.2) ----

const PKCS8_X25519_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const SPKI_X25519_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

function privateKeyObject(scalar) {
  return createPrivateKey({key: Buffer.concat([PKCS8_X25519_PREFIX, scalar]), format: 'der', type: 'pkcs8'})
}

function publicKeyObject(u) {
  return createPublicKey({key: Buffer.concat([SPKI_X25519_PREFIX, u]), format: 'der', type: 'spki'})
}

// X25519(scalar, u). The scalar is clamped, the top bit of u is masked and a
// non-canonical u (p <= u < 2^255) is reduced mod p, as RFC 7748 section 5
// requires (OpenSSL does all three). OpenSSL refuses an all-zero result with
// ERR_OSSL_FAILED_DURING_DERIVATION; only that error is turned into 32 zero
// bytes, so the caller's all-zero check handles both cases the same way. Any
// other error propagates.
export function x25519(scalar, u) {
  if (scalar.length !== 32 || u.length !== 32) throw new Error('x25519 needs 32-byte inputs')
  try {
    return Buffer.from(diffieHellman({privateKey: privateKeyObject(scalar), publicKey: publicKeyObject(u)}))
  } catch (err) {
    if (err && err.code === 'ERR_OSSL_FAILED_DURING_DERIVATION') return Buffer.alloc(32)
    throw err
  }
}

// p = 2^255 - 19. True when the little-endian u is >= p (u has the top bit
// clear and is non-canonical).
const P25519 = 2n ** 255n - 19n
export function isNonCanonicalU(u) {
  const n = BigInt('0x' + Buffer.from(u).reverse().toString('hex'))
  return n >= P25519 && n < 2n ** 255n
}

export function publicKeyFromPrivate(privateKey) {
  const der = createPublicKey(privateKeyObject(privateKey)).export({format: 'der', type: 'spki'})
  return Buffer.from(der.subarray(der.length - 32))
}

const isAllZero = (b) => b.every((x) => x === 0)

// ---- Fingerprint (spec section 4) ----

export function fingerprint(publicKey) {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 8)
}

// ---- Key entries (spec section 6) ----

function parseEntry(entry, prefix, what) {
  if (typeof entry !== 'string' || !entry.startsWith(prefix)) {
    fail(ErrorCode.INVALID_KEY_ENTRY, `${what} does not start with "${prefix}"`)
  }
  const body = entry.slice(prefix.length)
  const bytes = body.length === 43 ? b64urlDecodeStrict(body) : null
  if (!bytes || bytes.length !== 32) {
    fail(ErrorCode.INVALID_KEY_ENTRY, `${what} is not "${prefix}" followed by 43 base64url characters encoding 32 bytes`)
  }
  return bytes
}

export function parsePrivateKeyEntry(entry) {
  return parseEntry(entry, PRIVATE_KEY_PREFIX, 'private key entry')
}

export function formatPrivateKeyEntry(privateKey) {
  return PRIVATE_KEY_PREFIX + b64urlEncode(privateKey)
}

// A public key is also rejected when its top bit is set, when it is not
// canonical (u >= p: the fingerprint is over the bytes, so one point must have
// one encoding), or when it is a low-order point: X25519 of any scalar with it
// is all zero, so nothing can ever be encrypted to it.
const LOW_ORDER_PROBE_SCALAR = Buffer.alloc(32, 0x01)
export function parsePublicKeyEntry(entry) {
  const pub = parseEntry(entry, PUBLIC_KEY_PREFIX, 'public key entry')
  if ((pub[31] & 0x80) !== 0) fail(ErrorCode.INVALID_KEY_ENTRY, 'public key has the top bit set')
  if (isNonCanonicalU(pub)) fail(ErrorCode.INVALID_KEY_ENTRY, 'public key is not canonical (u >= p)')
  if (isAllZero(x25519(LOW_ORDER_PROBE_SCALAR, pub))) {
    fail(ErrorCode.INVALID_KEY_ENTRY, 'public key is a low-order point')
  }
  return pub
}

export function formatPublicKeyEntry(publicKey) {
  return PUBLIC_KEY_PREFIX + b64urlEncode(publicKey)
}

// Parse a keyset env var value into Map<fingerprint, {privateKey, publicKey}>.
// spec section 6.2.
export function parseKeysetEnvValue(keysetName, value) {
  if (value === undefined || value === null) fail(ErrorCode.KEYSET_MISSING, `this runtime has no ${keysetName}`)
  const entries = String(value)
    .split(',')
    .map((e) => e.replace(ENV_TRIM_RE, ''))
    .filter((e) => e.length > 0)
  if (entries.length === 0) fail(ErrorCode.KEYSET_MISSING, `${keysetName} is set but holds no keys`)
  const held = new Map()
  entries.forEach((entry, i) => {
    let privateKey
    try {
      privateKey = parsePrivateKeyEntry(entry)
    } catch {
      fail(ErrorCode.KEYSET_INVALID, `${keysetName} entry ${i + 1} is not a qf1 private key`)
    }
    const publicKey = publicKeyFromPrivate(privateKey)
    const fp = fingerprint(publicKey)
    const existing = held.get(fp)
    if (existing) {
      if (existing.publicKey.equals(publicKey)) return // same key twice: harmless
      fail(ErrorCode.KEYSET_INVALID, `${keysetName} holds two different keys with fingerprint ${fp}`)
    }
    held.set(fp, {privateKey, publicKey})
  })
  return held
}

// ---- Ciphertext string (spec section 3) ----

export function parseQf1(value) {
  if (typeof value !== 'string') fail(ErrorCode.MALFORMED, 'value is not a string')
  if (!value.startsWith('qf1:')) {
    if (VERSION_PREFIX_RE.test(value)) {
      fail(ErrorCode.UNSUPPORTED_VERSION, `version ${value.slice(0, value.indexOf(':'))} is not supported by this runtime`)
    }
    fail(ErrorCode.MALFORMED, 'value does not start with "qf1:"')
  }
  const fields = value.split(':')
  if (fields.length !== 4) fail(ErrorCode.MALFORMED, `expected 4 colon-separated fields, found ${fields.length}`)
  const [, keyset, fp, blobText] = fields
  if (!KEYSET_NAME_RE.test(keyset)) {
    fail(ErrorCode.INVALID_KEYSET_NAME, `keyset name ${JSON.stringify(keyset.slice(0, 64))} does not match ^QUONFIG_KEYSET(_[A-Z0-9]+)*$`)
  }
  if (!FINGERPRINT_RE.test(fp)) fail(ErrorCode.MALFORMED, 'fingerprint is not 8 lowercase hex characters')
  const blob = b64urlDecodeStrict(blobText)
  if (!blob) fail(ErrorCode.MALFORMED, 'payload is not canonical unpadded base64url')
  if (blob.length < MIN_BLOB_LENGTH) fail(ErrorCode.MALFORMED, `payload is ${blob.length} bytes; minimum is ${MIN_BLOB_LENGTH}`)
  const ephemeralPublicKey = blob.subarray(0, 32)
  if ((ephemeralPublicKey[31] & 0x80) !== 0) fail(ErrorCode.MALFORMED, 'ephemeral public key has the top bit set')
  return {
    keyset,
    fingerprint: fp,
    ephemeralPublicKey,
    ciphertextAndTag: blob.subarray(32),
    aad: Buffer.from(`qf1:${keyset}:${fp}:`, 'ascii'),
  }
}

// ---- Derivation shared by encrypt and decrypt (spec section 5) ----

function derive(sharedSecret, ephemeralPublicKey, recipientPublicKey) {
  const hkdfSalt = Buffer.concat([ephemeralPublicKey, recipientPublicKey])
  const prk = hkdfExtract(hkdfSalt, sharedSecret)
  const okm = hkdfExpand(prk, HKDF_INFO, OKM_LENGTH)
  return {hkdfSalt, hkdfInfo: HKDF_INFO, prk, okm, aesKey: okm.subarray(0, 32), nonce: okm.subarray(32, 44)}
}

// ---- Encrypt (spec section 7) ----
//
// ephemeralPrivateKey is for test vectors only; real writers MUST draw 32
// fresh random bytes per value. plaintext is a JS string; it MUST be
// well-formed Unicode (no lone surrogates), because UTF-8 encoding would
// otherwise silently replace them with U+FFFD.
export function encrypt({plaintext, keyset, publicKey, ephemeralPrivateKey}) {
  if (typeof keyset !== 'string' || !KEYSET_NAME_RE.test(keyset)) {
    fail(ErrorCode.INVALID_KEYSET_NAME, 'keyset name does not match ^QUONFIG_KEYSET(_[A-Z0-9]+)*$')
  }
  if (
    !Buffer.isBuffer(publicKey) ||
    publicKey.length !== 32 ||
    (publicKey[31] & 0x80) !== 0 ||
    isNonCanonicalU(publicKey)
  ) {
    fail(ErrorCode.INVALID_PUBLIC_KEY, 'recipient public key must be 32 canonical bytes with the top bit clear')
  }
  if (typeof plaintext !== 'string' || !plaintext.isWellFormed()) {
    fail(ErrorCode.INVALID_PLAINTEXT, 'plaintext is not a well-formed Unicode string')
  }
  if (!ephemeralPrivateKey) throw new Error('reference encrypt requires an explicit ephemeral key (vectors only)')
  const ephemeralPublicKey = publicKeyFromPrivate(ephemeralPrivateKey)
  const sharedSecret = x25519(ephemeralPrivateKey, publicKey)
  if (isAllZero(sharedSecret)) fail(ErrorCode.INVALID_PUBLIC_KEY, 'recipient public key is a low-order point')
  const sealed = sealRaw({
    keysetField: keyset,
    fingerprintField: fingerprint(publicKey),
    transmittedEphemeralPublicKey: ephemeralPublicKey,
    sharedSecret,
    recipientPublicKey: publicKey,
    plaintextBytes: Buffer.from(plaintext, 'utf8'),
  })
  return {ciphertext: sealed.ciphertext, trace: {fingerprint: sealed.fingerprintField, sharedSecret, ...sealed.trace}}
}

// The construction with every writer check removed: TEST-VECTOR USE ONLY.
// It seals arbitrary header fields, an arbitrary transmitted ephemeral key and
// shared secret, and arbitrary plaintext bytes, so the generator can produce
// ciphertexts that are authentic except for exactly one rule (must-reject
// vectors). The HKDF salt is computed over the transmitted ephemeral bytes.
export function sealRaw({keysetField, fingerprintField, transmittedEphemeralPublicKey, sharedSecret, recipientPublicKey, plaintextBytes}) {
  const d = derive(sharedSecret, transmittedEphemeralPublicKey, recipientPublicKey)
  const aad = Buffer.from(`qf1:${keysetField}:${fingerprintField}:`, 'latin1')
  const cipher = createCipheriv('aes-256-gcm', d.aesKey, d.nonce, {authTagLength: TAG_LENGTH})
  cipher.setAAD(aad)
  const ciphertextAndTag = Buffer.concat([cipher.update(plaintextBytes), cipher.final(), cipher.getAuthTag()])
  const blob = Buffer.concat([transmittedEphemeralPublicKey, ciphertextAndTag])
  return {
    ciphertext: `qf1:${keysetField}:${fingerprintField}:${b64urlEncode(blob)}`,
    fingerprintField,
    trace: {ephemeralPublicKey: transmittedEphemeralPublicKey, ...d, aad, ciphertextAndTag, blob},
  }
}

// ---- Decrypt (spec section 8) ----
//
// env: a plain object of environment variable name -> value. Only the one
// variable named by a valid keyset name is ever read.
export function decrypt(value, env) {
  const parsed = parseQf1(value)
  const held = parseKeysetEnvValue(parsed.keyset, Object.prototype.hasOwnProperty.call(env, parsed.keyset) ? env[parsed.keyset] : undefined)
  const key = held.get(parsed.fingerprint)
  if (!key) {
    fail(
      ErrorCode.KEY_NOT_HELD,
      `value is encrypted to ${parsed.keyset} fingerprint ${parsed.fingerprint}; this runtime holds ${parsed.keyset} fingerprints [${[...held.keys()].sort().join(', ')}]`,
    )
  }
  const sharedSecret = x25519(key.privateKey, parsed.ephemeralPublicKey)
  if (isAllZero(sharedSecret)) fail(ErrorCode.INVALID_EPHEMERAL_KEY, 'X25519 shared secret is all zero')
  const d = derive(sharedSecret, parsed.ephemeralPublicKey, key.publicKey)
  const ct = parsed.ciphertextAndTag
  const decipher = createDecipheriv('aes-256-gcm', d.aesKey, d.nonce, {authTagLength: TAG_LENGTH})
  decipher.setAAD(parsed.aad)
  decipher.setAuthTag(ct.subarray(ct.length - TAG_LENGTH))
  let pt
  try {
    pt = Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_LENGTH)), decipher.final()])
  } catch {
    fail(ErrorCode.DECRYPT_FAILED, `authentication failed for ${parsed.keyset} fingerprint ${parsed.fingerprint}`)
  }
  try {
    return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(pt)
  } catch {
    fail(ErrorCode.DECRYPT_FAILED, 'plaintext is not valid UTF-8')
  }
}
