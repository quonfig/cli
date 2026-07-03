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
  /**
   * sourceKey -> final persisted by a PREVIOUS run (.qf/key-plan.json). These
   * are authoritative: a delta run replans over only the subset of changes it
   * fetched, so previously-mapped keys must keep their persisted finals and
   * new keys must disambiguate around them — otherwise a key that resolved to
   * `my-flag-2` in the full run resolves to `my-flag` in the delta and
   * silently overwrites a different flag's file.
   */
  persisted: Map<string, string>
  /** final.toLowerCase() -> owning sourceKey (case-insensitive uniqueness). */
  takenLower: Map<string, string>
}

const state: RewriterState = {bySource: new Map(), persisted: new Map(), takenLower: new Map()}

export function resetKeyRewriter(): void {
  state.bySource = new Map()
  state.persisted = new Map()
  state.takenLower = new Map()
}

/**
 * Seed the rewriter with the complete source->final map persisted by previous
 * runs. Every persisted final is immediately marked taken (case-insensitively)
 * so keys planned later this run can never claim one. Call after
 * `resetKeyRewriter()` and before `planKeyRewrites()` — `planKeyRewritesForChanges`
 * does this ordering for you.
 */
export function seedPersistedKeyPlan(keys: Readonly<Record<string, string>>): void {
  for (const [sourceKey, final] of Object.entries(keys)) {
    state.persisted.set(sourceKey, final)
    state.takenLower.set(final.toLowerCase(), sourceKey)
  }
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

/** Disambiguate `base`, record the mapping, and mark the final taken. */
function assignFinal(sourceKey: string, base: string, sanitizeReasons: string[]): void {
  const final = disambiguate(base)
  const reasons = [...sanitizeReasons]
  if (final !== base) reasons.push('appended a numeric suffix to keep the key unique')
  state.bySource.set(sourceKey, {final, reasons, source: sourceKey})
  state.takenLower.set(final.toLowerCase(), sourceKey)
}

/**
 * Pre-pass: compute the final key for every source key. Three passes, each
 * sorted so every assignment is deterministic and independent of the order
 * changes were fetched in:
 *
 *   0. Keys mapped by a PREVIOUS run keep their persisted final verbatim (see
 *      `seedPersistedKeyPlan`) — full and delta runs must resolve identically.
 *   1. Keys that are ALREADY fully valid (sanitize is an identity: they pass
 *      Policy A and the FS-floor) claim their own names FIRST and are never
 *      renamed to make room for sanitized junk — customer code calling
 *      get("my-flag") must keep resolving to the same flag even when a source
 *      key like "my flag" sanitizes to the same name. If two VALID keys
 *      collide case-insensitively ("Foo"/"foo" — a genuine source conflict the
 *      FS-floor hard-rejects), the lexicographically-first one keeps its name
 *      and the other is suffixed.
 *   2. Keys that needed sanitizing then disambiguate AROUND the valid ones
 *      (-2, -3, ...).
 */
export function planKeyRewrites(sourceKeys: Iterable<string>): void {
  const fresh = [...new Set(sourceKeys)].sort().filter((k) => !state.bySource.has(k))

  // Pass 0: previously-mapped keys resolve to their persisted final, always.
  const unpersisted: string[] = []
  for (const sourceKey of fresh) {
    const persistedFinal = state.persisted.get(sourceKey)
    if (persistedFinal === undefined) {
      unpersisted.push(sourceKey)
      continue
    }

    const sanitized = sanitizePolicyAKey(sourceKey)
    const reasons =
      persistedFinal === sanitized.key
        ? [...sanitized.reasons]
        : [...sanitized.reasons, 'kept the key assigned by a previous import run']
    state.bySource.set(sourceKey, {final: persistedFinal, reasons, source: sourceKey})
    state.takenLower.set(persistedFinal.toLowerCase(), sourceKey)
  }

  // Pass 1: already-valid keys claim their own names.
  const needsSanitizing: Array<{sanitized: ReturnType<typeof sanitizePolicyAKey>; sourceKey: string}> = []
  for (const sourceKey of unpersisted) {
    const sanitized = sanitizePolicyAKey(sourceKey)
    if (sanitized.changed) {
      needsSanitizing.push({sanitized, sourceKey})
    } else {
      assignFinal(sourceKey, sourceKey, [])
    }
  }

  // Pass 2: sanitized keys disambiguate around them.
  for (const {sanitized, sourceKey} of needsSanitizing) {
    assignFinal(sourceKey, sanitized.key, sanitized.reasons)
  }
}

/**
 * The final key for `sourceKey`. Uses the planned map when present, then the
 * PERSISTED map (a delta run's flag can reference a segment that was migrated
 * in the full run but is absent from the delta's change set), else a pure
 * sanitize (no disambiguation, no mutation) as a safe fallback.
 */
export function resolveKey(sourceKey: string): string {
  const planned = state.bySource.get(sourceKey)
  if (planned) return planned.final
  const persisted = state.persisted.get(sourceKey)
  if (persisted !== undefined) return persisted
  return sanitizePolicyAKey(sourceKey).key
}

/** Every key that was actually rewritten (conforming keys are omitted). */
export function getKeyRewrites(): KeyRewrite[] {
  return [...state.bySource.values()].filter((r) => r.final !== r.source)
}

/**
 * The COMPLETE source->final map to persist to `.qf/key-plan.json`: every key
 * planned this run (unchanged ones included) merged over everything persisted
 * by previous runs, sorted by source key for stable on-disk diffs.
 */
export function getFullKeyPlan(): Record<string, string> {
  const merged = new Map(state.persisted)
  for (const [source, rewrite] of state.bySource) merged.set(source, rewrite.final)
  const out: Record<string, string> = {}
  for (const source of [...merged.keys()].sort()) out[source] = merged.get(source)!
  return out
}

/**
 * Run-level pre-pass: reset the rewriter, seed the persisted plan from any
 * previous run, and plan every source key BEFORE any change is translated, so
 * both key-definition and by-key reference sites resolve against the same
 * fully-disambiguated map. Structurally typed on `{key?}` to stay decoupled
 * from LegacyChange.
 */
export function planKeyRewritesForChanges(
  changes: ReadonlyArray<{key?: string}>,
  persistedKeys?: Readonly<Record<string, string>>,
): void {
  resetKeyRewriter()
  if (persistedKeys) seedPersistedKeyPlan(persistedKeys)
  planKeyRewrites(changes.flatMap((c) => (typeof c.key === 'string' ? [c.key] : [])))
}

/**
 * `--strict-keys` escape hatch: refuse to migrate if any source key would need
 * rewriting, so a customer who requires byte-identical keys can clean up the
 * source first instead of accepting the (reported) rewrites.
 */
export class StrictKeysError extends Error {
  constructor(public readonly rewrites: KeyRewrite[]) {
    super(
      `--strict-keys: ${rewrites.length} source key(s) do not conform to Policy A and would be rewritten:\n` +
        rewrites.map((r) => `  "${r.source}" -> "${r.final}" (${r.reasons.join('; ')})`).join('\n') +
        `\nRename the key(s) in the source system and re-run, or drop --strict-keys to accept the rewrites.`,
    )
    this.name = 'StrictKeysError'
  }
}

/**
 * Plan the rewrites for a run and, when `strict`, throw `StrictKeysError` if any
 * key would be rewritten. Call once at the top of each migrate orchestrator
 * before translating. `persistedKeys` (from `readKeyPlan`) makes previously
 * mapped keys resolve exactly as they did on the run that mapped them.
 */
export function preflightKeyRewrites(
  changes: ReadonlyArray<{key?: string}>,
  opts?: {persistedKeys?: Readonly<Record<string, string>>; strict?: boolean},
): void {
  planKeyRewritesForChanges(changes, opts?.persistedKeys)
  if (opts?.strict) {
    const rewrites = getKeyRewrites()
    if (rewrites.length > 0) throw new StrictKeysError(rewrites)
  }
}
