import type {LaunchChangeEntry, LaunchChangeGroup, LaunchConfig} from './types.js'
import {zodToJsonSchema} from './zod-to-json-schema.js'

/**
 * Thrown by transformConfig when the source config is structurally invalid
 * (e.g. variant/valueType mismatch) and the migrator cannot produce a valid
 * qfg document from it. Callers in the source layer catch this specifically
 * to soft-skip the config with a warning rather than aborting the whole run.
 */
export class InvalidSourceConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidSourceConfigError'
  }
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

export function isLegacyLogLevel(type: string): boolean {
  return type.toUpperCase() === 'LOG_LEVEL'
}

export function normalizeLogLevelKey(key: string): string {
  return key.startsWith('log-level.') ? key : `log-level.${key}`
}

/**
 * qfg-qhk1: Quonfig keys cannot contain `/` — keys are stored as flat dotted
 * filenames, and a `/` in a source key would create a nested directory tree
 * (data-loss-on-tombstone, cross-key collisions). Normalize `/` to `.` so the
 * destination is always flat.
 */
export function normalizeKey(key: string): string {
  return key.replaceAll('/', '.')
}

/**
 * qfg-l18w / qfg-0q1f: Operators Quonfig accepts in rule criteria. Mirrors
 * the `OperatorSchema` enum in cli/src/verify/validate.ts (and app-quonfig's
 * config-schemas.ts). All currently-known Launch operators are supported;
 * this allowlist guards against future Launch additions Quonfig hasn't
 * implemented yet — emitting an unrecognized operator would otherwise be
 * caught only at qfg verify time, after the migrator has already written
 * a broken file. Keep this list in lockstep with the verify schema; a CI
 * test in this file enforces parity.
 */
export const QUONFIG_SUPPORTED_OPERATORS = new Set<string>([
  'ALWAYS_TRUE',
  'PROP_IS_ONE_OF',
  'PROP_IS_NOT_ONE_OF',
  'PROP_STARTS_WITH_ONE_OF',
  'PROP_DOES_NOT_START_WITH_ONE_OF',
  'PROP_ENDS_WITH_ONE_OF',
  'PROP_DOES_NOT_END_WITH_ONE_OF',
  'PROP_CONTAINS_ONE_OF',
  'PROP_DOES_NOT_CONTAIN_ONE_OF',
  'PROP_LESS_THAN',
  'PROP_LESS_THAN_OR_EQUAL',
  'PROP_GREATER_THAN',
  'PROP_GREATER_THAN_OR_EQUAL',
  'PROP_SEMVER_LESS_THAN',
  'PROP_SEMVER_EQUAL',
  'PROP_SEMVER_GREATER_THAN',
  'PROP_BEFORE',
  'PROP_AFTER',
  'PROP_MATCHES',
  'PROP_DOES_NOT_MATCH',
  'IN_SEG',
  'NOT_IN_SEG',
  'IN_INT_RANGE',
  'LOOKUP_KEY_IN',
  'LOOKUP_KEY_NOT_IN',
])

/**
 * qfg-l18w: Walk every rule criterion in a transformed config and fail-fast at
 * migrate time if it carries an operator Quonfig does not understand. Without
 * this check the migrator would silently write invalid JSON and the failure
 * would only surface later at qfg-verify — leaving the customer's local file
 * broken and re-runs re-clobbering any manual fix.
 *
 * Routes through `InvalidSourceConfigError` so the failure is per-config (the
 * rest of the run still produces a usable workspace, and the offending key
 * lands in MIGRATION_REPORT.md's "Skipped invalid configs" section with a
 * specific reason — exactly what the customer needs to take to support).
 */
function collectUnsupportedOperators(rules: unknown): string[] {
  if (!Array.isArray(rules)) return []
  const found: string[] = []
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    const r = rule as {criteria?: unknown}
    if (!Array.isArray(r.criteria)) continue
    for (const crit of r.criteria) {
      if (!crit || typeof crit !== 'object') continue
      const c = crit as {operator?: unknown}
      if (typeof c.operator !== 'string') continue
      if (!QUONFIG_SUPPORTED_OPERATORS.has(c.operator)) {
        found.push(c.operator)
      }
    }
  }

  return found
}

function validateOperators(out: Record<string, unknown>): void {
  const offenders = new Set<string>()
  const defaultSection = out.default as {rules?: unknown} | undefined
  if (defaultSection) {
    for (const op of collectUnsupportedOperators(defaultSection.rules)) offenders.add(op)
  }

  if (Array.isArray(out.environments)) {
    for (const env of out.environments as Array<Record<string, unknown>>) {
      for (const op of collectUnsupportedOperators(env.rules)) offenders.add(op)
    }
  }

  if (offenders.size === 0) return
  const key = String(out.key ?? 'unknown')
  const sorted = [...offenders].sort()
  throw new InvalidSourceConfigError(
    `Unsupported operator(s) for "${key}": ${sorted.join(', ')}. ` +
      `Quonfig does not currently translate these from the source schema. ` +
      `Recreate the rule in the source system using a supported operator (see qfg config-schema), ` +
      `or contact support@quonfig.com if you need this operator added to Quonfig.`,
  )
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

// qfg-gpnd: Launch emits {type:'string', value:''} as a "no value set yet"
// sentinel even when the surrounding config valueType is non-string (most
// commonly seen on catch-all/ALWAYS_TRUE rules). The qfg-verify hook rejects
// these as type-mismatches and fail-stops the entire push. Coerce the sentinel
// to the typed default so the otherwise-valid config still ships, and surface
// each coercion via the callback so the migrator can report it.
function coerceSentinelRules(rules: unknown, valueType: string, onCoerced: () => void): void {
  if (!Array.isArray(rules)) return
  if (valueType === 'string') return
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    const r = rule as {value?: unknown}
    const v = r.value as {type?: unknown; value?: unknown} | undefined
    if (!v || typeof v !== 'object') continue
    if (v.type === 'string' && v.value === '') {
      r.value = zeroValue(valueType)
      onCoerced()
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

export function transformConfig(
  config: LaunchConfig,
  envIdMap: Record<string, string>,
  onDroppedEnv?: (envId: string) => void,
  onCoercedSentinel?: (envId: string, valueType: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(config))

  // qfg-qhk1: normalize `/` to `.` in the key so the JSON `key` field matches
  // the flat dotted filename the migrator will write.
  if (typeof out.key === 'string') {
    out.key = normalizeKey(out.key)
  }

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

  // qfg-ol8y: Launch passes through `valueType: 'not_set_value_type'` for
  // segments where the field was never explicitly set. qfg-verify rejects
  // that since segments must have valueType 'bool'. Segments in qfg are
  // unconditionally boolean ("is the user in the segment?"), so force-set.
  if (typeof out.type === 'string' && (out.type as string).toLowerCase() === 'segment') {
    out.valueType = 'bool'
  }

  if (out.type === 'log_level' && typeof out.key === 'string') {
    out.key = normalizeLogLevelKey(out.key)
  }

  if (typeof out.type === 'string' && out.type.toLowerCase() === 'schema') {
    const defaultSection = out.default as
      | {
          rules?: Array<{
            value?: {
              value?: {
                schema?: unknown
                schemaType?: unknown
              }
            }
          }>
        }
      | undefined
    const firstRule = defaultSection?.rules?.[0]
    const innerValue = firstRule?.value?.value
    const key = String((out as Record<string, unknown>).key ?? 'unknown')
    if (!innerValue || innerValue.schemaType !== 'ZOD' || typeof innerValue.schema !== 'string') {
      // qfg-p74d: surface as a per-config skip so one bad source config doesn't
      // abort the whole push. Surfaces in MIGRATION_REPORT.md "Skipped invalid
      // configs" alongside variant mismatches.
      throw new InvalidSourceConfigError(`Unsupported schema payload for "${key}"`)
    }

    let converted
    try {
      converted = zodToJsonSchema(innerValue.schema)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      throw new InvalidSourceConfigError(
        `Schema conversion failed for "${key}": ${msg}\n--- Zod source ---\n${innerValue.schema}\n--- end ---`,
      )
    }

    return converted.schema as Record<string, unknown>
  }

  if (Array.isArray(out.environments)) {
    const kept: Array<Record<string, unknown>> = []
    for (const env of out.environments as Array<Record<string, unknown>>) {
      if (typeof env.id === 'string') {
        const name = envIdMap[env.id]
        if (name === undefined) {
          onDroppedEnv?.(env.id)
          continue
        }

        env.id = slugify(name)
      }

      kept.push(env)
    }

    out.environments = kept
  }

  if (
    typeof out.valueType === 'string' &&
    Array.isArray(out.variants) &&
    !['provided', 'schema', 'weighted_values'].includes(out.valueType as string)
  ) {
    const configKey = String(out.key ?? 'unknown')
    for (const [i, variant] of (out.variants as Array<Record<string, unknown>>).entries()) {
      const v = variant?.value as {type?: unknown} | undefined
      if (v && typeof v.type === 'string' && v.type !== out.valueType) {
        throw new InvalidSourceConfigError(
          `Variant type mismatch for "${configKey}" at variants[${i}]: value type "${v.type}" does not match config valueType "${String(out.valueType)}"`,
        )
      }
    }
  }

  if (!out.default && typeof out.valueType === 'string') {
    const variants = Array.isArray(out.variants) ? (out.variants as Array<{value?: unknown}>) : []
    const firstVariantValue =
      variants.length > 0 && variants[0] && typeof variants[0] === 'object' ? variants[0].value : undefined
    out.default = {
      rules: [
        {
          criteria: [{operator: 'ALWAYS_TRUE'}],
          value: firstVariantValue ?? zeroValue(out.valueType as string),
        },
      ],
    }
  }

  if (typeof out.valueType === 'string') {
    const valueType = out.valueType as string
    const defaultSection = out.default as {rules?: unknown} | undefined
    if (defaultSection && Array.isArray(defaultSection.rules)) {
      coerceSentinelRules(defaultSection.rules, valueType, () => onCoercedSentinel?.('default', valueType))
    }

    if (Array.isArray(out.environments)) {
      for (const env of out.environments as Array<Record<string, unknown>>) {
        const envId = typeof env.id === 'string' ? env.id : 'unknown'
        coerceSentinelRules(env.rules, valueType, () => onCoercedSentinel?.(envId, valueType))
      }
    }
  }

  normalizeJsonValuesInConfig(out)

  validateOperators(out)

  return out
}

export function getOutputPath(type: string, key: string): string {
  const normalizedType = type.toUpperCase()
  const k = normalizeKey(key)

  switch (normalizedType) {
    case 'FEATURE_FLAG': {
      return `feature-flags/${k}.json`
    }

    case 'LOG_LEVEL_V2': {
      return `log-levels/${normalizeLogLevelKey(k)}.json`
    }

    case 'SCHEMA': {
      return `schemas/${k}.json`
    }

    case 'SEGMENT': {
      return `segments/${k}.json`
    }

    default: {
      return `configs/${k}.json`
    }
  }
}

const PATH_DIR_TO_TYPE: Record<string, string> = {
  configs: 'config',
  'feature-flags': 'feature_flag',
  'log-levels': 'log_level',
  schemas: 'schema',
  segments: 'segment',
}

const TYPE_TO_DIR: Record<string, string> = Object.fromEntries(
  Object.entries(PATH_DIR_TO_TYPE).map(([dir, type]) => [type, dir]),
)

/**
 * Walks the set of written files looking for cross-type collisions (the same
 * key appearing in multiple type-dirs). Reforge occasionally produces a config
 * and a feature_flag with the same key simultaneously — qfg requires globally-
 * unique keys, so we resolve the collision by keeping the config side and
 * marking the other side(s) for deletion. Callers should fs.unlinkSync the
 * paths in each resolution's `deleted` array and surface the resolutions in
 * stderr + MIGRATION_REPORT.md so the customer can clean up the source data.
 *
 * When the collision does NOT include 'config' (an unexpected pattern we have
 * not observed in production data), we still throw so the case surfaces for
 * review rather than silently picking a tiebreak.
 */
export function detectDuplicateKeys(files: Array<{path: string}>): import('../../source.js').DuplicateResolution[] {
  const keyToTypes = new Map<string, Set<string>>()
  for (const {path} of files) {
    const firstSlash = path.indexOf('/')
    if (firstSlash < 0) continue
    const dir = path.slice(0, firstSlash)
    const type = PATH_DIR_TO_TYPE[dir]
    if (!type) continue
    const file = path.slice(firstSlash + 1)
    const key = file.replace(/\.json$/, '')
    const set = keyToTypes.get(key) ?? new Set<string>()
    set.add(type)
    keyToTypes.set(key, set)
  }

  const resolutions: import('../../source.js').DuplicateResolution[] = []
  const unexpected: string[] = []
  for (const [key, types] of [...keyToTypes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (types.size <= 1) continue
    if (!types.has('config')) {
      unexpected.push(`"${key}" (types: ${[...types].sort().join(', ')})`)
      continue
    }

    const kept = `configs/${key}.json`
    const deleted: string[] = []
    for (const type of [...types].sort()) {
      if (type === 'config') continue
      const dir = TYPE_TO_DIR[type]
      if (!dir) continue
      deleted.push(`${dir}/${key}.json`)
    }

    resolutions.push({collisionTypes: [...types].sort(), deleted, kept, key})
  }

  if (unexpected.length > 0) {
    throw new Error(
      `Unexpected cross-type key collision — no 'config' side to tiebreak on. ` +
        `Please file a bead with the source data details:\n  ${unexpected.join('\n  ')}`,
    )
  }

  return resolutions
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
