import {createHash} from 'node:crypto'

/**
 * Shared secret-redaction helper (qfg-38lp). Every CLI path that would show a
 * secret (or `confidential`) value goes through here instead of printing the
 * plaintext. Plaintext is only ever printed by `qfg get --reveal`.
 */

const FINGERPRINT_PREFIX = '*****'

/** Plaintext shorter than this never has its tail shown. */
export const LAST4_MIN_LENGTH = 12

export type RedactedSummary = {
  /** true for `decryptWith` values, false for confidential-only values */
  encrypted: boolean
  /** `*****<first 5 hex of md5>` — absent only before the value is encrypted */
  fingerprint?: string
  /** last 4 chars of the plaintext, only when the plaintext is >= 12 chars */
  last4?: string
  /** plaintext length — absent only when the plaintext is not known */
  length?: number
  redacted: true
}

/**
 * The SDK telemetry fingerprint: `*****` + the first 5 hex chars of the md5.
 * Identical to sdk-node resolver.ts makeConfidential (and sdk-ruby), so the
 * value the CLI shows matches what telemetry and the UI report.
 */
export const fingerprint = (value: string): string =>
  `${FINGERPRINT_PREFIX}${createHash('md5').update(value).digest('hex').slice(0, 5)}`

/**
 * Build the redacted summary for a value.
 *
 * - `ciphertext` given: an encrypted value. Like the SDK resolver, the
 *   fingerprint hashes the CIPHERTEXT (that is what telemetry sees).
 * - `encrypted: true` without ciphertext: about to be encrypted (e.g. a confirm
 *   prompt before the write) — no fingerprint yet.
 * - neither: a confidential-but-unencrypted value; the fingerprint hashes the
 *   plaintext, again matching the SDK.
 *
 * `plaintext` may be omitted when it is not known (e.g. ciphertext that could
 * not be decrypted); length and last4 are then left out.
 */
export const redactedSummary = ({
  ciphertext,
  encrypted,
  plaintext,
}: {
  ciphertext?: string
  encrypted?: boolean
  plaintext?: string
}): RedactedSummary => {
  const isEncrypted = ciphertext !== undefined || encrypted === true
  const hashed = ciphertext ?? (isEncrypted ? undefined : plaintext)

  const summary: RedactedSummary = {encrypted: isEncrypted, redacted: true}

  if (hashed !== undefined) summary.fingerprint = fingerprint(hashed)
  if (plaintext !== undefined) summary.length = plaintext.length
  if (plaintext !== undefined && plaintext.length >= LAST4_MIN_LENGTH) summary.last4 = plaintext.slice(-4)

  return summary
}

/**
 * One-line human display, e.g.
 *   [encrypted *****3fa9c, 51 chars, ends …a1b2]
 *   [encrypted, 10 chars]                 (before encryption, no fingerprint)
 *   [confidential *****1c2d3, 10 chars]
 */
export const redactedDisplay = (summary: RedactedSummary): string => {
  const label = summary.encrypted ? 'encrypted' : 'confidential'
  const head = summary.fingerprint ? `${label} ${summary.fingerprint}` : label
  const parts = [head]
  if (typeof summary.length === 'number') parts.push(`${summary.length} chars`)
  if (summary.last4) parts.push(`ends …${summary.last4}`)
  return `[${parts.join(', ')}]`
}

type Json = unknown

/**
 * Deep-copy a stored config document, replacing the plaintext of every
 * confidential-but-UNencrypted rule value with its redacted display. Encrypted
 * values (`decryptWith`) are ciphertext and are left as they are.
 */
export const scrubConfidentialValues = <T>(doc: T): T => {
  const walk = (node: Json): Json => {
    if (Array.isArray(node)) return node.map((item) => walk(item))
    if (node === null || typeof node !== 'object') return node

    const record = node as Record<string, Json>
    const out: Record<string, Json> = {}
    for (const [k, v] of Object.entries(record)) out[k] = walk(v)

    if (record.confidential === true && !record.decryptWith && record.value !== undefined && record.value !== null) {
      const plaintext = typeof record.value === 'string' ? record.value : JSON.stringify(record.value)
      out.value = redactedDisplay(redactedSummary({plaintext}))
    }

    return out
  }

  return walk(doc) as T
}

/**
 * Scrub anything headed for a --verbose / debug log line (qfg-38lp): objects
 * are deep-scrubbed, and a string that is itself JSON (e.g. a pre-stringified
 * request body) is parsed, scrubbed and re-serialised.
 */
export const scrubForLog = (message: unknown): unknown => {
  if (typeof message === 'string') {
    const trimmed = message.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return message
    try {
      return JSON.stringify(scrubConfidentialValues(JSON.parse(trimmed)), null, 2)
    } catch {
      return message
    }
  }

  return scrubConfidentialValues(message)
}
