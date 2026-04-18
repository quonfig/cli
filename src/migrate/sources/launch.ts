import {type LegacyChange, type MigrationSource, type QuonfigFile} from '../source.js'
import {fetchAllChangeHistory, fetchEnvironments} from './launch/api.js'
import {getOutputPath, isLegacyLogLevel, slugify, transformConfig} from './launch/translate.js'
import type {LaunchChangeEntry} from './launch/types.js'

const SOURCE_NAME = 'launch'

interface LaunchState {
  apiKey: null | string
  envIdMap: null | Record<string, string>
}

const state: LaunchState = {apiKey: null, envIdMap: null}

class MissingAuthError extends Error {
  constructor(operation: string) {
    super(
      `launch source ${operation} requires validateAuth(apiKey) to be called first (no API key configured).`,
    )
    this.name = 'MissingAuthError'
  }
}

function requireApiKey(operation: string): string {
  if (!state.apiKey) throw new MissingAuthError(operation)
  return state.apiKey
}

async function* fetchChangesImpl(sinceEpochMs: null | number): AsyncIterable<LegacyChange> {
  const apiKey = requireApiKey('fetchChanges')
  const since = sinceEpochMs === null ? undefined : sinceEpochMs
  const changes = await fetchAllChangeHistory(apiKey, since)

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

  if (raw.deleted) return []

  if (!raw.newConfig) return []

  const envIdMap = state.envIdMap ?? {}
  const transformed = transformConfig(raw.newConfig, envIdMap)
  const path = getOutputPath(raw.type, raw.key)
  return [{contents: JSON.stringify(transformed, null, 2), path}]
}

async function validateAuthImpl(apiKey: string): Promise<void> {
  await fetchEnvironments(apiKey)
  state.apiKey = apiKey
}

export const launchSource: MigrationSource = {
  fetchChanges(sinceEpochMs: null | number): AsyncIterable<LegacyChange> {
    return fetchChangesImpl(sinceEpochMs)
  },
  listEnvironments: listEnvironmentsImpl,
  name: SOURCE_NAME,
  translate: translateImpl,
  validateAuth: validateAuthImpl,
}

export function __resetLaunchSourceForTests(): void {
  state.apiKey = null
  state.envIdMap = null
}
