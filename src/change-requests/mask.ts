/**
 * Secret masking for change-request file text (qfg-5bjew.48).
 *
 * `changeRequests.get` returns each changed file's raw before/after text.
 * Nothing is decrypted, but an encrypted value's ciphertext and a
 * confidential value's plaintext are in that text. The web review page masks
 * them (app-quonfig src/lib/domain/change-request-diff/mask.ts), and so does
 * this module, with the same rules:
 *
 * - An encrypted value (an object with a string `decryptWith`) shows its
 *   `value` as `[encrypted]`. On the after side it shows
 *   `[encrypted, changed]` when its ciphertext is not on the before side, so
 *   an untouched secret produces no diff and a changed one shows as changed.
 *   The web page compares the ciphertext at the same JSON path; this compares
 *   it against every ciphertext on the before side. The two differ only for a
 *   secret that moved (here: [encrypted]) or one added at a path the before
 *   side lacks (here: [encrypted, changed]); neither ever shows ciphertext.
 * - Confidential plaintext (`type` is a string, `confidential: true`, no
 *   `decryptWith`, `type` is not `provided`) shows as
 *   `[confidential *****<md5[0:5]>, N chars]`, the audit trail's form.
 * - Text that does not parse as JSON is left as it is, like the web page.
 *
 * The masking edits the text in place, so the line diff keeps the file's own
 * formatting. When that cannot be done safely (for example a confidential
 * value that is not a string), the side is re-serialized from the masked JSON.
 */

import type {ChangeRequestFile} from './types.js'

import {fingerprint} from '../util/redact.js'

export const ENCRYPTED = '[encrypted]'
export const ENCRYPTED_CHANGED = '[encrypted, changed]'

type Obj = Record<string, unknown>

const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const isEncrypted = (v: unknown): v is {decryptWith: string} & Obj => isObject(v) && typeof v.decryptWith === 'string'

const isConfidentialPlaintext = (v: Obj): boolean =>
  typeof v.type === 'string' && 'value' in v && v.confidential === true && !v.decryptWith && v.type !== 'provided'

const plaintextOf = (value: unknown): string => (typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))

/** The web page's `formatConfidential`: `[confidential *****<md5[0:5]>, N chars]`. */
export const confidentialToken = (value: unknown): string => {
  const plaintext = plaintextOf(value)
  return `[confidential ${fingerprint(plaintext)}, ${plaintext.length} chars]`
}

const ciphertextKey = (node: {decryptWith: string} & Obj): string =>
  `${node.decryptWith}\u0000${JSON.stringify(node.value)}`

/** Every encrypted value's (decryptWith, ciphertext) in a parsed document. */
function collectCiphertexts(node: unknown, out: Set<string>): Set<string> {
  if (isEncrypted(node)) {
    out.add(ciphertextKey(node))
  } else if (Array.isArray(node)) {
    for (const item of node) collectCiphertexts(item, out)
  } else if (isObject(node)) {
    for (const v of Object.values(node)) collectCiphertexts(v, out)
  }

  return out
}

/**
 * Masked copy of a parsed document. `before` is the before side's ciphertext
 * set when this is the after side, or undefined for the before side.
 */
function maskNode(node: unknown, before: Set<string> | undefined): unknown {
  if (isEncrypted(node)) {
    const unchanged = before === undefined || before.has(ciphertextKey(node))
    return {...node, value: unchanged ? ENCRYPTED : ENCRYPTED_CHANGED}
  }

  if (Array.isArray(node)) return node.map((item) => maskNode(item, before))
  if (!isObject(node)) return node
  if (isConfidentialPlaintext(node)) return {...node, value: confidentialToken(node.value)}
  const out: Obj = {}
  for (const [k, v] of Object.entries(node)) out[k] = maskNode(v, before)
  return out
}

type Replacement = {literal: string; token: string}

/**
 * The in-place text edits that mask `node`, or undefined when a secret's
 * value is not a string (its JSON text cannot be matched reliably).
 */
function replacements(node: unknown, before: Set<string> | undefined, out: Replacement[]): Replacement[] | undefined {
  if (isEncrypted(node)) {
    if (typeof node.value !== 'string') return undefined
    const unchanged = before === undefined || before.has(ciphertextKey(node))
    out.push({literal: JSON.stringify(node.value), token: unchanged ? ENCRYPTED : ENCRYPTED_CHANGED})
    return out
  }

  if (Array.isArray(node)) {
    for (const item of node) if (!replacements(item, before, out)) return undefined
    return out
  }

  if (!isObject(node)) return out
  if (isConfidentialPlaintext(node)) {
    if (typeof node.value !== 'string') return undefined
    out.push({literal: JSON.stringify(node.value), token: confidentialToken(node.value)})
    return out
  }

  for (const v of Object.values(node)) if (!replacements(v, before, out)) return undefined
  return out
}

const escapeRegExp = (s: string): string => s.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)

/** True when `node` has no ciphertext or confidential plaintext left. */
function fullyMasked(node: unknown): boolean {
  if (isEncrypted(node)) return node.value === ENCRYPTED || node.value === ENCRYPTED_CHANGED
  if (Array.isArray(node)) return node.every((item) => fullyMasked(item))
  if (!isObject(node)) return true
  if (isConfidentialPlaintext(node)) {
    return typeof node.value === 'string' && /^\[confidential \*{5}[\da-f]{5}, \d+ chars]$/.test(node.value)
  }

  return Object.values(node).every((v) => fullyMasked(v))
}

function maskSide(text: string, parsed: unknown, before?: Set<string>): string {
  const edits = replacements(parsed, before, [])
  if (edits && edits.length === 0) return text
  if (edits) {
    let masked = text
    // Only a `"value": <literal>` pair is edited, never a key or another field.
    for (const {literal, token} of edits) {
      masked = masked.replaceAll(
        new RegExp(`("value"\\s*:\\s*)${escapeRegExp(literal)}`, 'g'),
        (_m, head: string) => `${head}${JSON.stringify(token)}`,
      )
    }

    try {
      if (fullyMasked(JSON.parse(masked))) return masked
    } catch {
      // Fall through to the re-serialized form.
    }
  }

  return JSON.stringify(maskNode(parsed, before), null, 2) + '\n'
}

const parse = (text: null | string): {ok: false} | {ok: true; value: unknown} => {
  if (text === null) return {ok: true, value: null}
  try {
    return {ok: true, value: JSON.parse(text)}
  } catch {
    return {ok: false}
  }
}

/** One file with its secrets masked on both sides. */
export function maskFile(file: ChangeRequestFile): ChangeRequestFile {
  const b = parse(file.before)
  const a = parse(file.after)
  // Like the web page: a side that is not JSON leaves the file as it is.
  if (!b.ok || !a.ok) return file
  // An added file has no before side to compare with: every secret is just
  // [encrypted], as on the web page.
  const beforeCiphertexts = file.before === null ? undefined : collectCiphertexts(b.value, new Set())
  return {
    ...file,
    after: file.after === null ? null : maskSide(file.after, a.value, beforeCiphertexts),
    before: file.before === null ? null : maskSide(file.before, b.value),
  }
}

/** Every file masked; null (diff not available) stays null. */
export function maskFiles(files: ChangeRequestFile[] | null): ChangeRequestFile[] | null {
  return files === null ? null : files.map((f) => maskFile(f))
}
