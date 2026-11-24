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
 * The small-order test is a membership test against the five small-order
 * u-coordinates (no scalar multiplication, same answer under node and bun);
 * test/verify/x25519-oracle.ts proves it equals the spec's X25519 definition.
 *
 * Contract choices of the spec (approved 2026-11-24, Gate A) each live in ONE
 * place, so a later change is local:
 *   - PUBLIC_KEY_PREFIX              spec decision 23 (key entry text form)
 *   - SECRETS_STORAGE_RULES          spec decision 24 (storage restrictions; see
 *                                    its comment for which parts are NOT one-line flips)
 *   - isTemporarySecretsDuplicate    spec 11.6 / decision 29 (removed by qfg-8seuf.20)
 */

/* eslint-disable no-bitwise -- X25519, little-endian byte codecs and bit tests are bitwise by definition */
import {createHash} from 'node:crypto'

import type {ValidationIssue} from './validate.js'

// ── Contract choices (one place each) ────────────────────────────────────

/**
 * Text prefix of a public key entry in `quonfig.json` (spec 6.1).
 * Spec decision 23 (approved): customer-visible and permanent; changing it
 * needs a migration.
 */
export const PUBLIC_KEY_PREFIX = 'qf1-pub-'

/**
 * Storage restrictions beyond what the plan states (spec decision 24,
 * approved).
 *
 * One-line flips (relaxing them is safe as is):
 *   - allowSendToClientSdk
 *   - rejectUnknownManifestMembers
 *
 * NOT one-line flips: `weighted_values` rule values, `provided` rule values
 * and non-empty `variants` in a secret are rejected in validateSecretDocument.
 * Allowing any of them needs new validation of the relaxed shape (every inner
 * value a well-formed qf1 string on a declared keyset with a listed
 * fingerprint; for `provided`, a decision on what a secret may point at), so
 * they deliberately have no switch here.
 */
export const SECRETS_STORAGE_RULES = {
  /** `sendToClientSdk: true` on a secret (false or absent is always fine). */
  allowSendToClientSdk: false,
  /** Reject unknown members inside `secrets` and inside each keyset object. */
  rejectUnknownManifestMembers: true,
} as const

// ── Format constants (spec 2, 3, 6.1) ───────────────────────────────────

/** Spec 2. JS regexes without the `m` flag anchor at the string ends, so `$` never matches before a final LF. */
export const KEYSET_NAME_RE = /^QUONFIG_KEYSET(?:_[\dA-Z]+)*$/
/** Spec 3.1 / 4: exactly 8 lowercase hex characters. */
export const FINGERPRINT_RE = /^[\da-f]{8}$/
const VERSION_PREFIX_RE = /^qf[1-9]\d*:/
const B64URL_RE = /^[\w-]+$/
const QF1_PREFIX = 'qf1:'
const MIN_PAYLOAD_BYTES = 48 // 32-byte ephemeral key + 16-byte tag (empty plaintext)
const PUBLIC_KEY_BODY_CHARS = 43

// ── Small-order points (spec 6.1, decision 37) ─────────────────────────

const P = 2n ** 255n - 19n

function decodeLittleEndian(bytes: Uint8Array): bigint {
  let n = 0n
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i])
  return n
}

/**
 * The u-coordinates (mod p) of every point of small order on Curve25519:
 * 0 (the order-2 point), 1 and p-1 (order 4), and the two
 * order-8 points. Spec 6.1 defines small order as "X25519 with the fixed
 * scalar 0x01 x 32 is all zero", which holds exactly for these u; the test
 * oracle (test/verify/x25519-oracle.ts) checks the equivalence.
 */
const SMALL_ORDER_U = new Set<bigint>([
  0n,
  1n,
  P - 1n,
  325_606_250_916_557_431_795_983_626_356_110_631_294_008_115_727_848_805_560_023_387_167_927_233_504n,
  39_382_357_235_489_614_581_723_060_781_553_021_112_529_911_719_440_698_176_882_885_853_963_445_705_823n,
])

/**
 * True when u is a point of small order (spec 6.1). As X25519 does, the top
 * bit is masked and a non-canonical u (p <= u < 2^255) is reduced mod p, so
 * the encodings p and p+1 count too.
 */
export function isSmallOrder(u: Uint8Array): boolean {
  if (u.length !== 32) throw new Error('isSmallOrder needs a 32-byte u-coordinate')
  const masked = Uint8Array.from(u)
  masked[31] &= 0x7f
  return SMALL_ORDER_U.has(decodeLittleEndian(masked) % P)
}

// ── Encodings (spec 3.4, 4) ─────────────────────────────────────────────

/**
 * Strict canonical unpadded base64url (spec 3.4); undefined when not canonical.
 * Exported for the key-holding qf1 library (src/secrets/qf1.ts), whose
 * private key entries follow the same rule.
 */
export function decodeBase64UrlStrict(text: string): undefined | Uint8Array {
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

/** The error classes spec 3.5 steps 1-6 can decide (no small-order test). */
export type Qf1StructureErrorClass = Exclude<Qf1KeylessErrorClass, 'invalid_ephemeral_key'>

export type Qf1Structure =
  | {
      /** ASCII bytes of `qf1:<keyset>:<fingerprint>:` (spec 5.4). */
      aad: Uint8Array
      /** C || T: the GCM ciphertext followed by the 16-byte tag (spec 3.2). */
      ciphertextAndTag: Uint8Array
      /** E as transmitted (top bit clear; may be non-canonical or of small order). */
      ephemeralPublicKey: Uint8Array
      fingerprint: string
      keyset: string
      ok: true
    }
  | {errorClass: Qf1StructureErrorClass; ok: false; reason: string}

const fail = <C extends Qf1KeylessErrorClass>(errorClass: C, reason: string) => ({
  errorClass,
  ok: false as const,
  reason,
})

/**
 * Characters JSON.stringify leaves raw that a terminal or log viewer acts on:
 * DEL and the C1 controls (U+007F-U+009F, CSI is U+009B), the line and
 * paragraph separators, and the bidi marks, embeddings, overrides and
 * isolates. Lone surrogates are already escaped by JSON.stringify.
 */
const UNSAFE_IN_QUOTE_RE = /[\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/g

/**
 * Quote an untrusted name (for example a keyset name read from a ciphertext)
 * for an error message: truncated to 64 UTF-16 code units, then quoted as
 * JSON with every control, separator and bidi character escaped as \uXXXX
 * (spec 9.2). The one implementation; src/secrets uses it too.
 */
export function quoteUntrustedName(name: string): string {
  return JSON.stringify(name.slice(0, 64)).replaceAll(
    UNSAFE_IN_QUOTE_RE,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`, // eslint-disable-line unicorn/prefer-code-point
  )
}

const quoteName = quoteUntrustedName

/**
 * Spec 3.5 steps 1-7 in the spec's order: the first failing step decides the
 * class. Does NOT test the ephemeral key for small order: a key-holding reader
 * must first report keyset_missing / key_not_held (spec 8 steps 2-3) and only
 * then invalid_ephemeral_key (step 4), and qfg-verify adds the test itself
 * (parseQf1Keyless).
 */
export function parseQf1Structure(value: unknown): Qf1Structure {
  if (typeof value !== 'string') return fail('malformed', 'value is not a string')
  // 1. version
  if (!value.startsWith(QF1_PREFIX)) {
    return VERSION_PREFIX_RE.test(value)
      ? fail('unsupported_version', `version ${quoteName(value.slice(0, value.indexOf(':')))} is not supported`)
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
  // 7. C || T; the header up to its third colon is the AAD (5.4)
  return {
    aad: new Uint8Array(Buffer.from(`${QF1_PREFIX}${keyset}:${fingerprint}:`, 'latin1')),
    ciphertextAndTag: payload.subarray(32),
    ephemeralPublicKey,
    fingerprint,
    keyset,
    ok: true,
  }
}

/**
 * Parse a qf1 value as far as possible without a key, in the spec's order:
 * the first failing step decides the class. Adds the small-order test on the
 * ephemeral key (spec 11.3, decision 37), which a reader reports as
 * `invalid_ephemeral_key`.
 */
export function parseQf1Keyless(value: unknown): Qf1KeylessParse {
  const parsed = parseQf1Structure(value)
  if (!parsed.ok) return parsed
  const {ephemeralPublicKey, fingerprint, keyset} = parsed
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

/** What the secrets checks got from `quonfig.json`. */
export type SecretsManifestRead = {keysets: KeysetRegistry; problem?: undefined} | {keysets: null; problem: string}

/**
 * Read `quonfig.json` text for the secrets keysets. When it is empty, not
 * valid JSON or not a JSON object, the keysets are unknown (`keysets: null`)
 * and `problem` says why; reportUncheckableSecrets reports it. Issues inside
 * a valid `secrets` member are pushed by validateSecretsManifest.
 */
export function readSecretsManifest(text: string, issues: ValidationIssue[]): SecretsManifestRead {
  if (text.trim() === '') return {keysets: null, problem: 'is empty'}
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    return {keysets: null, problem: 'is not valid JSON'}
  }

  if (!isPlainObject(manifest)) return {keysets: null, problem: 'is not a JSON object'}
  return {keysets: validateSecretsManifest(manifest, issues)}
}

/**
 * When `quonfig.json` cannot be read as an object, secret values cannot be
 * checked against `secrets.keysets`. Report that ONCE, on quonfig.json, and
 * only when `secrets/` documents exist, so workspaces without secrets see no
 * change.
 */
export function reportUncheckableSecrets(secretDocCount: number, problem: string, issues: ValidationIssue[]): void {
  if (secretDocCount === 0) return
  issues.push({
    file: 'quonfig.json',
    message: `quonfig.json ${problem}, so secrets/ values cannot be checked against secrets.keysets (${secretDocCount} secrets/ document(s))`,
    severity: 'error',
    suggestion: `Fix quonfig.json; its "secrets.keysets" lists the public keys every secrets/ value must use`,
  })
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
  keysets: KeysetRegistry | null,
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
  // Decision 24; not a one-line flip (see SECRETS_STORAGE_RULES).
  if (variantCount > 0) {
    error(`Secret must not have variants (found ${variantCount})`, `Remove "variants" or set it to []`)
  }

  for (const {ctx, value} of ruleValues(doc)) {
    const v = (value ?? {}) as {confidential?: unknown; decryptWith?: unknown; type?: unknown; value?: unknown}
    // Decision 24; not one-line flips (see SECRETS_STORAGE_RULES).
    if (v.type === 'weighted_values') {
      error(`${ctx}: weighted_values are not allowed in a secret`)
      continue
    }

    if (v.type === 'provided') {
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
  keysets: KeysetRegistry | null,
  error: (message: string, suggestion?: string) => void,
): void {
  const parsed = parseQf1Keyless(value)
  if (!parsed.ok) {
    error(
      `${ctx}: qf1 ${parsed.errorClass}: ${parsed.reason}`,
      `secrets/ values are encrypted by qfg; do not edit them by hand`,
    )
    return
  }

  // quonfig.json could not be parsed: the keyset checks cannot run, and that
  // is reported once, on quonfig.json (reportUncheckableSecrets).
  if (keysets === null) return
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
