/**
 * `qfg migrate --from flagsmith` — the MigrationSource implementation.
 *
 * Wires the Flagsmith fetcher (`flagsmith/api.ts` + `flagsmith/types.ts`) and
 * converter (`flagsmith/translate.ts`) into the source-agnostic migration
 * framework. Epic 1 implemented the read side (validateAuth, listEnvironments,
 * fetchChanges yielding LegacyChange[] carrying raw Flagsmith JSON); Epic 3
 * adds the translate() side — `translateFeature` and `translateSegment`
 * dispatched by `raw.kind` (see `FlagsmithRaw` below). Report accumulators
 * (`getSkippedConfigs`, `getCoercedSentinels`, `getConversionNotes`) thread
 * the per-source notes into MIGRATION_REPORT.md.
 *
 * Design is frozen in `project/plans/migrator-flagsmith.md`. Notable choices
 * for this epic — the contract Epic 3 will consume:
 *
 * - `LegacyChange.raw` is a discriminated union over `{kind: 'feature' | 'segment'}`.
 *   Features carry the full per-feature stitched bundle (env-default +
 *   segment-overrides + identity-overrides + feature-segment priority +
 *   inline MV options sorted by id asc). Segments are emitted separately
 *   (project-scoped, referenced from multiple features).
 *
 * - Tags are NOT separate LegacyChanges — they're inline `feature.tags[]` as
 *   integer IDs, plus a project-wide tag pool stashed in the source state for
 *   the converter to resolve id → label.
 *
 * - Edge identities are NOT separate LegacyChanges. Identity overrides are
 *   bundled inside the feature payload (`identity_overrides`); the identity
 *   `identifier` is already on each override row. Traits are runtime context
 *   the SDK sends — no server-side artifact to migrate (plan §5.5, D-F6).
 *
 * - Project metadata (`use_edge_identities`, `only_allow_lower_case_feature_names`,
 *   …) is captured during `validateAuth` and stashed in source state. The
 *   converter can read it via `getProjectMetadata()` (a Flagsmith-specific
 *   getter, not part of the MigrationSource interface).
 */

import {type ConversionNote, ConversionReport} from '../quonfig-target/report.js'
import {
  type CoercedSentinelSummary,
  type DroppedOverrideSummary,
  type EnvironmentMapEntry,
  type LegacyChange,
  type MigrationSource,
  type QuonfigFile,
  type SkippedConfigSummary,
} from '../source.js'
import {fetchProject, fetchSnapshot} from './flagsmith/api.js'
import {flagOutputPath, segmentOutputPath, translateFeature, translateSegment} from './flagsmith/translate.js'
import type {
  FlagsmithEnvironment,
  FlagsmithFeatureWithStates,
  FlagsmithProject,
  FlagsmithSegment,
  FlagsmithSegmentRule,
  FlagsmithTag,
} from './flagsmith/types.js'

const SOURCE_NAME = 'flagsmith'
const DEFAULT_PROJECT_ID = '1'

/**
 * Raw payload carried on each LegacyChange — discriminated by `kind`. Epic 3's
 * `translate()` switches on this to dispatch to the right shape converter.
 */
export type FlagsmithRaw =
  | {data: FlagsmithFeatureWithStates; kind: 'feature'}
  | {data: FlagsmithSegment; kind: 'segment'}

interface FlagsmithState {
  apiKey: null | string
  /** Environments in API order, captured during validateAuth / listEnvironments. */
  environments: FlagsmithEnvironment[]
  /** The project record from `/projects/{id}/`; carries `use_edge_identities`, etc. */
  project: FlagsmithProject | null
  projectId: string
  report: ConversionReport
  /** Project-scoped segment pool from the last snapshot — converter looks up id → name. */
  segments: FlagsmithSegment[]
  /** Tag pool — populated on first snapshot fetch so converter can resolve ID → label. */
  tags: FlagsmithTag[]
}

function resolveProjectId(): string {
  return process.env.FLAGSMITH_PROJECT_ID ?? DEFAULT_PROJECT_ID
}

const state: FlagsmithState = {
  apiKey: null,
  environments: [],
  project: null,
  projectId: resolveProjectId(),
  report: new ConversionReport(),
  segments: [],
  tags: [],
}

/**
 * Override the Flagsmith project ID for this run. Called by `qfg migrate` from
 * its `--project` flag (or the `FLAGSMITH_PROJECT_ID` env var) — mirrors
 * `setLaunchDarklyProjectKey`. Flagsmith projects are numeric, but we accept
 * either a number or a numeric-string and convert at the API boundary.
 */
export function setFlagsmithProjectId(projectId: number | string): void {
  state.projectId = String(projectId)
}

/** The project metadata captured by validateAuth, or null if we haven't authed yet. */
export function getFlagsmithProject(): FlagsmithProject | null {
  return state.project
}

/** The tag pool from the last snapshot — Epic 3's converter resolves `feature.tags[]` IDs to labels via this. */
export function getFlagsmithTagPool(): FlagsmithTag[] {
  return [...state.tags]
}

class MissingAuthError extends Error {
  constructor(operation: string) {
    super(`flagsmith source ${operation} requires validateAuth(apiKey) to be called first (no API key configured).`)
    this.name = 'MissingAuthError'
  }
}

function requireApiKey(operation: string): string {
  if (!state.apiKey) throw new MissingAuthError(operation)
  return state.apiKey
}

/** Flagsmith env api_keys are random strings; we surface env `name` slugified. */
function slugifyEnvName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

async function validateAuthImpl(apiKey: string): Promise<void> {
  // The cheapest authenticated probe is the project endpoint — 401s on a bad
  // token, 404s on a bad project, and we need `use_edge_identities` for the
  // snapshot walk anyway, so capture it here.
  const project = await fetchProject(apiKey, state.projectId)
  state.apiKey = apiKey
  state.project = project
  state.report = new ConversionReport()
  state.environments = []
  state.segments = []
  state.tags = []
}

async function listEnvironmentsImpl(): Promise<string[]> {
  const apiKey = requireApiKey('listEnvironments')
  // We could do a dedicated fetchEnvironments call here, but fetchSnapshot
  // will do that as part of fetchChanges anyway. To keep listEnvironments
  // cheap (called by the migrate command before fetchChanges), we do a
  // standalone env fetch and stash the results — fetchSnapshot will refresh
  // them when it runs.
  const {fetchEnvironments} = await import('./flagsmith/api.js')
  const envs = await fetchEnvironments(apiKey, state.projectId)
  state.environments = envs
  return [...new Set(envs.map((e) => slugifyEnvName(e.name)))]
}

/**
 * Phase-1 config snapshot. Decision D2: always a full re-snapshot — we do not
 * try to use Flagsmith's audit log for deltas (cursor stability across v2
 * versioning rewrites is unverified). `sinceEpochMs` is currently unused;
 * Epic 5 will use it for reporting "what changed since last run" without
 * affecting the fetch itself.
 *
 * Yields one LegacyChange per feature (with the full per-env state bundle)
 * followed by one LegacyChange per segment. Identity overrides are bundled
 * inside the feature payload.
 */
async function* fetchChangesImpl(): AsyncIterable<LegacyChange> {
  const apiKey = requireApiKey('fetchChanges')
  const snapshot = await fetchSnapshot(apiKey, state.projectId)
  state.project = snapshot.project
  state.environments = snapshot.environments
  state.segments = snapshot.segments
  state.tags = snapshot.tags

  for (const featureBundle of snapshot.features) {
    yield {
      key: featureBundle.feature.name,
      raw: {data: featureBundle, kind: 'feature'} satisfies FlagsmithRaw,
      source: SOURCE_NAME,
    }
  }

  for (const segment of snapshot.segments) {
    yield {
      key: segment.name,
      raw: {data: segment, kind: 'segment'} satisfies FlagsmithRaw,
      source: SOURCE_NAME,
    }
  }
}

/**
 * Dispatch by raw.kind to the right translator (plan §5.1). Last-resort
 * safety net mirrors the LD source — one structurally broken feature must
 * not abort the whole run, so conversion errors land as `skipped-config`
 * report entries and translate returns `[]`.
 */
function translateImpl(change: LegacyChange): QuonfigFile[] {
  const raw = change.raw as FlagsmithRaw | undefined
  if (!raw || typeof raw !== 'object' || !('kind' in raw)) return []

  try {
    if (raw.kind === 'feature') {
      const segmentNameById = new Map<number, string>()
      for (const seg of state.segments) segmentNameById.set(seg.id, seg.name)

      const envNameByApiKey = new Map<string, string>()
      for (const env of state.environments) envNameByApiKey.set(env.api_key, env.name)

      const out = translateFeature(raw.data, state.report, {
        envNameByApiKey,
        segmentNameById,
        tags: state.tags,
      })
      return [{contents: JSON.stringify(out, null, 2), path: flagOutputPath(raw.data.feature.name)}]
    }

    const out = translateSegment(raw.data, state.report)
    return [{contents: JSON.stringify(out, null, 2), path: segmentOutputPath(raw.data.name)}]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    state.report.add('skipped-config', change.key ?? 'unknown', `conversion failed: ${message}`)
    return []
  }
}

/** Configs that could not be converted at all (matches LD `getSkippedConfigs`). */
function getSkippedConfigsImpl(): null | SkippedConfigSummary {
  const skipped = state.report.byCategory('skipped-config')
  if (skipped.length === 0) return null
  return {
    entries: skipped.map((n) => ({key: n.key, reason: n.detail})),
    total: skipped.length,
  }
}

/**
 * Per-flag rule-value coercions Flagsmith forced — every `enabled-false-non-boolean`
 * + `cross-env-value-type-coerced` note is counted here so the existing
 * "rule values were coerced" rollup in MIGRATION_REPORT.md surfaces them.
 *
 * The bookkeeping is per-Quonfig-env (the env-name the customer sees in the
 * report and in the file tree). D-F1 notes carry `env "<api_key>"` in their
 * detail string from `translate.ts`; we regex it out and map api_key →
 * slugified env name via the captured environments. Notes that don't carry an
 * env reference (cross-env D-F5; rare malformed details) bucket under a
 * synthetic `_cross-env` key so they still surface but are visually distinct.
 */
function getCoercedSentinelsImpl(): CoercedSentinelSummary | null {
  const enabledFalse = state.report.byCategory('enabled-false-non-boolean')
  const crossEnv = state.report.byCategory('cross-env-value-type-coerced')
  if (enabledFalse.length === 0 && crossEnv.length === 0) return null

  const envSlugByApiKey = new Map<string, string>()
  for (const env of state.environments) envSlugByApiKey.set(env.api_key, slugifyEnvName(env.name))

  const byEnv: Record<string, Record<string, number>> = {}
  let total = 0

  const addToEnv = (envKey: string, outputPath: string): void => {
    const env = byEnv[envKey] ?? {}
    env[outputPath] = (env[outputPath] ?? 0) + 1
    byEnv[envKey] = env
    total += 1
  }

  // D-F1: detail strings look like `... in env "<api_key>" ...` (env-default
  // path), `... identity override "<id>" ...`, or `... segment override "<name>" ...`.
  // Only the env-default flavor includes an api_key; the override flavors are
  // implicitly all-envs (they fire once per override row, which is always tied
  // to an env, but the detail doesn't surface it). For override rows the
  // bucketing reflects what we can know: "all envs" (`_all-envs`).
  for (const note of enabledFalse) {
    const path = flagOutputPath(note.key)
    const match = /env "([^"]+)"/.exec(note.detail)
    if (match) {
      const apiKey = match[1]
      const slug = envSlugByApiKey.get(apiKey) ?? apiKey
      addToEnv(slug, path)
    } else {
      // identity/segment override rows: surface under a synthetic bucket so
      // the section still names the flag even when env attribution is lossy.
      addToEnv('_all-envs', path)
    }
  }

  // D-F5: cross-env divergence is a feature-wide finding — coerce target is
  // string regardless of which env disagreed. Surface under a distinct bucket
  // so the renderer doesn't show "0 from N envs" double-counting.
  for (const note of crossEnv) {
    addToEnv('_cross-env', flagOutputPath(note.key))
  }

  return {byEnv, total}
}

/**
 * Currently no override sections are dropped due to env-id mismatch — Flagsmith
 * has no equivalent of the Launch-source's archived/missing env case. Kept
 * present so the report machinery's null-check still wires through.
 */
function getDroppedOverridesImpl(): DroppedOverrideSummary | null {
  return null
}

/** The full conversion report — every skip/drop/coerce note from this run. */
export function getConversionReport(): ConversionReport {
  return state.report
}

/**
 * Walk every segment rule (recursively across nested `rules[]`) and collect
 * every `condition.property` reference. These are the trait/context attribute
 * names that downstream Quonfig callers will need to send at eval time
 * (plan §5.5 / D-F6). The `'user.key'` Quonfig built-in is excluded — it's the
 * caller-identity slot that's already required for any flag eval.
 */
function collectIdentityTraits(): Map<string, string[]> {
  const traitToSegments = new Map<string, Set<string>>()

  const visitRule = (rule: FlagsmithSegmentRule, segmentName: string): void => {
    for (const cond of rule.conditions ?? []) {
      const prop = cond.property
      if (!prop || prop.length === 0) continue
      if (prop === 'user.key') continue
      const set = traitToSegments.get(prop) ?? new Set<string>()
      set.add(segmentName)
      traitToSegments.set(prop, set)
    }

    for (const child of rule.rules ?? []) visitRule(child, segmentName)
  }

  for (const segment of state.segments) {
    for (const rule of segment.rules ?? []) visitRule(rule, segment.name)
  }

  const sorted = new Map<string, string[]>()
  for (const [trait, segs] of [...traitToSegments.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    sorted.set(
      trait,
      [...segs].sort((a, b) => a.localeCompare(b)),
    )
  }

  return sorted
}

function getConversionNotesImpl(): ConversionNote[] | null {
  // Convert raw report notes — translate.ts embeds env api_keys in its
  // detail strings; substitute them with the slugified user-facing env name
  // so the report is readable to anyone who hasn't memorized Flagsmith's
  // 22-character env api_keys. No-op when the api_key isn't in the env map.
  const envSlugByApiKey = new Map<string, string>()
  for (const env of state.environments) envSlugByApiKey.set(env.api_key, slugifyEnvName(env.name))

  const decorate = (detail: string): string => {
    let out = detail.replaceAll(/env "([^"]+)"/g, (full, apiKey: string) => {
      const slug = envSlugByApiKey.get(apiKey)
      return slug ? `env "${slug}"` : full
    })
    // Cross-env divergence details list api_keys directly as `apk=type` pairs
    // (e.g. `Qr6Q...=int, iwz7...=string`) without surrounding quotes. Decode
    // every known api_key in the detail to its slugified name.
    for (const [apiKey, slug] of envSlugByApiKey) {
      if (apiKey === slug) continue
      out = out.replaceAll(apiKey, slug)
    }

    return out
  }

  const notes: ConversionNote[] = state.report.all().map((n) => ({...n, detail: decorate(n.detail)}))

  // Identity-trait references — pure FYI, no action required server-side, but
  // every trait must be sent by the SDK caller at eval time or matching rules
  // will silently miss. Plan §5.5 / D-F6.
  const traitMap = collectIdentityTraits()
  for (const [trait, segments] of traitMap) {
    notes.push({
      category: 'identity-traits-referenced',
      detail:
        segments.length === 1
          ? `referenced by segment "${segments[0]}" — your SDK callers must send this attribute on the evaluation context`
          : `referenced by ${segments.length} segments (${segments.slice(0, 3).join(', ')}${
              segments.length > 3 ? ', …' : ''
            }) — your SDK callers must send this attribute on the evaluation context`,
      key: trait,
    })
  }

  return notes.length === 0 ? null : notes
}

function getEnvironmentMapImpl(): EnvironmentMapEntry[] | null {
  if (state.environments.length === 0) return null
  const seen = new Set<string>()
  const entries: EnvironmentMapEntry[] = []
  for (const env of state.environments) {
    const quonfigName = slugifyEnvName(env.name)
    if (seen.has(quonfigName)) continue
    seen.add(quonfigName)
    entries.push({quonfigName, sourceName: env.name})
  }

  return entries.length === 0 ? null : entries
}

export const flagsmithSource: MigrationSource = {
  fetchChanges(): AsyncIterable<LegacyChange> {
    return fetchChangesImpl()
  },
  getCoercedSentinels: getCoercedSentinelsImpl,
  getConversionNotes: getConversionNotesImpl,
  getDroppedOverrides: getDroppedOverridesImpl,
  getEnvironmentMap: getEnvironmentMapImpl,
  getSkippedConfigs: getSkippedConfigsImpl,
  listEnvironments: listEnvironmentsImpl,
  name: SOURCE_NAME,
  translate: translateImpl,
  validateAuth: validateAuthImpl,
}

export function __resetFlagsmithSourceForTests(): void {
  state.apiKey = null
  state.environments = []
  state.project = null
  state.projectId = resolveProjectId()
  state.report = new ConversionReport()
  state.segments = []
  state.tags = []
}
