/**
 * Per-run key rewriter for `qfg migrate` (qfg-6na9.3).
 *
 * `sanitizePolicyAKey` (key-sanitize.ts) fixes ONE key in isolation. This module
 * turns that into a workspace-consistent map so that:
 *
 *   1. two distinct source keys that sanitize to the same key (`foo bar` and
 *      `foo-bar` -> `foo-bar`), or that collide case-insensitively (`Foo`/`foo`,
 *      which the FS-safety floor hard-rejects), are DISAMBIGUATED deterministically
 *      (`-2`, `-3`, ...) instead of silently clobbering one another; and
 *   2. a key and every by-key REFERENCE to it (a flag's `IN_SEG`/`NOT_IN_SEG`
 *      rule pointing at a segment key) resolve to the SAME final key — so a
 *      renamed segment never leaves a dangling targeting reference.
 *
 * Usage: `resetKeyRewriter()` then `planKeyRewrites(allSourceKeys)` BEFORE
 * translating any change, then `resolveKey(sourceKey)` at every key-definition
 * and reference site. `getKeyRewrites()` drives MIGRATION_REPORT.md + the
 * machine-readable key map.
 *
 * `resolveKey` on a key that was never planned falls back to a pure
 * `sanitizePolicyAKey` (NO disambiguation, NO state mutation) so that direct
 * unit calls to a source's path builders stay referentially transparent.
 */
import {sanitizePolicyAKey} from './key-sanitize.js'

export interface KeyRewrite {
  /** The Policy-A-valid, workspace-unique key it was rewritten to. */
  final: string
  /** Why it changed (sanitize reasons + a disambiguation note when applicable). */
  reasons: string[]
  /** The original source-system key. */
  source: string
}

interface RewriterState {
  /** sourceKey -> resolved rewrite (insertion == planned order). */
  bySource: Map<string, KeyRewrite>
  /** final.toLowerCase() -> owning sourceKey (case-insensitive uniqueness). */
  takenLower: Map<string, string>
}

const state: RewriterState = {bySource: new Map(), takenLower: new Map()}

export function resetKeyRewriter(): void {
  state.bySource = new Map()
  state.takenLower = new Map()
}

/** Find the first case-insensitively-free variant of `base` (base, base-2, ...). */
function disambiguate(base: string): string {
  if (!state.takenLower.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const room = 200 - suffix.length
    const candidate = (base.length > room ? base.slice(0, room) : base) + suffix
    if (!state.takenLower.has(candidate.toLowerCase())) return candidate
  }
}

/**
 * Pre-pass: compute the final key for every source key. Sorted first so the
 * assignment of the un-suffixed base name on a collision is deterministic and
 * independent of the order changes were fetched in.
 */
export function planKeyRewrites(sourceKeys: Iterable<string>): void {
  for (const sourceKey of [...new Set(sourceKeys)].sort()) {
    if (state.bySource.has(sourceKey)) continue
    const san = sanitizePolicyAKey(sourceKey)
    const final = disambiguate(san.key)
    const reasons = [...san.reasons]
    if (final !== san.key) reasons.push('appended a numeric suffix to keep the key unique')
    state.bySource.set(sourceKey, {final, reasons, source: sourceKey})
    state.takenLower.set(final.toLowerCase(), sourceKey)
  }
}

/**
 * The final key for `sourceKey`. Uses the planned map when present, else a pure
 * sanitize (no disambiguation, no mutation) as a safe fallback.
 */
export function resolveKey(sourceKey: string): string {
  const planned = state.bySource.get(sourceKey)
  return planned ? planned.final : sanitizePolicyAKey(sourceKey).key
}

/** Every key that was actually rewritten (conforming keys are omitted). */
export function getKeyRewrites(): KeyRewrite[] {
  return [...state.bySource.values()].filter((r) => r.final !== r.source)
}
