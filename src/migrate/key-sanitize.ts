/**
 * Deterministic single-key Policy A sanitizer for `qfg migrate` (qfg-6na9.3).
 *
 * Migrated keys enter a workspace via `cloneAndStackPush` -> the app-gitea
 * pre-receive `qfg-verify` hook, which hard-rejects FS-floor violations
 * (qfg-6na9.4) and — after the warn->error soak — will hard-reject Policy A
 * charset violations too (qfg-6na9.6). To keep migrations from (a) aborting on
 * a floor violation or (b) seeding a permanently non-conforming key that
 * freezes the customer once .6 flips, we rewrite every imported key so it 100%
 * conforms to Policy A (project/plans/26-06-tighter-naming.md).
 *
 * This function is a PURE, deterministic single-key transform. It preserves as
 * much of the original as possible (case included — Policy A allows mixed case)
 * and is a strict no-op for already-conforming keys, so LaunchDarkly imports
 * (LD keys are already `[A-Za-z0-9._-]`) produce zero rewrites.
 *
 * Cross-key concerns — collisions (two source keys sanitizing to the same key)
 * and case-insensitive uniqueness — are layered on top by the per-run key
 * rewriter (`key-rewriter.ts`), which also drives the report. Keep those
 * concerns OUT of here so this stays trivially testable and referentially
 * transparent (both the key-definition side and the reference side can call it
 * independently and get the same answer).
 */
/* eslint-disable unicorn/better-regex -- keep the explicit [A-Za-z0-9._-] charset
   greppable and byte-for-byte aligned with app-quonfig's PolicyAKeySchema and the
   plan (project/plans/26-06-tighter-naming.md), rather than the equivalent [\w.-]. */
import {createHash} from 'node:crypto'

const RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const POLICY_A_KEY_RE = /^[A-Za-z0-9._-]+$/
const MAX_KEY_LEN = 200

export interface KeySanitizeResult {
  /** True when `key` differs from `raw`. */
  changed: boolean
  /** The Policy-A-valid key (== `raw` when nothing needed changing). */
  key: string
  /** Human-readable list of the transforms that fired (empty when unchanged). */
  reasons: string[]
}

/** First 8 hex chars of sha1(raw) — a stable, collision-resistant suffix. */
function shortHash(raw: string): string {
  return createHash('sha1').update(raw).digest('hex').slice(0, 8)
}

export function sanitizePolicyAKey(raw: string): KeySanitizeResult {
  const reasons: string[] = []
  let k = raw

  // 1. Path separators -> dot. Preserves the dotted-hierarchy intent (a `/` or
  //    `\` in a source key becomes a namespace dot, matching the historical
  //    normalizeKey) rather than a lossy dash.
  if (/[/\\]/.test(k)) {
    k = k.replaceAll(/[/\\]+/g, '.')
    reasons.push('replaced path separators (/ or \\) with "."')
  }

  // 2. Any remaining char outside the Policy A charset -> single dash.
  if (/[^A-Za-z0-9._-]/.test(k)) {
    k = k.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
    reasons.push('replaced disallowed characters with "-"')
  }

  // 3. Trim leading/trailing separators. A leading dot is silently skipped by
  //    the loader/verify; a trailing dot or space is stripped by Windows. A
  //    leading/trailing dash is merely cosmetic but trimmed for tidiness.
  const trimmed = k.replaceAll(/^[.-]+/g, '').replaceAll(/[.-]+$/g, '')
  if (trimmed !== k) {
    k = trimmed
    reasons.push('trimmed leading/trailing separators')
  }

  // 4. Windows reserved device name on the FIRST dot-segment (the segment the
  //    floor checks) -> suffix "_" so `con` -> `con_`, `nul.foo` -> `nul_.foo`.
  const segs = k.split('.')
  if (segs.length > 0 && RESERVED_DEVICE_RE.test(segs[0])) {
    segs[0] = `${segs[0]}_`
    k = segs.join('.')
    reasons.push('escaped Windows reserved device name')
  }

  // 5. The reserved whole-key "new".
  if (k === 'new') {
    k = 'new-key'
    reasons.push('escaped reserved key "new"')
  }

  // 6. Empty after sanitizing (e.g. the source key was all disallowed chars).
  if (k.length === 0) {
    k = `key-${shortHash(raw)}`
    reasons.push('key was empty after sanitizing')
  }

  // 7. Length cap 200 (ASCII-only == byte length). Stable hash suffix keeps two
  //    long keys sharing a 200-char prefix from colliding.
  if (k.length > MAX_KEY_LEN) {
    k = `${k.slice(0, MAX_KEY_LEN - 9)}-${shortHash(raw)}`
    reasons.push(`truncated to ${MAX_KEY_LEN} characters`)
  }

  return {changed: k !== raw, key: k, reasons}
}

/** True when a key already satisfies Policy A (no sanitizing needed). */
export function isPolicyAConformant(key: string): boolean {
  return !sanitizePolicyAKey(key).changed
}

export {POLICY_A_KEY_RE}
