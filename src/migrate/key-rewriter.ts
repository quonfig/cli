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

/**
 * qfg-hbuy.10: source-side key namespaces. LaunchDarkly flags and segments are
 * SEPARATE key namespaces, so a project can legitimately carry a flag and a
 * segment with the same source key. Quonfig keys are globally unique across
 * type trees, so the two need distinct finals: the flag (default namespace)
 * keeps the clean name and the segment is deterministically suffixed
 * `-segment`. Everything that isn't a segment plans in `default`.
 */
export type KeyNamespace = 'default' | 'segment'

/**
 * The complete persisted key plan (.qf/key-plan.json): the default-namespace
 * map plus the segment-namespace map. `segmentKeys` only carries segments that
 * COLLIDED with a default-namespace key and were suffixed — a lone segment
 * plans in the default flow and stays in `keys`, exactly as before
 * qfg-hbuy.10, so existing version-1 plans keep resolving unchanged.
 */
export interface KeyPlanData {
  keys: Record<string, string>
  segmentKeys: Record<string, string>
}

interface RewriterState {
  /** sourceKey -> resolved rewrite, default namespace (insertion == planned order). */
  bySource: Map<string, KeyRewrite>
  /** sourceKey -> resolved rewrite for namespace-suffixed SEGMENTS (qfg-hbuy.10). */
  bySourceSegment: Map<string, KeyRewrite>
  /**
   * sourceKey -> final persisted by a PREVIOUS run (.qf/key-plan.json). These
   * are authoritative: a delta run replans over only the subset of changes it
   * fetched, so previously-mapped keys must keep their persisted finals and
   * new keys must disambiguate around them — otherwise a key that resolved to
   * `my-flag-2` in the full run resolves to `my-flag` in the delta and
   * silently overwrites a different flag's file.
   */
  persisted: Map<string, string>
  /** Segment-namespace analog of `persisted` (qfg-hbuy.10). */
  persistedSegment: Map<string, string>
  /** final.toLowerCase() -> owning sourceKey (case-insensitive uniqueness). */
  takenLower: Map<string, string>
}

const state: RewriterState = {
  bySource: new Map(),
  bySourceSegment: new Map(),
  persisted: new Map(),
  persistedSegment: new Map(),
  takenLower: new Map(),
}

export function resetKeyRewriter(): void {
  state.bySource = new Map()
  state.bySourceSegment = new Map()
  state.persisted = new Map()
  state.persistedSegment = new Map()
  state.takenLower = new Map()
}

/**
 * Seed the rewriter with the complete source->final maps persisted by previous
 * runs. Every persisted final is immediately marked taken (case-insensitively)
 * so keys planned later this run can never claim one. Call after
 * `resetKeyRewriter()` and before `planKeyRewrites()` — `planKeyRewritesForChanges`
 * does this ordering for you.
 */
export function seedPersistedKeyPlan(plan: Readonly<KeyPlanData>): void {
  for (const [sourceKey, final] of Object.entries(plan.keys)) {
    state.persisted.set(sourceKey, final)
    state.takenLower.set(final.toLowerCase(), sourceKey)
  }

  for (const [sourceKey, final] of Object.entries(plan.segmentKeys)) {
    state.persistedSegment.set(sourceKey, final)
    state.takenLower.set(final.toLowerCase(), sourceKey)
  }
}

/** Append `suffix` to `base`, truncating `base` so the result stays <= 200 chars. */
function withSuffix(base: string, suffix: string): string {
  const room = 200 - suffix.length
  return (base.length > room ? base.slice(0, room) : base) + suffix
}

/** Find the first case-insensitively-free variant of `base` (base, base-2, ...). */
function disambiguate(base: string): string {
  if (!state.takenLower.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) {
    const candidate = withSuffix(base, `-${n}`)
    if (!state.takenLower.has(candidate.toLowerCase())) return candidate
  }
}

/** Disambiguate `base`, record the mapping in `map`, and mark the final taken. */
function assignFinal(map: Map<string, KeyRewrite>, sourceKey: string, base: string, sanitizeReasons: string[]): void {
  const final = disambiguate(base)
  const reasons = [...sanitizeReasons]
  if (final !== base) reasons.push('appended a numeric suffix to keep the key unique')
  map.set(sourceKey, {final, reasons, source: sourceKey})
  state.takenLower.set(final.toLowerCase(), sourceKey)
}

/**
 * Pre-pass: compute the final key for every source key. Sorted passes so every
 * assignment is deterministic and independent of the order changes were
 * fetched in:
 *
 *   0. Keys mapped by a PREVIOUS run keep their persisted final verbatim (see
 *      `seedPersistedKeyPlan`) — full and delta runs must resolve identically.
 *      Applies to both namespaces.
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
 *   3. qfg-hbuy.10: SEGMENTS whose source key is also claimed by the default
 *      namespace this run (an LD flag and segment sharing one key) get the
 *      deterministic `-segment` suffix, disambiguating around every name
 *      assigned above — a suffixed segment can never steal a different valid
 *      key's name. Segments with no such collision plan in the default flow
 *      (passes 0-2) and keep their clean names.
 */
export function planKeyRewrites(sourceKeys: Iterable<string>, segmentSourceKeys: Iterable<string> = []): void {
  const defaultKeys = [...new Set(sourceKeys)]
  const freshSegments = [...new Set(segmentSourceKeys)].sort().filter((k) => !state.bySourceSegment.has(k))

  // Split segment keys: only a segment whose source key is ALSO claimed by the
  // default namespace this run — or that a previous run already namespaced
  // (sticky, so re-runs stay stable) — needs its own namespace. Everything
  // else plans in the default flow, exactly as before qfg-hbuy.10.
  const defaultKeySet = new Set([...defaultKeys, ...state.bySource.keys()])
  const scopedSegments = freshSegments.filter((k) => state.persistedSegment.has(k) || defaultKeySet.has(k))
  const plainSegments = freshSegments.filter((k) => !state.persistedSegment.has(k) && !defaultKeySet.has(k))

  const fresh = [...new Set([...defaultKeys, ...plainSegments])].sort().filter((k) => !state.bySource.has(k))

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

  // Pass 0 (segment namespace): persisted segment mappings are just as
  // authoritative — record them so the report and full plan carry them.
  const unpersistedSegments: string[] = []
  for (const sourceKey of scopedSegments) {
    const persistedFinal = state.persistedSegment.get(sourceKey)
    if (persistedFinal === undefined) {
      unpersistedSegments.push(sourceKey)
      continue
    }

    state.bySourceSegment.set(sourceKey, {
      final: persistedFinal,
      reasons: ['kept the segment key assigned by a previous import run'],
      source: sourceKey,
    })
    state.takenLower.set(persistedFinal.toLowerCase(), sourceKey)
  }

  // Pass 1: already-valid keys claim their own names.
  const needsSanitizing: Array<{sanitized: ReturnType<typeof sanitizePolicyAKey>; sourceKey: string}> = []
  for (const sourceKey of unpersisted) {
    const sanitized = sanitizePolicyAKey(sourceKey)
    if (sanitized.changed) {
      needsSanitizing.push({sanitized, sourceKey})
    } else {
      assignFinal(state.bySource, sourceKey, sourceKey, [])
    }
  }

  // Pass 2: sanitized keys disambiguate around them.
  for (const {sanitized, sourceKey} of needsSanitizing) {
    assignFinal(state.bySource, sourceKey, sanitized.key, sanitized.reasons)
  }

  // Pass 3 (qfg-hbuy.10): colliding segments take the '-segment' suffix,
  // disambiguating around every name assigned above.
  for (const sourceKey of unpersistedSegments) {
    const sanitized = sanitizePolicyAKey(sourceKey)
    const base = withSuffix(sanitized.key, '-segment')
    const reasons = [
      ...sanitized.reasons,
      `suffixed "-segment": a feature flag in this import shares the source key "${sourceKey}"`,
    ]
    assignFinal(state.bySourceSegment, sourceKey, base, reasons)
  }
}

/**
 * The final key for `sourceKey`. Uses the planned map when present, then the
 * PERSISTED map (a delta run's flag can reference a segment that was migrated
 * in the full run but is absent from the delta's change set), else a pure
 * sanitize (no disambiguation, no mutation) as a safe fallback.
 *
 * Segment definitions and by-key segment references (IN_SEG/NOT_IN_SEG) pass
 * `namespace: 'segment'`: the segment-namespace maps are consulted first, then
 * resolution falls back to the default namespace — a segment that never
 * collided with a flag plans in the default flow and lives there.
 */
export function resolveKey(sourceKey: string, namespace: KeyNamespace = 'default'): string {
  if (namespace === 'segment') {
    const plannedSegment = state.bySourceSegment.get(sourceKey)
    if (plannedSegment) return plannedSegment.final
    const persistedSegment = state.persistedSegment.get(sourceKey)
    if (persistedSegment !== undefined) return persistedSegment
  }

  const planned = state.bySource.get(sourceKey)
  if (planned) return planned.final
  const persisted = state.persisted.get(sourceKey)
  if (persisted !== undefined) return persisted
  return sanitizePolicyAKey(sourceKey).key
}

/** Every key that was actually rewritten (conforming keys are omitted). */
export function getKeyRewrites(): KeyRewrite[] {
  return [...state.bySource.values(), ...state.bySourceSegment.values()].filter((r) => r.final !== r.source)
}

/**
 * The COMPLETE source->final maps to persist to `.qf/key-plan.json`: every key
 * planned this run (unchanged ones included) merged over everything persisted
 * by previous runs, sorted by source key for stable on-disk diffs.
 */
export function getFullKeyPlan(): KeyPlanData {
  const sortMerged = (persisted: Map<string, string>, planned: Map<string, KeyRewrite>): Record<string, string> => {
    const merged = new Map(persisted)
    for (const [source, rewrite] of planned) merged.set(source, rewrite.final)
    const out: Record<string, string> = {}
    for (const source of [...merged.keys()].sort()) out[source] = merged.get(source)!
    return out
  }

  return {
    keys: sortMerged(state.persisted, state.bySource),
    segmentKeys: sortMerged(state.persistedSegment, state.bySourceSegment),
  }
}

/**
 * Run-level pre-pass: reset the rewriter, seed the persisted plan from any
 * previous run, and plan every source key BEFORE any change is translated, so
 * both key-definition and by-key reference sites resolve against the same
 * fully-disambiguated map. Structurally typed on `{key?, keyNamespace?}` to
 * stay decoupled from LegacyChange.
 */
export function planKeyRewritesForChanges(
  changes: ReadonlyArray<{key?: string; keyNamespace?: string}>,
  persistedKeys?: Readonly<KeyPlanData>,
): void {
  resetKeyRewriter()
  if (persistedKeys) seedPersistedKeyPlan(persistedKeys)
  const defaultKeys: string[] = []
  const segmentKeys: string[] = []
  for (const change of changes) {
    if (typeof change.key !== 'string') continue
    if (change.keyNamespace === 'segment') segmentKeys.push(change.key)
    else defaultKeys.push(change.key)
  }

  planKeyRewrites(defaultKeys, segmentKeys)
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
  changes: ReadonlyArray<{key?: string; keyNamespace?: string}>,
  opts?: {persistedKeys?: Readonly<KeyPlanData>; strict?: boolean},
): void {
  planKeyRewritesForChanges(changes, opts?.persistedKeys)
  if (opts?.strict) {
    const rewrites = getKeyRewrites()
    if (rewrites.length > 0) throw new StrictKeysError(rewrites)
  }
}
