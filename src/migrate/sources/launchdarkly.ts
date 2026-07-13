/**
 * `qfg migrate --from launchdarkly` — the MigrationSource implementation.
 *
 * Wires the LaunchDarkly fetcher (`launchdarkly/api.ts`) and converter
 * (`launchdarkly/translate.ts`) into the source-agnostic migration framework.
 * Both write modes (`--dir`, `--push`) are inherited for free — this source
 * only has to produce `QuonfigFile[]`.
 *
 * Design is frozen in `launchdarkly.README.md` / `project/plans/migrator-launch-darkly.md`.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {type ConversionNote, ConversionReport} from '../quonfig-target/report.js'
import {
  type CommitMeta,
  type EnvironmentMapEntry,
  type LegacyChange,
  type MigrationSource,
  type QuonfigFile,
  type SkippedConfigSummary,
} from '../source.js'
import {
  fetchMembers,
  fetchProjectEnvironments,
  fetchProjectEnvironmentsDetailed,
  fetchSegmentsForEnv,
  fetchSnapshot,
} from './launchdarkly/api.js'
import {
  type LaunchDarklyFlagAuditRaw,
  type RetentionHorizon,
  auditEntryToLegacyChange,
  buildFlagAuditSpec,
  getCommitMetaForAuditEntry,
  probeRetentionHorizon,
  walkAuditLog,
} from './launchdarkly/audit.js'
import {flagOutputPath, segmentOutputPath, translateFlag, translateSegment} from './launchdarkly/translate.js'
import type {LDFlag, LDSegment} from './launchdarkly/types.js'

const SOURCE_NAME = 'launchdarkly'

/**
 * Resume cursor for a crashed Phase-2 walk. Lives in `os.tmpdir()` keyed by
 * project key — NOT inside the target workspace, because `--push` mode requires
 * the local clone dir to be empty before cloning (and a checkpoint sitting in
 * `.qf/` would clobber that). OS-tmpdir is fine for in-session crash recovery;
 * cross-reboot recovery is out of scope for this walker.
 */
function auditCheckpointFilename(projectKey: string): string {
  const safeKey = projectKey.replaceAll(/[^\w.-]+/g, '_')
  return `qfg-ld-audit-${safeKey}.json`
}

/**
 * Raw payload carried on each LegacyChange — discriminated by `kind`. The flag
 * variant may additionally carry a Phase-2 `auditEntry` (see
 * `LaunchDarklyFlagAuditRaw`); `translate()` ignores it, `getCommitMeta()` reads
 * it to reify the original author/date/message.
 */
type LaunchDarklyRaw = {data: LDFlag; kind: 'flag'} | {data: LDSegment; kind: 'segment'} | LaunchDarklyFlagAuditRaw

interface LaunchDarklyState {
  apiKey: null | string
  /**
   * qfg-1t7m: source-side `{key, name}` pairs from the most recent
   * fetchProjectEnvironments call. Surfaced as the report's "Environment mapping
   * table" via getEnvironmentMap() — preserves the user-facing LD env display
   * name that bare keys lose.
   */
  environmentSourceNames: Array<{key: string; name: string}>
  /** Environment keys from the last snapshot, slug-normalized for listEnvironments(). */
  environments: string[]
  /** `--full-summary` — when true, fetchChanges walks the Phase-2 audit log. */
  fullSummary: boolean
  /**
   * qfg-l8uz: account-wide `maintainerId → email` map fetched once during
   * validateAuth via `/members`. Null when the call failed or the API token
   * lacks member-read permission — translate() and the report renderer must
   * tolerate that.
   */
  maintainerMap: null | Record<string, string>
  projectKey: string
  /** Conversion notes collected across all translate() calls in a run. */
  report: ConversionReport
  /** Result of the up-front retention pre-flight; null until full-summary validateAuth runs. */
  retentionHorizon: null | RetentionHorizon
}

/**
 * LaunchDarkly requires a project key on every endpoint. The env var
 * `LAUNCHDARKLY_PROJECT_KEY` (default `default`) is the module-load fallback;
 * the `qfg migrate` command overrides it per-run via `setLaunchDarklyProjectKey()`
 * from its `--project` flag (Epic 5 write-mode wiring).
 */
function resolveProjectKey(): string {
  return process.env.LAUNCHDARKLY_PROJECT_KEY ?? 'default'
}

const state: LaunchDarklyState = {
  apiKey: null,
  environments: [],
  environmentSourceNames: [],
  fullSummary: false,
  maintainerMap: null,
  projectKey: resolveProjectKey(),
  report: new ConversionReport(),
  retentionHorizon: null,
}

/**
 * Override the LaunchDarkly project key for this run. Called by the `qfg migrate`
 * command from its `--project` flag (which itself falls back to the
 * `LAUNCHDARKLY_PROJECT_KEY` env var). Mirrors `applyLaunchDarklyBaseUrl()` —
 * the command layer threads run-scoped config into the source singleton.
 */
export function setLaunchDarklyProjectKey(projectKey: string): void {
  state.projectKey = projectKey
}

/**
 * Enable Phase-2 history backfill for this run. When set, `fetchChanges` walks
 * the LaunchDarkly audit log instead of taking a current-state snapshot, and
 * `validateAuth` runs the retention pre-flight. Called by `qfg migrate` from
 * its `--full-summary` flag.
 */
export function setLaunchDarklyFullSummary(on: boolean): void {
  state.fullSummary = on
}

/**
 * The retention pre-flight result from the last full-summary `validateAuth`,
 * or null. The command reads this and tells the user the real history horizon
 * BEFORE the slow audit walk starts (plan §4.1.1).
 */
export function getLaunchDarklyRetentionHorizon(): null | RetentionHorizon {
  return state.retentionHorizon
}

class MissingAuthError extends Error {
  constructor(operation: string) {
    super(`launchdarkly source ${operation} requires validateAuth(apiKey) to be called first (no API key configured).`)
    this.name = 'MissingAuthError'
  }
}

function requireApiKey(operation: string): string {
  if (!state.apiKey) throw new MissingAuthError(operation)
  return state.apiKey
}

function slugifyEnvKey(key: string): string {
  return key
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

async function validateAuthImpl(apiKey: string): Promise<void> {
  // A cheap authenticated call — 401s on a bad token, 404s on a bad project.
  // Use the detailed call so we can stash {key, name} for the report's env
  // mapping table (qfg-1t7m) without a second round-trip.
  const detailed = await fetchProjectEnvironmentsDetailed(apiKey, state.projectKey)
  state.apiKey = apiKey
  state.report = new ConversionReport()
  state.environments = []
  state.environmentSourceNames = detailed
  state.retentionHorizon = null
  state.maintainerMap = null

  // Plan §4.1.1: under --full-summary, probe the audit-log retention window
  // here — the earliest authenticated hook — so the command can tell the user
  // the real history horizon BEFORE the slow Phase-2 walk starts. The walk can
  // take hours; nobody should wait that long expecting two years and silently
  // get thirty days.
  if (state.fullSummary) {
    state.retentionHorizon = await probeRetentionHorizon(apiKey, {spec: buildFlagAuditSpec(state.projectKey)})
  }
}

/**
 * qfg-l8uz: best-effort `/members` lookup so MIGRATION_REPORT.md can render
 * `maintainerId → email`. Project-scoped tokens or accounts that hide member
 * data will 403 here — that's fine, the migration must not fail just because
 * the rollup loses a label. Returns null on any error, the empty map when the
 * endpoint returns no members, and a stripped map otherwise (members without
 * an email are skipped — we have nothing useful to render for them).
 */
async function loadMaintainerMap(apiKey: string): Promise<null | Record<string, string>> {
  try {
    const members = await fetchMembers(apiKey)
    const map: Record<string, string> = {}
    for (const member of members) {
      if (member.email) map[member._id] = member.email
    }

    return map
  } catch {
    return null
  }
}

async function listEnvironmentsImpl(): Promise<string[]> {
  const apiKey = requireApiKey('listEnvironments')
  const detailed = await fetchProjectEnvironmentsDetailed(apiKey, state.projectKey)
  state.environmentSourceNames = detailed
  state.environments = detailed.map((e) => slugifyEnvKey(e.key))
  return [...new Set(state.environments)]
}

/**
 * Phase-1 config snapshot. Decision D2: always a full re-snapshot — we do not
 * trust the LaunchDarkly audit-log cursor for delta correctness. `sinceEpochMs`
 * still feeds the framework's "what changed since last run" reporting, but the
 * fetch itself is unconditional. Every flag and segment is yielded as one
 * `LegacyChange`; the converter runs in `translate()`.
 *
 * Under `--full-summary` this delegates to the Phase-2 audit-log walk instead.
 */
async function* fetchChangesImpl(): AsyncIterable<LegacyChange> {
  const apiKey = requireApiKey('fetchChanges')

  // qfg-l8uz: load the account-wide member directory once so the report can
  // render maintainerId → email pairs. Deliberately best-effort — a failed
  // call (project-scoped token, hidden member data) just leaves the rollup
  // showing opaque hex IDs.
  state.maintainerMap = await loadMaintainerMap(apiKey)

  if (state.fullSummary) {
    yield* fetchAuditHistory(apiKey)
    return
  }

  const snapshot = await fetchSnapshot(apiKey, state.projectKey)
  state.environments = snapshot.environments.map((k) => slugifyEnvKey(k))

  for (const flag of snapshot.flags) {
    yield {key: flag.key, raw: {data: flag, kind: 'flag'} satisfies LaunchDarklyRaw, source: SOURCE_NAME}
  }

  for (const segment of snapshot.segments) {
    // qfg-hbuy.10: LD segments are their own key namespace — tag them so the
    // key rewriter can disambiguate a flag and a segment sharing one key.
    yield {
      key: segment.key,
      keyNamespace: 'segment',
      raw: {data: segment, kind: 'segment'} satisfies LaunchDarklyRaw,
      source: SOURCE_NAME,
    }
  }
}

/** Path to this run's audit-walk resume cursor (always under os.tmpdir; see filename comment). */
function auditCheckpointPath(): string {
  return path.join(os.tmpdir(), auditCheckpointFilename(state.projectKey))
}

/** Read the persisted `before` cursor from a crashed walk, or undefined if none. */
function readAuditCheckpoint(checkpointPath: string): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as {before?: unknown}
    return typeof parsed.before === 'number' ? parsed.before : undefined
  } catch {
    // No checkpoint (fresh run) or an unreadable one — start from newest.
    return undefined
  }
}

function writeAuditCheckpoint(checkpointPath: string, before: number): void {
  fs.writeFileSync(checkpointPath, JSON.stringify({before}, null, 2) + '\n', 'utf8')
}

/**
 * Phase-2 history backfill (`--full-summary`). Walks the LaunchDarkly audit log
 * newest-to-oldest, reifying each flag change into a `LegacyChange` that carries
 * both the point-in-time flag snapshot (for `translate()`) and the originating
 * audit entry (for `getCommitMeta()`). The walk is checkpointed to an os.tmpdir
 * file so a crashed multi-hour run resumes instead of restarting; the
 * checkpoint is cleared once the walk completes.
 *
 * The audit log is flag-scoped (plan §4.1), so current-state segments are still
 * re-snapshotted and appended — `--full-summary` must not silently drop them.
 * Flag changes are emitted oldest-first so the write paths build chronological
 * git history.
 */
async function* fetchAuditHistory(apiKey: string): AsyncIterable<LegacyChange> {
  const spec = buildFlagAuditSpec(state.projectKey)
  const checkpointPath = auditCheckpointPath()
  const startBefore = readAuditCheckpoint(checkpointPath)

  // The audit log is newest-first; collect then reverse so changes commit in
  // chronological order.
  const flagChanges: LegacyChange[] = []
  for await (const entry of walkAuditLog(apiKey, {
    spec,
    ...(startBefore === undefined ? {} : {startBefore}),
    onCheckpoint(before: number) {
      writeAuditCheckpoint(checkpointPath, before)
    },
  })) {
    const change = auditEntryToLegacyChange(entry)
    if (change) flagChanges.push(change)
  }

  // Walk finished cleanly — drop the resume cursor so a later run starts fresh.
  if (fs.existsSync(checkpointPath)) fs.rmSync(checkpointPath)

  flagChanges.reverse()
  for (const change of flagChanges) yield change

  // Re-snapshot current-state segments (flag-scoped audit log can't carry them).
  const envKeys = await fetchProjectEnvironments(apiKey, state.projectKey)
  state.environments = envKeys.map((k) => slugifyEnvKey(k))
  const segmentsByKey = new Map<string, LDSegment>()
  for (const envKey of envKeys) {
    // eslint-disable-next-line no-await-in-loop
    const segs = await fetchSegmentsForEnv(apiKey, state.projectKey, envKey)
    for (const seg of segs) {
      if (!segmentsByKey.has(seg.key)) segmentsByKey.set(seg.key, seg)
    }
  }

  for (const segment of segmentsByKey.values()) {
    // qfg-hbuy.10: see the matching tag in fetchChangesImpl.
    yield {
      key: segment.key,
      keyNamespace: 'segment',
      raw: {data: segment, kind: 'segment'} satisfies LaunchDarklyRaw,
      source: SOURCE_NAME,
    }
  }
}

function translateImpl(change: LegacyChange): QuonfigFile[] {
  const raw = change.raw as LaunchDarklyRaw | undefined
  if (!raw || typeof raw !== 'object' || !('kind' in raw)) return []

  try {
    if (raw.kind === 'flag') {
      const out = translateFlag(raw.data, state.report)
      return [{contents: JSON.stringify(out, null, 2), path: flagOutputPath(raw.data.key)}]
    }

    const out = translateSegment(raw.data, state.report)
    return [{contents: JSON.stringify(out, null, 2), path: segmentOutputPath(raw.data.key)}]
  } catch (error) {
    // Last-resort safety net: one structurally broken flag/segment must not
    // abort the whole run. Record it and keep going (plan §5.4 — nothing silent).
    const message = error instanceof Error ? error.message : String(error)
    state.report.add('skipped-config', change.key ?? 'unknown', `conversion failed: ${message}`)
    return []
  }
}

/**
 * Configs that could not be converted at all. Partial-conversion notes
 * (dropped prerequisites, re-bucketed rollouts, etc.) live on the full
 * `ConversionReport` — see `getConversionReport()` — and are wired into the
 * lossy/unsupported sections of `MIGRATION_REPORT.md` by the write-mode epic.
 */
function getSkippedConfigsImpl(): null | SkippedConfigSummary {
  const skipped = state.report.byCategory('skipped-config')
  if (skipped.length === 0) return null
  return {
    entries: skipped.map((n) => ({key: n.key, reason: n.detail})),
    total: skipped.length,
  }
}

/** The full conversion report — every skip/drop/coerce note from this run. */
export function getConversionReport(): ConversionReport {
  return state.report
}

/**
 * qfg-l8uz: maintainerId → email map produced by `/members` during
 * validateAuth, or null when the call failed (project-scoped token, account
 * hides members, etc.). The report renderer surfaces this as a sub-table on
 * `## Identifier map` and decorates `dropped-maintainer` rollups so a reader
 * sees real emails alongside the opaque hex IDs.
 */
function getMaintainerMapImpl(): null | Record<string, string> {
  if (state.maintainerMap === null) return null
  return Object.keys(state.maintainerMap).length === 0 ? null : {...state.maintainerMap}
}

/**
 * qfg-1t7m: source-name → Quonfig-name pairs for the report's "Environment
 * mapping table". The source name is LD's user-facing env display name; the
 * Quonfig name is the slugified env key. De-duped on the slugified key — two
 * source envs that collapse to the same slug get one row (the first wins),
 * since that is the row that will exist in quonfig.json.
 */
function getEnvironmentMapImpl(): EnvironmentMapEntry[] | null {
  if (state.environmentSourceNames.length === 0) return null
  const seen = new Set<string>()
  const entries: EnvironmentMapEntry[] = []
  for (const env of state.environmentSourceNames) {
    const quonfigName = slugifyEnvKey(env.key)
    if (seen.has(quonfigName)) continue
    seen.add(quonfigName)
    entries.push({quonfigName, sourceName: env.name})
  }

  return entries.length === 0 ? null : entries
}

/**
 * Every structured conversion note from this run — re-bucketed rollouts,
 * dropped prerequisites, lossy individual-target conversions, etc. The write
 * paths (`local-write.ts` / `push-to-cloud.ts`) thread this into
 * `MIGRATION_REPORT.md`'s "Users will be re-bucketed" + "Conversion notes"
 * sections (plan §5.4 — nothing is silently dropped). `skipped-config` notes
 * are included here too; the report renderer routes them to their own
 * dedicated section.
 */
function getConversionNotesImpl(): ConversionNote[] | null {
  const notes = state.report.all()
  return notes.length === 0 ? null : notes
}

/**
 * Per-change commit metadata for `--full-summary` (plan §7). Reifies the
 * original LaunchDarkly member, timestamp and description from the audit entry
 * carried on the change's `raw` payload. Returns null for current-state changes
 * (segments, or a flag with no `auditEntry`) so the write paths fall back to
 * the migrator identity.
 */
function getCommitMetaImpl(change: LegacyChange): CommitMeta | null {
  const raw = change.raw as LaunchDarklyRaw | undefined
  if (!raw || typeof raw !== 'object' || !('auditEntry' in raw)) return null
  return getCommitMetaForAuditEntry(raw.auditEntry)
}

export const launchdarklySource: MigrationSource = {
  fetchChanges(): AsyncIterable<LegacyChange> {
    return fetchChangesImpl()
  },
  getCommitMeta: getCommitMetaImpl,
  getConversionNotes: getConversionNotesImpl,
  getEnvironmentMap: getEnvironmentMapImpl,
  getMaintainerMap: getMaintainerMapImpl,
  getSkippedConfigs: getSkippedConfigsImpl,
  listEnvironments: listEnvironmentsImpl,
  name: SOURCE_NAME,
  translate: translateImpl,
  validateAuth: validateAuthImpl,
}

export function __resetLaunchDarklySourceForTests(): void {
  state.apiKey = null
  state.environments = []
  state.environmentSourceNames = []
  state.fullSummary = false
  state.maintainerMap = null
  state.projectKey = resolveProjectKey()
  state.report = new ConversionReport()
  state.retentionHorizon = null

  // Clear any stray checkpoint from a previous test's resumability assertion.
  try {
    const cp = auditCheckpointPath()
    if (fs.existsSync(cp)) fs.rmSync(cp)
  } catch {
    /* best-effort */
  }
}
