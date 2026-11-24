/**
 * The secrets family in qfg-verify (bead qfg-8seuf.4): the KEYLESS structural
 * rules of the qf1 format. Spec: project/plans/secrets-qf1-spec.md sections 2,
 * 3, 4, 6.1, 10 and 11.
 *
 * qfg-verify holds no private key and does no authorization. Everything here
 * is decidable from the repo alone: the qf1 grammar (3.5 steps 1-6), the
 * small-order test on the ephemeral key (decision 37), and membership of each
 * value's (keyset, fingerprint) in `quonfig.json` `secrets.keysets`.
 *
 * Self-contained on purpose: this directory is copied on its own into the
 * standalone bun-compiled pre-receive hook (app-gitea Dockerfile), so it may
 * import only `node:` builtins and the packages that build installs (zod, ajv).
 * X25519 is a small BigInt Montgomery ladder rather than node:crypto's
 * diffieHellman, so the small-order test behaves identically under node and
 * bun (OpenSSL refuses a small-order input with an exception; other runtimes
 * differ).
 *
 * Choices still awaiting Jeff's approval of the spec each live in ONE place:
 *   - PUBLIC_KEY_PREFIX              spec decision 23 (key entry text form)
 *   - SECRETS_STORAGE_RULES          spec decision 24 (storage restrictions)
 *   - isTemporarySecretsDuplicate    spec 11.6 / decision 29 (removed by qfg-8seuf.20)
 */

/* eslint-disable no-bitwise -- X25519, little-endian byte codecs and bit tests are bitwise by definition */
import {createHash} from 'node:crypto'

import type {ValidationIssue} from './validate.js'

// ── Flagged choices (one place each) ────────────────────────────────────

/**
 * Text prefix of a public key entry in `quonfig.json` (spec 6.1).
 * NEEDS JEFF (spec decision 23): flipping the format is a change here.
 */
export const PUBLIC_KEY_PREFIX = 'qf1-pub-'

/**
 * Storage restrictions for documents in `secrets/` and for the
 * `quonfig.json` `secrets` object beyond what the plan states.
 * NEEDS JEFF (spec decision 24): each one is a one-line flip.
 */
export const SECRETS_STORAGE_RULES = {
  /** `provided` (ENV_VAR) rule values in a secret. */
  allowProvidedValues: false,
  /** `sendToClientSdk: true` on a secret (false or absent is always fine). */
  allowSendToClientSdk: false,
  /** Non-empty top-level `variants` on a secret. */
  allowVariants: false,
  /** `weighted_values` rule values in a secret. */
  allowWeightedValues: false,
  /** Reject unknown members inside `secrets` and inside each keyset object. */
  rejectUnknownManifestMembers: true,
} as const

// ── Format constants (spec 2, 3, 6.1) ───────────────────────────────────

/** Spec 2. JS regexes without the `m` flag anchor at the string ends, so `$` never matches before a final LF. */
export const KEYSET_NAME_RE = /^QUONFIG_KEYSET(?:_[\dA-Z]+)*$/
const FINGERPRINT_RE = /^[\da-f]{8}$/
const VERSION_PREFIX_RE = /^qf[1-9]\d*:/
const B64URL_RE = /^[\w-]+$/
const QF1_PREFIX = 'qf1:'
const MIN_PAYLOAD_BYTES = 48 // 32-byte ephemeral key + 16-byte tag (empty plaintext)
const PUBLIC_KEY_BODY_CHARS = 43

// ── X25519 (RFC 7748 section 5), keyless use only ───────────────────────

const P = 2n ** 255n - 19n
const A24 = 121_665n

const mod = (a: bigint): bigint => {
  const r = a % P
  return r < 0n ? r + P : r
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n
  let b = mod(base)
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = mod(result * b)
    b = mod(b * b)
    e >>= 1n
  }

  return result
}

function decodeLittleEndian(bytes: Uint8Array): bigint {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

function encodeLittleEndian(n: bigint): Uint8Array {
  const out = new Uint8Array(32)
  let v = n
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }

  return out
}

/**
 * X25519(k, u) per RFC 7748 section 5: clamps the scalar, masks the top bit of
 * u and reduces a non-canonical u mod p. Not constant time; qfg-verify only
 * ever runs it on public values with a fixed public scalar.
 */
export function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  if (scalar.length !== 32 || u.length !== 32) throw new Error('x25519 needs 32-byte inputs')
  const k = Uint8Array.from(scalar)
  k[0] &= 248
  k[31] &= 127
  k[31] |= 64
  const kn = decodeLittleEndian(k)
  const uMasked = Uint8Array.from(u)
  uMasked[31] &= 127
  const x1 = mod(decodeLittleEndian(uMasked))

  let x2 = 1n
  let z2 = 0n
  let x3 = x1
  let z3 = 1n
  let swap = 0n
  for (let t = 254n; t >= 0n; t--) {
    const kt = (kn >> t) & 1n
    swap ^= kt
    if (swap) {
      ;[x2, x3] = [x3, x2]
      ;[z2, z3] = [z3, z2]
    }

    swap = kt
    const a = mod(x2 + z2)
    const aa = mod(a * a)
    const b = mod(x2 - z2)
    const bb = mod(b * b)
    const e = mod(aa - bb)
    const c = mod(x3 + z3)
    const d = mod(x3 - z3)
    const da = mod(d * a)
    const cb = mod(c * b)
    x3 = mod((da + cb) ** 2n)
    z3 = mod(x1 * mod((da - cb) ** 2n))
    x2 = mod(aa * bb)
    z2 = mod(e * mod(aa + A24 * e))
  }

  if (swap) {
    ;[x2, x3] = [x3, x2]
    ;[z2, z3] = [z3, z2]
  }

  return encodeLittleEndian(mod(x2 * modPow(z2, P - 2n)))
}

/** Spec 6.1: fixed scalar 0x01 x 32; after clamping it is a multiple of 8. */
const SMALL_ORDER_PROBE_SCALAR = new Uint8Array(32).fill(0x01)

/** True when u is a point of small order: X25519 with the probe scalar is all zero (spec 6.1). */
export function isSmallOrder(u: Uint8Array): boolean {
  return x25519(SMALL_ORDER_PROBE_SCALAR, u).every((byte) => byte === 0)
}

// ── Encodings (spec 3.4, 4) ─────────────────────────────────────────────

/** Strict canonical unpadded base64url (spec 3.4); undefined when not canonical. */
function decodeBase64UrlStrict(text: string): undefined | Uint8Array {
  if (text.length === 0 || !B64URL_RE.test(text) || text.length % 4 === 1) return undefined
  const bytes = Buffer.from(text, 'base64url')
  if (bytes.toString('base64url') !== text) return undefined // non-zero trailing bits
  return new Uint8Array(bytes)
}

/** Spec 4: lowercase hex of the first 4 bytes of SHA-256 over the raw 32-byte public key. */
export function fingerprintOf(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex').slice(0, 8)
}

// ── qf1 string, keyless parse (spec 3.5 steps 1-6, decision 37) ──────────

export type Qf1KeylessErrorClass = 'invalid_ephemeral_key' | 'invalid_keyset_name' | 'malformed' | 'unsupported_version'

export type Qf1KeylessParse =
  | {ephemeralPublicKey: Uint8Array; fingerprint: string; keyset: string; ok: true}
  | {errorClass: Qf1KeylessErrorClass; ok: false; reason: string}

const fail = (errorClass: Qf1KeylessErrorClass, reason: string): Qf1KeylessParse => ({errorClass, ok: false, reason})

/** Quote an untrusted name for an error message: truncated to 64, control characters escaped (spec 9.2). */
const quoteName = (name: string): string => JSON.stringify(name.slice(0, 64))

/**
 * Parse a qf1 value as far as possible without a key, in the spec's order:
 * the first failing step decides the class. Adds the small-order test on the
 * ephemeral key (spec 11.3, decision 37), which a reader reports as
 * `invalid_ephemeral_key`.
 */
export function parseQf1Keyless(value: unknown): Qf1KeylessParse {
  if (typeof value !== 'string') return fail('malformed', 'value is not a string')
  // 1. version
  if (!value.startsWith(QF1_PREFIX)) {
    return VERSION_PREFIX_RE.test(value)
      ? fail('unsupported_version', `version ${value.slice(0, value.indexOf(':'))} is not supported`)
      : fail('malformed', 'value does not start with "qf1:"')
  }

  // 2. exactly four fields, empty fields kept (String.split keeps them)
  const fields = value.split(':')
  if (fields.length !== 4) return fail('malformed', `expected 4 colon-separated fields, found ${fields.length}`)
  const [, keyset, fingerprint, payloadText] = fields
  // 3. keyset name
  if (!KEYSET_NAME_RE.test(keyset)) {
    return fail('invalid_keyset_name', `keyset name ${quoteName(keyset)} does not match ${KEYSET_NAME_RE.source}`)
  }

  // 4. fingerprint
  if (!FINGERPRINT_RE.test(fingerprint)) return fail('malformed', 'fingerprint is not 8 lowercase hex characters')
  // 5. payload
  const payload = decodeBase64UrlStrict(payloadText)
  if (!payload) return fail('malformed', 'payload is not canonical unpadded base64url')
  if (payload.length < MIN_PAYLOAD_BYTES) {
    return fail('malformed', `payload is ${payload.length} bytes; minimum is ${MIN_PAYLOAD_BYTES}`)
  }

  // 6. top bit of the ephemeral key
  const ephemeralPublicKey = payload.subarray(0, 32)
  if ((ephemeralPublicKey[31] & 0x80) !== 0) return fail('malformed', 'ephemeral public key has the top bit set')
  // decision 37: small-order ephemeral key (no runtime could ever read it)
  if (isSmallOrder(ephemeralPublicKey)) {
    return fail('invalid_ephemeral_key', 'ephemeral public key is a point of small order')
  }

  return {ephemeralPublicKey, fingerprint, keyset, ok: true}
}

// ── Public key entries (spec 6.1) ───────────────────────────────────────

export type PublicKeyEntryParse = {fingerprint: string; ok: true; publicKey: Uint8Array} | {ok: false; reason: string}

/** Parse a `quonfig.json` public key entry; every failure is `invalid_key_entry`. */
export function parsePublicKeyEntry(entry: unknown): PublicKeyEntryParse {
  if (typeof entry !== 'string') return {ok: false, reason: 'is not a string'}
  if (!entry.startsWith(PUBLIC_KEY_PREFIX)) return {ok: false, reason: `does not start with "${PUBLIC_KEY_PREFIX}"`}
  const body = entry.slice(PUBLIC_KEY_PREFIX.length)
  const publicKey = body.length === PUBLIC_KEY_BODY_CHARS ? decodeBase64UrlStrict(body) : undefined
  if (!publicKey || publicKey.length !== 32) {
    return {
      ok: false,
      reason: `is not "${PUBLIC_KEY_PREFIX}" followed by ${PUBLIC_KEY_BODY_CHARS} canonical base64url characters (32 bytes)`,
    }
  }

  if ((publicKey[31] & 0x80) !== 0) return {ok: false, reason: 'has the top bit set'}
  if (decodeLittleEndian(publicKey) >= P) return {ok: false, reason: 'is not canonical (u >= p)'}
  if (isSmallOrder(publicKey)) return {ok: false, reason: 'is a point of small order'}
  return {fingerprint: fingerprintOf(publicKey), ok: true, publicKey}
}

// ── quonfig.json `secrets` (spec 10.1, 11.1) ─────────────────────────────

/** keyset name -> fingerprints of its valid public key entries. */
export type KeysetRegistry = Map<string, Set<string>>

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Validate `quonfig.json`'s optional `secrets` member and return the keysets
 * that secret values may reference. A keyset whose name is invalid is not
 * registered; a keyset with some invalid entries registers only its valid
 * ones, so each mistake is reported once, on quonfig.json.
 */
export function validateSecretsManifest(manifest: unknown, issues: ValidationIssue[]): KeysetRegistry {
  const registry: KeysetRegistry = new Map()
  if (!isPlainObject(manifest) || !Object.hasOwn(manifest, 'secrets')) return registry
  const error = (message: string, suggestion?: string) =>
    issues.push({file: 'quonfig.json', message, severity: 'error', ...(suggestion ? {suggestion} : {})})

  const {secrets} = manifest
  if (!isPlainObject(secrets)) {
    error(`"secrets" must be an object with a "keysets" object`)
    return registry
  }

  if (SECRETS_STORAGE_RULES.rejectUnknownManifestMembers) {
    for (const member of Object.keys(secrets)) {
      if (member !== 'keysets') error(`"secrets" has unknown member ${quoteName(member)}`)
    }
  }

  const {keysets} = secrets
  if (!isPlainObject(keysets)) {
    error(`"secrets.keysets" must be an object mapping keyset name to {"publicKeys": [...]}`)
    return registry
  }

  for (const [name, keyset] of Object.entries(keysets)) {
    if (!KEYSET_NAME_RE.test(name)) {
      error(
        `secrets.keysets: keyset name ${quoteName(name)} does not match ${KEYSET_NAME_RE.source}`,
        `Use a name like QUONFIG_KEYSET_PROD (uppercase letters, digits, single underscores)`,
      )
      continue
    }

    const where = `secrets.keysets.${name}`
    if (!isPlainObject(keyset)) {
      error(`${where} must be an object with a non-empty "publicKeys" array`)
      continue
    }

    if (SECRETS_STORAGE_RULES.rejectUnknownManifestMembers) {
      for (const member of Object.keys(keyset)) {
        if (member !== 'publicKeys') error(`${where} has unknown member ${quoteName(member)}`)
      }
    }

    const fingerprints = new Set<string>()
    registry.set(name, fingerprints)
    const {publicKeys} = keyset
    if (!Array.isArray(publicKeys) || publicKeys.length === 0) {
      error(`${where}.publicKeys must be a non-empty array of ${PUBLIC_KEY_PREFIX} entries`)
      continue
    }

    const firstIndexByFingerprint = new Map<string, number>()
    for (const [index, entry] of publicKeys.entries()) {
      const parsed = parsePublicKeyEntry(entry)
      if (!parsed.ok) {
        error(`${where}.publicKeys[${index}]: invalid_key_entry: public key entry ${parsed.reason}`)
        continue
      }

      const first = firstIndexByFingerprint.get(parsed.fingerprint)
      if (first === undefined) {
        firstIndexByFingerprint.set(parsed.fingerprint, index)
        fingerprints.add(parsed.fingerprint)
      } else {
        error(
          `${where}.publicKeys[${index}]: duplicate fingerprint ${parsed.fingerprint} (same as publicKeys[${first}])`,
          `Each public key in a keyset must have a distinct fingerprint; remove the duplicate`,
        )
      }
    }
  }

  return registry
}

// ── Documents in secrets/ (spec 10.2, 11.3) ─────────────────────────────

type RawRule = {value?: unknown}
type RawDoc = {
  default?: {rules?: RawRule[]}
  environments?: Array<{id?: unknown; rules?: RawRule[]}>
  sendToClientSdk?: unknown
  valueType?: unknown
  variants?: Array<{value?: unknown}>
}

/** Every rule value of a document with its scope label (`default` / `environments[<id>]`). */
function ruleValues(doc: RawDoc): Array<{ctx: string; value: unknown}> {
  const out: Array<{ctx: string; value: unknown}> = []
  for (const [i, rule] of (doc.default?.rules ?? []).entries())
    out.push({ctx: `default.rules[${i}]`, value: rule?.value})
  for (const env of doc.environments ?? []) {
    for (const [i, rule] of (env?.rules ?? []).entries()) {
      out.push({ctx: `environments[${String(env?.id)}].rules[${i}]`, value: rule?.value})
    }
  }

  return out
}

/**
 * The secrets-family rules for one document in `secrets/`. Runs after the
 * shared StoredConfig schema has passed, on the RAW document (the Zod parse
 * strips `confidential` and `decryptWith`).
 */
export function validateSecretDocument(
  raw: unknown,
  file: string,
  keysets: KeysetRegistry,
  issues: ValidationIssue[],
): void {
  const doc = (raw ?? {}) as RawDoc
  const error = (message: string, suggestion?: string) =>
    issues.push({file, message, severity: 'error', ...(suggestion ? {suggestion} : {})})

  if (doc.valueType !== 'string') error(`Secret must have valueType "string", got "${String(doc.valueType)}"`)
  if (doc.sendToClientSdk === true && !SECRETS_STORAGE_RULES.allowSendToClientSdk) {
    error(`Secret must not set sendToClientSdk to true; secrets are never sent to client SDKs`)
  }

  const variantCount = Array.isArray(doc.variants) ? doc.variants.length : 0
  if (variantCount > 0 && !SECRETS_STORAGE_RULES.allowVariants) {
    error(`Secret must not have variants (found ${variantCount})`, `Remove "variants" or set it to []`)
  }

  for (const {ctx, value} of ruleValues(doc)) {
    const v = (value ?? {}) as {confidential?: unknown; decryptWith?: unknown; type?: unknown; value?: unknown}
    if (v.type === 'weighted_values' && !SECRETS_STORAGE_RULES.allowWeightedValues) {
      error(`${ctx}: weighted_values are not allowed in a secret`)
      continue
    }

    if (v.type === 'provided' && !SECRETS_STORAGE_RULES.allowProvidedValues) {
      error(
        `${ctx}: provided values are not allowed in a secret`,
        `Keep ENV_VAR provided values in configs/; secrets/ holds qf1 ciphertext only`,
      )
      continue
    }

    if (v.type !== 'string') {
      error(`${ctx}: a secret value must have type "string" (a qf1 string), got "${String(v.type)}"`)
      continue
    }

    if (v.confidential !== true) {
      error(`${ctx}: a secret value must set confidential: true`)
    }

    if (Object.hasOwn(v, 'decryptWith')) {
      error(`${ctx}: decryptWith must not appear on a secret value; a qf1 value names its own keyset`)
    }

    checkQf1Value(v.value, ctx, keysets, error)
  }
}

function checkQf1Value(
  value: unknown,
  ctx: string,
  keysets: KeysetRegistry,
  error: (message: string, suggestion?: string) => void,
): void {
  const parsed = parseQf1Keyless(value)
  if (!parsed.ok) {
    error(`${ctx}: qf1 ${parsed.errorClass}: ${parsed.reason}`, `Write secret values with qfg (qfg secret set)`)
    return
  }

  const {fingerprint, keyset} = parsed
  const held = keysets.get(keyset)
  if (!held) {
    error(
      `${ctx}: value is encrypted to keyset ${keyset} fingerprint ${fingerprint}, but keyset ${keyset} is not declared in quonfig.json secrets.keysets`,
      `Declare the keyset in quonfig.json, or re-encrypt the value to a declared keyset`,
    )
    return
  }

  if (!held.has(fingerprint)) {
    error(
      `${ctx}: value is encrypted to keyset ${keyset} fingerprint ${fingerprint}, which is not in quonfig.json secrets.keysets.${keyset}.publicKeys (listed: [${[...held].join(', ')}])`,
      `Pull and re-encrypt the value to the keyset's current key; a retired key cannot be written to`,
    )
  }
}

// ── qf1 values outside secrets/ (spec 11.4, decision 36) ────────────────

const isQf1Prefixed = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as {value?: unknown}).value === 'string' &&
  ((value as {value: string}).value as string).startsWith(QF1_PREFIX)

/**
 * Outside `secrets/`, reject any rule value, weighted-value variant value or
 * top-level `variants[].value` whose value is a string starting `qf1:`.
 */
export function checkNoQf1OutsideSecrets(raw: unknown, file: string, issues: ValidationIssue[]): void {
  const doc = (raw ?? {}) as RawDoc
  const report = (ctx: string) =>
    issues.push({
      file,
      message: `${ctx}: qf1 values belong in secrets/`,
      severity: 'error',
      suggestion: `Store encrypted values as a secret (secrets/<key>.json), not in this document`,
    })

  for (const {ctx, value} of ruleValues(doc)) {
    if (isQf1Prefixed(value)) report(ctx)
    const v = value as {type?: unknown; value?: {weightedValues?: Array<{value?: unknown}>}} | undefined
    if (v?.type === 'weighted_values') {
      for (const [j, entry] of (v.value?.weightedValues ?? []).entries()) {
        if (isQf1Prefixed(entry?.value)) report(`${ctx}.weightedValues[${j}]`)
      }
    }
  }

  for (const [i, variant] of (doc.variants ?? []).entries()) {
    if (isQf1Prefixed(variant?.value)) report(`variants[${i}]`)
  }
}

// ── Duplicate keys: the TEMPORARY configs/ + secrets/ exception ──────────

/**
 * True when a `configs/` document carries an old-format encrypted value: a
 * rule value (default or environment) with `confidential: true` and a
 * non-empty `decryptWith`. Spec 11.6 (c).
 */
export function hasLegacyEncryptedRuleValue(raw: unknown): boolean {
  return ruleValues((raw ?? {}) as RawDoc).some(({value}) => {
    const v = value as {confidential?: unknown; decryptWith?: unknown} | undefined
    return v?.confidential === true && typeof v.decryptWith === 'string' && v.decryptWith.length > 0
  })
}

export type PooledKeyEntry = {dir: string; file: string; key: string; legacyEncrypted?: boolean; type?: string}

/**
 * TEMPORARY EXCEPTION to case-insensitive key pooling (spec 11.6, decision
 * 29). REMOVED BY BEAD qfg-8seuf.20, which deletes the old copies and, in the
 * same change, starts rejecting `decryptWith` everywhere (spec 11.7).
 *
 * A duplicate-key group is allowed only when it is exactly one `configs/`
 * document and one `secrets/` document whose keys are byte-identical (a
 * case-variant pair is still rejected), the `configs/` copy has type
 * "config", and it holds at least one old-format encrypted rule value.
 */
export function isTemporarySecretsDuplicate(group: readonly PooledKeyEntry[]): boolean {
  if (group.length !== 2) return false
  const config = group.find((e) => e.dir === 'configs')
  const secret = group.find((e) => e.dir === 'secrets')
  if (!config || !secret) return false
  return config.key === secret.key && config.type === 'config' && config.legacyEncrypted === true
}
