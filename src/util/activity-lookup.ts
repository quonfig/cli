import {APICommand} from '../index.js'

export interface MetadataItem {
  description?: string
  key: string
  name?: string
  type: string
  valueType: string
  version?: string
}

interface MetadataListResponse {
  configs: MetadataItem[]
}

export const ACTIVITY_CONFIG_TYPES = new Set(['feature_flag', 'config', 'log_level', 'segment', 'schema'])

/**
 * Resolve a user-provided NAME to (configType, configKey) by listing metadata
 * and matching on key. Returns either the matched item or an error string.
 *
 * Mirrors the resolution pattern in `cli/src/commands/delete.ts` so callers
 * can pass any of: feature_flag, config, log_level, segment, schema.
 */
export async function resolveConfigByKey(
  command: APICommand,
  key: string,
): Promise<{configType: string; configKey: string; item: MetadataItem} | {error: string}> {
  const metaRes = await command.apiClient.post('/api/v1/metadata/list', {workspaceId: command.workspaceId})
  if (!metaRes.ok) {
    return {error: `Failed to look up ${key}: ${metaRes.status} ${JSON.stringify(metaRes.error)}`}
  }

  const items = (metaRes.json as unknown as MetadataListResponse)?.configs ?? []
  const item = items.find((i) => i.key === key)
  if (!item) {
    return {error: `${key} not found in this workspace.`}
  }

  if (!ACTIVITY_CONFIG_TYPES.has(item.type)) {
    return {error: `Cannot inspect ${key}: unsupported type "${item.type}".`}
  }

  return {configType: item.type, configKey: item.key, item}
}

/** Map shorthand --type values onto the server's configType enum. */
const TYPE_ALIASES: Record<string, string> = {
  flag: 'feature_flag',
  feature_flag: 'feature_flag',
  config: 'config',
  log_level: 'log_level',
  'log-level': 'log_level',
  segment: 'segment',
  schema: 'schema',
}

export function normalizeConfigType(input: string): string | null {
  return TYPE_ALIASES[input] ?? null
}
