import type {LaunchChangeEntry, LaunchChangeGroup, LaunchConfig} from './types.js'

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

export function isLegacyLogLevel(type: string): boolean {
  return type.toUpperCase() === 'LOG_LEVEL'
}

function zeroValue(valueType: string): {type: string; value: unknown} {
  switch (valueType) {
    case 'bool': {
      return {type: 'bool', value: false}
    }

    case 'double': {
      return {type: 'double', value: '0'}
    }

    case 'duration': {
      return {type: 'duration', value: 'PT0S'}
    }

    case 'int': {
      return {type: 'int', value: '0'}
    }

    case 'json': {
      return {type: 'json', value: {}}
    }

    case 'log_level': {
      return {type: 'log_level', value: 'WARN'}
    }

    case 'string': {
      return {type: 'string', value: ''}
    }

    case 'string_list': {
      return {type: 'string_list', value: []}
    }

    default: {
      return {type: 'string', value: ''}
    }
  }
}

function parseJsonString(raw: string, configKey: string, path: string): unknown {
  try {
    return JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to parse stringified json value for config "${configKey}" at ${path}: ${message}. Raw value: ${JSON.stringify(
        raw,
      )}`,
    )
  }
}

function normalizeLaunchValue(value: unknown, configKey: string, path: string): void {
  if (!value || typeof value !== 'object') return
  const v = value as {type?: unknown; value?: unknown}
  if (v.type === 'json' && typeof v.value === 'string') {
    v.value = parseJsonString(v.value, configKey, path)
    return
  }

  if (v.type === 'weighted_values' && Array.isArray(v.value)) {
    const entries = v.value as Array<{value?: unknown}>
    for (const [i, entry] of entries.entries()) {
      if (entry && typeof entry === 'object' && entry.value) {
        normalizeLaunchValue(entry.value, configKey, `${path}.weightedValues[${i}].value`)
      }
    }
  }
}

function normalizeRules(rules: unknown, configKey: string, path: string): void {
  if (!Array.isArray(rules)) return
  for (const [i, rule] of rules.entries()) {
    if (!rule || typeof rule !== 'object') continue
    const r = rule as {criteria?: unknown; value?: unknown}
    if (r.value) {
      normalizeLaunchValue(r.value, configKey, `${path}[${i}].value`)
    }

    if (Array.isArray(r.criteria)) {
      for (const [j, crit] of r.criteria.entries()) {
        if (!crit || typeof crit !== 'object') continue
        const c = crit as {valueToMatch?: unknown}
        if (c.valueToMatch) {
          normalizeLaunchValue(c.valueToMatch, configKey, `${path}[${i}].criteria[${j}].valueToMatch`)
        }
      }
    }
  }
}

function normalizeJsonValuesInConfig(out: Record<string, unknown>): void {
  const configKey = String(out.key ?? 'unknown')

  const defaultSection = out.default as {rules?: unknown} | undefined
  if (defaultSection && Array.isArray(defaultSection.rules)) {
    normalizeRules(defaultSection.rules, configKey, 'default.rules')
  }

  if (Array.isArray(out.environments)) {
    for (const [i, env] of (out.environments as Array<Record<string, unknown>>).entries()) {
      const envId = typeof env.id === 'string' ? env.id : String(i)
      normalizeRules(env.rules, configKey, `environments[${envId}].rules`)
    }
  }

  if (Array.isArray(out.variants)) {
    for (const [i, variant] of (out.variants as Array<Record<string, unknown>>).entries()) {
      if (variant && variant.value) {
        normalizeLaunchValue(variant.value, configKey, `variants[${i}].value`)
      }
    }
  }
}

export function transformConfig(config: LaunchConfig, envIdMap: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(config))

  delete out.changedBy
  delete out.modifiedAt
  delete out.createdAt
  delete out.deleted

  if (out.type === 'feature_flag') {
    delete out.sendToClientSdk
  }

  if (typeof out.type === 'string' && (out.type as string).toUpperCase() === 'LOG_LEVEL_V2') {
    out.type = 'log_level'
  }

  if (typeof out.valueType === 'string' && (out.valueType as string).toUpperCase() === 'LOG_LEVEL_V2') {
    out.valueType = 'log_level'
  }

  if (typeof out.type === 'string' && out.type.toLowerCase() === 'schema') {
    throw new Error(
      `Schema-type configs are not yet supported by qfg migrate --from launch. ` +
        `File a bead to prioritize this: https://github.com/quonfig/cli/issues/new?title=qfg+migrate+schema+configs`,
    )
  }

  if (Array.isArray(out.environments)) {
    for (const env of out.environments as Array<Record<string, unknown>>) {
      if (typeof env.id === 'string') {
        const name = envIdMap[env.id] ?? `env-${env.id}`
        env.id = slugify(name)
      }
    }
  }

  if (!out.default && typeof out.valueType === 'string') {
    out.default = {
      rules: [
        {
          criteria: [{operator: 'ALWAYS_TRUE'}],
          value: zeroValue(out.valueType as string),
        },
      ],
    }
  }

  normalizeJsonValuesInConfig(out)

  return out
}

export function getOutputPath(type: string, key: string): string {
  const normalizedType = type.toUpperCase()

  switch (normalizedType) {
    case 'FEATURE_FLAG': {
      return `feature-flags/${key}.json`
    }

    case 'LOG_LEVEL_V2': {
      return `log-levels/${key}.json`
    }

    case 'SCHEMA': {
      return `schemas/${key}.json`
    }

    case 'SEGMENT': {
      return `segments/${key}.json`
    }

    default: {
      return `configs/${key}.json`
    }
  }
}

export function groupChanges(changes: LaunchChangeEntry[]): LaunchChangeGroup[] {
  const groups = new Map<string, LaunchChangeGroup>()

  for (const change of changes) {
    const groupKey = `${change.changedAt}:${change.changedBy.id}`

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        changedAt: change.changedAt,
        changedBy: change.changedBy,
        changes: [],
        groupKey,
        summary: '',
      })
    }

    groups.get(groupKey)!.changes.push(change)
  }

  for (const group of groups.values()) {
    group.summary = group.changes
      .map((c) => (c.deleted ? `Delete ${c.key}` : (c.summary ?? `Update ${c.key}`)))
      .join('\n')
  }

  return [...groups.values()].sort((a, b) => a.changedAt - b.changedAt)
}
