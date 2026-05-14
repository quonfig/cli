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

import {ConversionReport} from '../quonfig-target/report.js'
import {type LegacyChange, type MigrationSource, type QuonfigFile, type SkippedConfigSummary} from '../source.js'
import {fetchProjectEnvironments, fetchSnapshot} from './launchdarkly/api.js'
import {flagOutputPath, segmentOutputPath, translateFlag, translateSegment} from './launchdarkly/translate.js'
import type {LDFlag, LDSegment} from './launchdarkly/types.js'

const SOURCE_NAME = 'launchdarkly'

/** Raw payload carried on each LegacyChange — discriminated by `kind`. */
type LaunchDarklyRaw = {data: LDFlag; kind: 'flag'} | {data: LDSegment; kind: 'segment'}

interface LaunchDarklyState {
  apiKey: null | string
  /** Environment keys from the last snapshot, slug-normalized for listEnvironments(). */
  environments: string[]
  projectKey: string
  /** Conversion notes collected across all translate() calls in a run. */
  report: ConversionReport
}

/**
 * LaunchDarkly requires a project key on every endpoint. v1 reads it from
 * `LAUNCHDARKLY_PROJECT_KEY` (default `default`); a `--project` flag is part
 * of the write-mode wiring epic.
 */
function resolveProjectKey(): string {
  return process.env.LAUNCHDARKLY_PROJECT_KEY ?? 'default'
}

const state: LaunchDarklyState = {
  apiKey: null,
  environments: [],
  projectKey: resolveProjectKey(),
  report: new ConversionReport(),
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
  await fetchProjectEnvironments(apiKey, state.projectKey)
  state.apiKey = apiKey
  state.report = new ConversionReport()
  state.environments = []
}

async function listEnvironmentsImpl(): Promise<string[]> {
  const apiKey = requireApiKey('listEnvironments')
  const envKeys = await fetchProjectEnvironments(apiKey, state.projectKey)
  state.environments = envKeys.map((k) => slugifyEnvKey(k))
  return [...new Set(state.environments)]
}

/**
 * Phase-1 config snapshot. Decision D2: always a full re-snapshot — we do not
 * trust the LaunchDarkly audit-log cursor for delta correctness. `sinceEpochMs`
 * still feeds the framework's "what changed since last run" reporting, but the
 * fetch itself is unconditional. Every flag and segment is yielded as one
 * `LegacyChange`; the converter runs in `translate()`.
 */
async function* fetchChangesImpl(): AsyncIterable<LegacyChange> {
  const apiKey = requireApiKey('fetchChanges')
  const snapshot = await fetchSnapshot(apiKey, state.projectKey)
  state.environments = snapshot.environments.map((k) => slugifyEnvKey(k))

  for (const flag of snapshot.flags) {
    yield {key: flag.key, raw: {data: flag, kind: 'flag'} satisfies LaunchDarklyRaw, source: SOURCE_NAME}
  }

  for (const segment of snapshot.segments) {
    yield {key: segment.key, raw: {data: segment, kind: 'segment'} satisfies LaunchDarklyRaw, source: SOURCE_NAME}
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

export const launchdarklySource: MigrationSource = {
  fetchChanges(): AsyncIterable<LegacyChange> {
    return fetchChangesImpl()
  },
  getSkippedConfigs: getSkippedConfigsImpl,
  listEnvironments: listEnvironmentsImpl,
  name: SOURCE_NAME,
  translate: translateImpl,
  validateAuth: validateAuthImpl,
}

export function __resetLaunchDarklySourceForTests(): void {
  state.apiKey = null
  state.environments = []
  state.projectKey = resolveProjectKey()
  state.report = new ConversionReport()
}
