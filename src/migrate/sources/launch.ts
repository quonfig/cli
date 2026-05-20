import {
  type CoercedSentinelSummary,
  type CommitMeta,
  type DroppedOverrideSummary,
  type LegacyChange,
  type MigrationSource,
  type QuonfigFile,
  type SkippedConfigEntry,
  type SkippedConfigSummary,
} from '../source.js'
import {fetchAllChangeHistory, fetchEnvironments} from './launch/api.js'
import {
  InvalidSourceConfigError,
  getOutputPath,
  isLegacyLogLevel,
  slugify,
  transformConfig,
} from './launch/translate.js'
import type {LaunchChangeEntry} from './launch/types.js'

const SOURCE_NAME = 'launch'

interface LaunchState {
  apiKey: null | string
  coercedSentinels: Map<string, Map<string, number>>
  droppedOverrides: Map<string, Map<string, number>>
  envIdMap: null | Record<string, string>
  skippedConfigs: SkippedConfigEntry[]
}

const state: LaunchState = {
  apiKey: null,
  coercedSentinels: new Map(),
  droppedOverrides: new Map(),
  envIdMap: null,
  skippedConfigs: [],
}

class MissingAuthError extends Error {
  constructor(operation: string) {
    super(`launch source ${operation} requires validateAuth(apiKey) to be called first (no API key configured).`)
    this.name = 'MissingAuthError'
  }
}

function requireApiKey(operation: string): string {
  if (!state.apiKey) throw new MissingAuthError(operation)
  return state.apiKey
}

async function* fetchChangesImpl(
  sinceEpochMs: null | number,
  onProgress?: (fetched: number) => void,
): AsyncIterable<LegacyChange> {
  const apiKey = requireApiKey('fetchChanges')
  const since = sinceEpochMs === null ? undefined : sinceEpochMs
  const changes = await fetchAllChangeHistory(apiKey, since, onProgress)

  for (const change of changes) {
    yield {
      changedAt: change.changedAt,
      key: change.key,
      raw: change,
      source: SOURCE_NAME,
    }
  }
}

async function listEnvironmentsImpl(): Promise<string[]> {
  const apiKey = requireApiKey('listEnvironments')
  const rawEnvIdMap = await fetchEnvironments(apiKey)

  const envIdMap: Record<string, string> = {}
  for (const [id, name] of Object.entries(rawEnvIdMap)) {
    envIdMap[id] = slugify(name)
  }

  state.envIdMap = envIdMap
  return [...new Set(Object.values(envIdMap))]
}

function translateImpl(change: LegacyChange): QuonfigFile[] {
  const raw = change.raw as LaunchChangeEntry | undefined
  if (!raw || typeof raw !== 'object') return []

  if (typeof raw.type === 'string' && isLegacyLogLevel(raw.type)) return []

  if (raw.deleted) {
    return [{deleted: true, path: getOutputPath(raw.type, raw.key)}]
  }

  if (!raw.newConfig) return []

  const envIdMap = state.envIdMap ?? {}
  const outputPath = getOutputPath(raw.type, raw.key)
  let transformed: Record<string, unknown>
  try {
    transformed = transformConfig(
      raw.newConfig,
      envIdMap,
      (envId) => {
        let perFlag = state.droppedOverrides.get(envId)
        if (!perFlag) {
          perFlag = new Map<string, number>()
          state.droppedOverrides.set(envId, perFlag)
        }

        perFlag.set(outputPath, (perFlag.get(outputPath) ?? 0) + 1)
      },
      (envId) => {
        let perFlag = state.coercedSentinels.get(envId)
        if (!perFlag) {
          perFlag = new Map<string, number>()
          state.coercedSentinels.set(envId, perFlag)
        }

        perFlag.set(outputPath, (perFlag.get(outputPath) ?? 0) + 1)
      },
    )
  } catch (error) {
    if (error instanceof InvalidSourceConfigError) {
      state.skippedConfigs.push({key: raw.key, reason: error.message})
      return []
    }

    throw error
  }

  return [{contents: JSON.stringify(transformed, null, 2), path: outputPath}]
}

function getCommitMetaImpl(change: LegacyChange): CommitMeta | null {
  const raw = change.raw as LaunchChangeEntry | undefined
  if (!raw || typeof raw !== 'object') return null
  if (!raw.changedBy || typeof raw.changedAt !== 'number') return null

  const email = raw.changedBy.email
  const name = raw.changedBy.fullName ?? raw.changedBy.email
  // qfg-wbkj: empirically a large fraction of Launch history entries carry no
  // human-authored summary. Fall back to a stable, key-aware message instead
  // of an empty commit body so `git log feature-flags/<key>.json` is still
  // readable when scrolled through.
  const trimmed = raw.summary?.trim()
  const message = trimmed && trimmed.length > 0 ? raw.summary! : buildFallbackMessage(raw)

  return {author: {email, name}, date: raw.changedAt, message}
}

function buildFallbackMessage(raw: LaunchChangeEntry): string {
  const verb = raw.deleted ? 'delete' : raw.previousConfigId === undefined ? 'create' : 'update'
  return `migrator: ${verb} ${raw.key}`
}

function getDroppedOverridesImpl(): DroppedOverrideSummary | null {
  if (state.droppedOverrides.size === 0) return null
  const byEnv: Record<string, Record<string, number>> = {}
  let total = 0
  for (const envId of [...state.droppedOverrides.keys()].sort()) {
    const perFlag = state.droppedOverrides.get(envId)!
    const record: Record<string, number> = {}
    for (const [flagPath, count] of [...perFlag.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      record[flagPath] = count
      total += count
    }

    byEnv[envId] = record
  }

  return {byEnv, total}
}

function getCoercedSentinelsImpl(): CoercedSentinelSummary | null {
  if (state.coercedSentinels.size === 0) return null
  const byEnv: Record<string, Record<string, number>> = {}
  let total = 0
  for (const envId of [...state.coercedSentinels.keys()].sort()) {
    const perFlag = state.coercedSentinels.get(envId)!
    const record: Record<string, number> = {}
    for (const [flagPath, count] of [...perFlag.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      record[flagPath] = count
      total += count
    }

    byEnv[envId] = record
  }

  return {byEnv, total}
}

function getSkippedConfigsImpl(): SkippedConfigSummary | null {
  if (state.skippedConfigs.length === 0) return null
  return {entries: [...state.skippedConfigs], total: state.skippedConfigs.length}
}

async function validateAuthImpl(apiKey: string): Promise<void> {
  await fetchEnvironments(apiKey)
  state.apiKey = apiKey
  state.droppedOverrides = new Map()
  state.skippedConfigs = []
  state.coercedSentinels = new Map()
}

export const launchSource: MigrationSource = {
  fetchChanges(sinceEpochMs: null | number, onProgress?: (fetched: number) => void): AsyncIterable<LegacyChange> {
    return fetchChangesImpl(sinceEpochMs, onProgress)
  },
  getCoercedSentinels: getCoercedSentinelsImpl,
  getCommitMeta: getCommitMetaImpl,
  getDroppedOverrides: getDroppedOverridesImpl,
  getSkippedConfigs: getSkippedConfigsImpl,
  listEnvironments: listEnvironmentsImpl,
  name: SOURCE_NAME,
  translate: translateImpl,
  validateAuth: validateAuthImpl,
}

export function __resetLaunchSourceForTests(): void {
  state.apiKey = null
  state.envIdMap = null
  state.droppedOverrides = new Map()
  state.skippedConfigs = []
  state.coercedSentinels = new Map()
}
