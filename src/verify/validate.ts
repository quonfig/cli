/**
 * Workspace validation logic.
 *
 * This module validates a Quonfig workspace directory against the StoredConfig
 * schema. It can be used from both the oclif CLI (`qfg verify`) and the
 * standalone compiled binary (git pre-receive hook).
 *
 * Validation checks:
 *  - Valid JSON
 *  - Schema compliance (StoredConfigSchema from Zod)
 *  - Key matches filename
 *  - Key constraints (1-200 chars, no slashes, not "new", FS-safety floor)
 *  - Case-insensitive key uniqueness (no Foo/foo collisions)
 *  - Config type matches directory
 *  - Segment constraints (valueType=bool, sendToClientSdk=false)
 *  - Log level constraints (valueType=log_level)
 *  - Referential integrity (IN_SEG/NOT_IN_SEG reference existing segments)
 *  - schemaKey references existing schemas
 *  - Rule structure (criteria + value present)
 *  - Value type consistency
 *  - Weighted values non-empty and consistent
 */

import {z} from 'zod'

// Inlined to keep this directory self-contained for the standalone bun-compile
// build that runs as the qfg-verify pre-receive hook in app-gitea — that build
// only copies cli/src/verify/, so any out-of-tree imports break it. Source of
// truth: cli/src/util/log-levels.ts.
const LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const

// ── Schemas (subset of app-quonfig config-schemas.ts) ───────────────────

const ConfigTypeSchema = z.enum(['feature_flag', 'config', 'log_level', 'segment', 'schema'])

const ValueTypeSchema = z.enum(['bool', 'string', 'int', 'double', 'json', 'string_list', 'duration', 'log_level'])

export const OPERATORS = [
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
  'IS_PRESENT',
  'IS_NOT_PRESENT',
  'IN_SEG',
  'NOT_IN_SEG',
  'IN_INT_RANGE',
  'LOOKUP_KEY_IN',
  'LOOKUP_KEY_NOT_IN',
] as const

const OperatorSchema = z.enum(OPERATORS)

const LogLevelSchema = z.enum(LOG_LEVELS)

const BoolValueSchema = z.object({type: z.literal('bool'), value: z.boolean()})
const StringValueSchema = z.object({type: z.literal('string'), value: z.string()})
const IntValueSchema = z.object({type: z.literal('int'), value: z.union([z.number(), z.string()])})
const DoubleValueSchema = z.object({type: z.literal('double'), value: z.union([z.number(), z.string()])})
const JsonValueSchema = z.object({
  type: z.literal('json'),
  value: z.any().refine((v) => typeof v !== 'string', {
    message:
      'json values must be native JSON (object/array/number/boolean/null). Stringified JSON is no longer allowed — use { "a": 1 } instead of "{\\"a\\":1}".',
  }),
})
const StringListValueSchema = z.object({type: z.literal('string_list'), value: z.array(z.string())})
const DurationValueSchema = z.object({type: z.literal('duration'), value: z.string()})
const LogLevelValueSchema = z.object({type: z.literal('log_level'), value: LogLevelSchema})
const SchemaValueSchema = z.object({
  type: z.literal('schema'),
  value: z.object({schemaType: z.string(), schema: z.string()}),
})
const ProvidedValueSchema = z.object({
  type: z.literal('provided'),
  value: z.object({source: z.string(), lookup: z.string()}),
})

const ValueSchema = z.discriminatedUnion('type', [
  BoolValueSchema,
  StringValueSchema,
  IntValueSchema,
  DoubleValueSchema,
  JsonValueSchema,
  StringListValueSchema,
  DurationValueSchema,
  LogLevelValueSchema,
  SchemaValueSchema,
  ProvidedValueSchema,
])

const MAX_WEIGHT = 100_000

const WeightedValueSchema = z.object({
  value: ValueSchema,
  weight: z.number().int().min(0).max(MAX_WEIGHT),
})

const WeightedValuesSchema = z.object({
  type: z.literal('weighted_values'),
  value: z.object({
    weightedValues: z.array(WeightedValueSchema),
    hashByPropertyName: z.string().default('user.key'),
    splitEvenly: z.boolean().optional(),
  }),
})

const RuleValueSchema = z.union([ValueSchema, WeightedValuesSchema])

const CriterionSchema = z.object({
  propertyName: z.string().optional(),
  operator: OperatorSchema,
  valueToMatch: ValueSchema.optional(),
})

const ConfigRuleSchema = z.object({
  criteria: z.array(CriterionSchema),
  value: RuleValueSchema,
})

/** Environment ID must be a slug: lowercase alphanumeric + dashes, not a UUID. */
const SLUG_RE = /^[\da-z]+(?:-[\da-z]+)*$/
const UUID_RE = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

const ConfigEnvironmentSchema = z.object({
  id: z.string(),
  rules: z.array(ConfigRuleSchema),
})

const VariantSchema = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  value: ValueSchema,
  description: z.string().optional(),
})

const AccessSchema = z.enum(['support', 'standard', 'protected-env', 'protected-all-envs'])

const StoredConfigSchema = z
  .object({
    id: z.string().optional(),
    projectId: z.string().optional(),
    key: z.string(),
    type: ConfigTypeSchema,
    valueType: ValueTypeSchema,
    name: z.string().optional(),
    description: z.string().optional(),
    sendToClientSdk: z.boolean().optional(),
    schemaKey: z.string().optional(),
    access: AccessSchema.optional(),
    default: z.object({
      rules: z.array(ConfigRuleSchema),
    }),
    environments: z.array(ConfigEnvironmentSchema).default([]),
    variants: z.array(VariantSchema).default([]),
  })
  .passthrough() // Allow extra fields (tags, schemaUsageMode, etc.)

const SchemaDocumentSchema = z.object({}).passthrough()

// ── Types ───────────────────────────────────────────────────────────────

export type Severity = 'error' | 'warning'

export interface ValidationIssue {
  file: string
  message: string
  severity: Severity
  suggestion?: string
}

export interface ValidationStats {
  configs: number
  envRefsChecked: number
  environmentOverrides: number
  featureFlags: number
  logLevels: number
  rules: number
  schemaRefsChecked: number
  schemas: number
  segmentRefsChecked: number
  segments: number
  uniqueKeysVerified: number
}

export interface ValidationResult {
  filesChecked: number
  issues: ValidationIssue[]
  stats: ValidationStats
  valid: boolean
}

/** Maps config directory names to their expected config type. */
const DIR_TO_TYPE: Record<string, string> = {
  configs: 'config',
  'feature-flags': 'feature_flag',
  segments: 'segment',
  'log-levels': 'log_level',
}

const CONFIG_DIRS = new Set(Object.keys(DIR_TO_TYPE))
const SCHEMA_DIRS = new Set(['schemas', 'schemas-protected'])
const KNOWN_DIRS = new Set([...CONFIG_DIRS, ...SCHEMA_DIRS])

// ── Ghost-file prevention (qfg-hbuy.4) ──────────────────────────────────
// Within the validated content dirs (KNOWN_DIRS), every entry must be a
// top-level, non-dot, lowercase-`.json` file. Anything else used to be
// silently SKIPPED by the enumeration filters — a "ghost" file that pushes
// fine but is invisible to the hook and to every loader, and a mixed-case
// FOO.JSON can collide with foo.json on a case-insensitive customer clone
// (the exact clonability failure Policy A exists to prevent). A skipped
// entry is a bypass; an error is a rejected push. Paths OUTSIDE the
// validated dirs (quonfig.json, README.md, .qf/, ...) are not this rule's
// business and stay untouched.
function ghostEntryIssue(dir: string, relPath: string, name: string, nested: boolean): null | ValidationIssue {
  if (nested) {
    return {
      file: relPath,
      message: `Subdirectories are not allowed inside "${dir}/" — nested files are never loaded (ghost file)`,
      severity: 'error',
      suggestion: `Move config files to the top level: "${dir}/<key>.json"`,
    }
  }

  if (name.startsWith('.')) {
    return {
      file: relPath,
      message: `Dotfile "${name}" is not allowed inside "${dir}/" — hidden files are never loaded (ghost file)`,
      severity: 'error',
      suggestion: `Remove the file or rename it without the leading dot`,
    }
  }

  if (!name.endsWith('.json')) {
    if (name.toLowerCase().endsWith('.json')) {
      return {
        file: relPath,
        message: `File extension must be lowercase ".json" (found "${name}") — a case-variant extension is never loaded and can collide with another file on a case-insensitive filesystem`,
        severity: 'error',
        suggestion: `Rename to "${name.slice(0, -5)}.json"`,
      }
    }

    return {
      file: relPath,
      message: `Only ".json" files are allowed inside "${dir}/" (found "${name}")`,
      severity: 'error',
      suggestion: `Remove the file or rename it to "<key>.json"`,
    }
  }

  return null
}

/**
 * Disk-walk variant of the ghost rule (validateWorkspace). Returns the list
 * of names that should proceed to content validation, pushing an issue for
 * every ghost entry.
 *
 * Dotfiles are the one place the disk rule is softer than the committed-tree
 * rule: `qfg push` never sends dotfiles (collectFiles skips them), so a local
 * `configs/.DS_Store` is inert OS junk — erroring on it would break every
 * macOS user. A `.json`-looking dotfile is almost certainly a mistake, so it
 * gets a WARNING; other dotfiles are skipped silently.
 */
function listValidatedDirEntries(dirPath: string, dir: string, issues: ValidationIssue[]): string[] {
  const names: string[] = []
  for (const entry of fs.readdirSync(dirPath, {withFileTypes: true})) {
    const relPath = `${dir}/${entry.name}`
    if (entry.name.startsWith('.')) {
      if (entry.name.toLowerCase().endsWith('.json')) {
        issues.push({
          file: relPath,
          message: `Dotfile "${entry.name}" in "${dir}/" is ignored — it is never validated, pushed, or loaded`,
          severity: 'warning',
          suggestion: `Remove the file or rename it without the leading dot`,
        })
      }

      continue
    }

    const ghost = ghostEntryIssue(dir, relPath, entry.name, entry.isDirectory())
    if (ghost) {
      issues.push(ghost)
      continue
    }

    names.push(entry.name)
  }

  return names
}

// Operators that reference segments
const SEGMENT_OPERATORS = new Set(['IN_SEG', 'NOT_IN_SEG'])

// Operators that require a propertyName
const PROPERTY_OPERATORS = new Set([
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
  'IS_PRESENT',
  'IS_NOT_PRESENT',
])

// Operators that take only `propertyName` — no valueToMatch (qfg-7jnb)
const PRESENCE_OPERATORS = new Set(['IS_PRESENT', 'IS_NOT_PRESENT'])

// Operators that require a valueToMatch — every property/segment/lookup operator
// EXCEPT the presence-only ones, which are intentionally value-less.
const VALUE_REQUIRED_OPERATORS = new Set(
  [...PROPERTY_OPERATORS, 'IN_SEG', 'NOT_IN_SEG', 'IN_INT_RANGE', 'LOOKUP_KEY_IN', 'LOOKUP_KEY_NOT_IN'].filter(
    (op) => !PRESENCE_OPERATORS.has(op),
  ),
)

/**
 * Reject `sendToClientSdk` on feature_flag rows — the field is config-only.
 * Checks the raw parsed JSON so the key is forbidden regardless of value
 * (true or false). Segments are handled separately on the parsed config.
 */
function checkFeatureFlagForbiddenFields(parsed: unknown, file: string, issues: ValidationIssue[]): void {
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as {type?: unknown}).type === 'feature_flag' &&
    Object.hasOwn(parsed, 'sendToClientSdk')
  ) {
    issues.push({
      file,
      message: `feature_flag must not set "sendToClientSdk" — this field is only valid on config rows`,
      severity: 'error',
      suggestion: `Remove the "sendToClientSdk" field from this feature_flag JSON`,
    })
  }
}

// ── Validation from filesystem ──────────────────────────────────────────

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Validate an entire workspace directory on disk.
 */
export function validateWorkspace(workspaceDir: string): ValidationResult {
  const issues: ValidationIssue[] = []
  let filesChecked = 0
  const stats: ValidationStats = {
    configs: 0,
    featureFlags: 0,
    segments: 0,
    logLevels: 0,
    schemas: 0,
    environmentOverrides: 0,
    rules: 0,
    segmentRefsChecked: 0,
    schemaRefsChecked: 0,
    envRefsChecked: 0,
    uniqueKeysVerified: 0,
  }

  // Collect all configs for cross-reference checks
  const allConfigs: Array<{key: string; type: string; dir: string; file: string}> = []
  const allSchemaFiles: Array<{key: string; file: string}> = []
  const segmentKeys = new Set<string>()
  const schemaKeys = new Set<string>()
  const declaredEnvIds = new Set<string>()

  // Check for unexpected top-level entries
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(workspaceDir, {withFileTypes: true})
  } catch (error: unknown) {
    return {
      issues: [
        {
          file: workspaceDir,
          message: `Cannot read workspace directory: ${(error as Error).message}`,
          severity: 'error',
        },
      ],
      filesChecked: 0,
      valid: false,
      stats,
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // skip .git, .qf, etc.
    if (entry.isDirectory() && !KNOWN_DIRS.has(entry.name)) {
      issues.push({
        file: entry.name,
        message: `Unexpected directory "${entry.name}"`,
        severity: 'warning',
        suggestion: `Expected directories: ${[...KNOWN_DIRS].join(', ')}`,
      })
    }
  }

  // Validate quonfig.json at workspace root
  const quonfigPath = path.join(workspaceDir, 'quonfig.json')
  if (fs.existsSync(quonfigPath)) {
    let quonfigRaw: string
    try {
      quonfigRaw = fs.readFileSync(quonfigPath, 'utf8')
    } catch (error: unknown) {
      quonfigRaw = ''
      issues.push({
        file: 'quonfig.json',
        message: `Cannot read quonfig.json: ${(error as Error).message}`,
        severity: 'error',
      })
    }

    if (quonfigRaw) {
      let quonfigParsed: unknown
      try {
        quonfigParsed = JSON.parse(quonfigRaw)
      } catch (error: unknown) {
        quonfigParsed = null
        issues.push({file: 'quonfig.json', message: `Invalid JSON: ${(error as Error).message}`, severity: 'error'})
      }

      const quonfigResult = z
        .object({environments: z.array(z.string()), workspace: z.string().optional()})
        .safeParse(quonfigParsed)
      if (quonfigResult.success) {
        for (const envId of quonfigResult.data.environments) {
          declaredEnvIds.add(envId)
        }
      } else {
        issues.push({
          file: 'quonfig.json',
          message: `quonfig.json must have an "environments" array of strings`,
          severity: 'error',
          suggestion: `Format: {"environments": ["production", "staging"]}`,
        })
      }
    }
  } else {
    issues.push({
      file: 'quonfig.json',
      message: `quonfig.json is missing from workspace root`,
      severity: 'error',
      suggestion: `Create quonfig.json with format: {"environments": ["production", "staging"]}`,
    })
  }

  // First pass: parse all files and collect keys. Ghost entries (dotfiles,
  // subdirectories, non-lowercase-.json names) are reported here (qfg-hbuy.4).
  for (const dir of KNOWN_DIRS) {
    const dirPath = path.join(workspaceDir, dir)
    if (!fs.existsSync(dirPath)) continue

    const files = listValidatedDirEntries(dirPath, dir, issues)
    for (const file of files) {
      const filePath = path.join(dirPath, file)
      const relPath = `${dir}/${file}`
      filesChecked++

      // Read and parse JSON
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf8')
      } catch (error: unknown) {
        issues.push({file: relPath, message: `Cannot read file: ${(error as Error).message}`, severity: 'error'})
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error: unknown) {
        issues.push({
          file: relPath,
          message: `Invalid JSON: ${(error as Error).message}`,
          severity: 'error',
        })
        continue
      }

      if (SCHEMA_DIRS.has(dir)) {
        const result = SchemaDocumentSchema.safeParse(parsed)
        if (!result.success) {
          for (const issue of result.error.issues) {
            issues.push({
              file: relPath,
              message: `Schema: ${issue.path.join('.')} - ${issue.message}`,
              severity: 'error',
            })
          }
          continue
        }

        const schemaKey = file.replace(/\.json$/, '')
        schemaKeys.add(schemaKey)
        validateKey(schemaKey, relPath, issues)
        allSchemaFiles.push({key: schemaKey, file: relPath})
        stats.schemas++
        continue
      }

      checkFeatureFlagForbiddenFields(parsed, relPath, issues)

      // Validate against StoredConfigSchema
      const result = StoredConfigSchema.safeParse(parsed)
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            file: relPath,
            message: `Schema: ${issue.path.join('.')} - ${issue.message}`,
            severity: 'error',
          })
        }
        continue
      }

      const config = result.data
      const expectedKey = file.replace(/\.json$/, '')

      // Key matches filename
      if (config.key !== expectedKey) {
        issues.push({
          file: relPath,
          message: `Key "${config.key}" does not match filename "${expectedKey}"`,
          severity: 'error',
          suggestion: `Rename file to "${config.key}.json" or set key to "${expectedKey}"`,
        })
      }

      // Key constraints
      validateKey(config.key, relPath, issues)

      // Config type matches directory
      const expectedType = DIR_TO_TYPE[dir]
      if (expectedType && config.type !== expectedType) {
        issues.push({
          file: relPath,
          message: `Type "${config.type}" in directory "${dir}" (expected "${expectedType}")`,
          severity: 'error',
          suggestion: `Move to "${typeToDir(config.type)}/" or change type to "${expectedType}"`,
        })
      }

      // Type-specific constraints
      if (config.type === 'segment') {
        if (config.valueType !== 'bool') {
          issues.push({
            file: relPath,
            message: `Segment must have valueType "bool", got "${config.valueType}"`,
            severity: 'error',
          })
        }
        if (config.sendToClientSdk) {
          issues.push({
            file: relPath,
            message: `Segment must have sendToClientSdk=false`,
            severity: 'error',
          })
        }
        // Segments are cross-environment (no per-env values), so `protected-env`
        // has no meaning — there is no environment to protect. Allow only
        // support / standard / protected-all-envs. See protecting-access.md §11.
        if (config.access === 'protected-env') {
          issues.push({
            file: relPath,
            message: `Segment cannot have access "protected-env" — segments are cross-environment. Use "standard" or "protected-all-envs".`,
            severity: 'error',
            suggestion: `Change access to "standard" or "protected-all-envs"`,
          })
        }
        segmentKeys.add(config.key)
      }

      if (config.type === 'log_level') {
        if (config.valueType !== 'log_level') {
          issues.push({
            file: relPath,
            message: `Log level must have valueType "log_level", got "${config.valueType}"`,
            severity: 'error',
          })
        }
        if (!config.key.startsWith('log-level.')) {
          issues.push({
            file: relPath,
            message: `Log level key "${config.key}" must start with "log-level."`,
            severity: 'error',
            suggestion: `Rename to "log-level.${config.key}" (and rename the file to "log-level.${config.key}.json")`,
          })
        }
      }

      // Validate environment IDs are slugs, not UUIDs
      validateEnvironmentIds(config.environments, relPath, issues)

      // Validate rules
      validateRules(config.default.rules, relPath, 'default', config.valueType, issues, config.variants)
      for (const env of config.environments) {
        validateRules(env.rules, relPath, `environments[${env.id}]`, config.valueType, issues, config.variants)
      }

      // Count by type
      switch (config.type) {
        case 'config':
          stats.configs++
          break
        case 'feature_flag':
          stats.featureFlags++
          break
        case 'segment':
          stats.segments++
          break
        case 'log_level':
          stats.logLevels++
          break
      }

      // Count rules and environment overrides
      stats.rules += config.default.rules.length
      stats.environmentOverrides += config.environments.length
      for (const env of config.environments) {
        stats.rules += env.rules.length
      }

      // Collect for cross-reference
      allConfigs.push({key: config.key, type: config.type, dir, file: relPath})
    }
  }

  // Second pass: referential integrity. Keep the plain skip-filter here —
  // ghost entries were already reported (once) by the first pass.
  for (const dir of KNOWN_DIRS) {
    const dirPath = path.join(workspaceDir, dir)
    if (!fs.existsSync(dirPath)) continue

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    for (const file of files) {
      const filePath = path.join(dirPath, file)
      const relPath = `${dir}/${file}`

      if (SCHEMA_DIRS.has(dir)) {
        continue
      }

      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf8')
      } catch {
        continue
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }

      const result = StoredConfigSchema.safeParse(parsed)
      if (!result.success) continue

      const config = result.data

      // Check segment references in criteria
      const segRefs = collectSegmentReferences(config)
      for (const ref of segRefs) {
        stats.segmentRefsChecked++
        if (!segmentKeys.has(ref)) {
          issues.push({
            file: relPath,
            message: `References segment "${ref}" which does not exist`,
            severity: 'error',
            suggestion: `Create segments/${ref}.json or remove the segment reference`,
          })
        }
      }

      // Check schemaKey references
      if (config.schemaKey) {
        stats.schemaRefsChecked++
        if (!schemaKeys.has(config.schemaKey)) {
          issues.push({
            file: relPath,
            message: `References schema "${config.schemaKey}" which does not exist`,
            severity: 'error',
            suggestion: `Create schemas/${config.schemaKey}.json or schemas-protected/${config.schemaKey}.json, or remove schemaKey`,
          })
        }
      }

      // Check environment IDs referenced in config exist in quonfig.json
      if (declaredEnvIds.size > 0) {
        for (const env of config.environments) {
          stats.envRefsChecked++
          if (!declaredEnvIds.has(env.id)) {
            issues.push({
              file: relPath,
              message: `References environment "${env.id}" which is not declared in quonfig.json`,
              severity: 'error',
              suggestion: `Add "${env.id}" to the environments array in quonfig.json, or remove this environment override`,
            })
          }
        }
      }
    }
  }

  // Check for duplicate keys across directories (case-insensitive — see
  // detectDuplicateKeys).
  const uniqueConfigKeys = detectDuplicateKeys(allConfigs, 'key', issues)
  const uniqueSchemaKeys = detectDuplicateKeys(allSchemaFiles, 'schema key', issues)

  stats.uniqueKeysVerified = uniqueConfigKeys + uniqueSchemaKeys

  const hasErrors = issues.some((i) => i.severity === 'error')
  return {issues, filesChecked, valid: !hasErrors, stats}
}

// Default empty stats for validateFileMap (which doesn't track detailed stats)
function emptyStats(): ValidationStats {
  return {
    configs: 0,
    featureFlags: 0,
    segments: 0,
    logLevels: 0,
    schemas: 0,
    environmentOverrides: 0,
    rules: 0,
    segmentRefsChecked: 0,
    schemaRefsChecked: 0,
    envRefsChecked: 0,
    uniqueKeysVerified: 0,
  }
}

// ── Validate from in-memory file map (for git hook) ─────────────────────

/**
 * Validate configs provided as a map of { "dir/file.json": jsonString }.
 * Used by the pre-receive hook which reads files from git objects.
 */
export function validateFileMap(files: Map<string, string>): ValidationResult {
  const issues: ValidationIssue[] = []
  let filesChecked = 0

  const segmentKeys = new Set<string>()
  const schemaKeys = new Set<string>()
  const allSchemaFiles: Array<{key: string; file: string}> = []
  const allConfigs: Array<{key: string; file: string}> = []
  const parsedConfigs: Array<{relPath: string; config: z.infer<typeof StoredConfigSchema>; dir: string}> = []
  const declaredEnvIds = new Set<string>()

  // Validate quonfig.json if it's included in the file map (it may not be in every commit)
  const quonfigContent = files.get('quonfig.json')
  if (quonfigContent !== undefined) {
    let quonfigParsed: unknown
    try {
      quonfigParsed = JSON.parse(quonfigContent)
    } catch (error: unknown) {
      quonfigParsed = null
      issues.push({file: 'quonfig.json', message: `Invalid JSON: ${(error as Error).message}`, severity: 'error'})
    }

    if (quonfigParsed !== null) {
      const quonfigResult = z
        .object({environments: z.array(z.string()), workspace: z.string().optional()})
        .safeParse(quonfigParsed)
      if (quonfigResult.success) {
        for (const envId of quonfigResult.data.environments) {
          declaredEnvIds.add(envId)
        }
      } else {
        issues.push({
          file: 'quonfig.json',
          message: `quonfig.json must have an "environments" array of strings`,
          severity: 'error',
          suggestion: `Format: {"environments": ["production", "staging"]}`,
        })
      }
    }
  }

  for (const [relPath, content] of files) {
    const parts = relPath.split('/')
    if (parts.length < 2) continue
    const dir = parts[0]
    const file = parts.at(-1)

    if (!KNOWN_DIRS.has(dir)) continue
    if (!file) continue

    // qfg-hbuy.4: a dotfile, nested path, or non-lowercase-.json entry inside
    // a validated dir is a hard error (rejected push), not a silent skip.
    const ghost = ghostEntryIssue(dir, relPath, file, parts.length > 2)
    if (ghost) {
      issues.push(ghost)
      continue
    }

    filesChecked++

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error: unknown) {
      issues.push({file: relPath, message: `Invalid JSON: ${(error as Error).message}`, severity: 'error'})
      continue
    }

    if (SCHEMA_DIRS.has(dir)) {
      const result = SchemaDocumentSchema.safeParse(parsed)
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            file: relPath,
            message: `Schema: ${issue.path.join('.')} - ${issue.message}`,
            severity: 'error',
          })
        }
        continue
      }

      const schemaKey = file.replace(/\.json$/, '')
      schemaKeys.add(schemaKey)
      validateKey(schemaKey, relPath, issues)
      allSchemaFiles.push({key: schemaKey, file: relPath})
      continue
    }

    checkFeatureFlagForbiddenFields(parsed, relPath, issues)

    const result = StoredConfigSchema.safeParse(parsed)
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          file: relPath,
          message: `Schema: ${issue.path.join('.')} - ${issue.message}`,
          severity: 'error',
        })
      }
      continue
    }

    const config = result.data
    const expectedKey = file.replace(/\.json$/, '')

    if (config.key !== expectedKey) {
      issues.push({
        file: relPath,
        message: `Key "${config.key}" does not match filename "${expectedKey}"`,
        severity: 'error',
        suggestion: `Rename file to "${config.key}.json" or set key to "${expectedKey}"`,
      })
    }

    validateKey(config.key, relPath, issues)

    const expectedType = DIR_TO_TYPE[dir]
    if (expectedType && config.type !== expectedType) {
      issues.push({
        file: relPath,
        message: `Type "${config.type}" in directory "${dir}" (expected "${expectedType}")`,
        severity: 'error',
        suggestion: `Move to "${typeToDir(config.type)}/" or change type to "${expectedType}"`,
      })
    }

    if (config.type === 'segment') {
      if (config.valueType !== 'bool') {
        issues.push({
          file: relPath,
          message: `Segment must have valueType "bool", got "${config.valueType}"`,
          severity: 'error',
        })
      }
      if (config.sendToClientSdk) {
        issues.push({file: relPath, message: `Segment must have sendToClientSdk=false`, severity: 'error'})
      }
      // Segments are cross-environment — `protected-env` has no meaning. See protecting-access.md §11.
      if (config.access === 'protected-env') {
        issues.push({
          file: relPath,
          message: `Segment cannot have access "protected-env" — segments are cross-environment. Use "standard" or "protected-all-envs".`,
          severity: 'error',
          suggestion: `Change access to "standard" or "protected-all-envs"`,
        })
      }
      segmentKeys.add(config.key)
    }

    if (config.type === 'log_level') {
      if (config.valueType !== 'log_level') {
        issues.push({
          file: relPath,
          message: `Log level must have valueType "log_level", got "${config.valueType}"`,
          severity: 'error',
        })
      }
      if (!config.key.startsWith('log-level.')) {
        issues.push({
          file: relPath,
          message: `Log level key "${config.key}" must start with "log-level."`,
          severity: 'error',
          suggestion: `Rename to "log-level.${config.key}" (and rename the file to "log-level.${config.key}.json")`,
        })
      }
    }

    validateEnvironmentIds(config.environments, relPath, issues)

    validateRules(config.default.rules, relPath, 'default', config.valueType, issues, config.variants)
    for (const env of config.environments) {
      validateRules(env.rules, relPath, `environments[${env.id}]`, config.valueType, issues, config.variants)
    }

    allConfigs.push({key: config.key, file: relPath})
    parsedConfigs.push({relPath, config, dir})
  }

  // Referential integrity
  for (const {relPath, config} of parsedConfigs) {
    const segRefs = collectSegmentReferences(config)
    for (const ref of segRefs) {
      if (!segmentKeys.has(ref)) {
        issues.push({
          file: relPath,
          message: `References segment "${ref}" which does not exist`,
          severity: 'error',
          suggestion: `Create segments/${ref}.json or remove the segment reference`,
        })
      }
    }

    if (config.schemaKey && !schemaKeys.has(config.schemaKey)) {
      issues.push({
        file: relPath,
        message: `References schema "${config.schemaKey}" which does not exist`,
        severity: 'error',
        suggestion: `Create schemas/${config.schemaKey}.json or schemas-protected/${config.schemaKey}.json, or remove schemaKey`,
      })
    }

    // Check environment IDs referenced in config exist in quonfig.json
    if (declaredEnvIds.size > 0) {
      for (const env of config.environments) {
        if (!declaredEnvIds.has(env.id)) {
          issues.push({
            file: relPath,
            message: `References environment "${env.id}" which is not declared in quonfig.json`,
            severity: 'error',
            suggestion: `Add "${env.id}" to the environments array in quonfig.json, or remove this environment override`,
          })
        }
      }
    }
  }

  // Duplicate keys (case-insensitive — see detectDuplicateKeys).
  detectDuplicateKeys(allConfigs, 'key', issues)
  detectDuplicateKeys(allSchemaFiles, 'schema key', issues)

  const hasErrors = issues.some((i) => i.severity === 'error')
  return {issues, filesChecked, valid: !hasErrors, stats: emptyStats()}
}

// ── Helpers ─────────────────────────────────────────────────────────────

function validateEnvironmentIds(
  environments: z.infer<typeof ConfigEnvironmentSchema>[],
  file: string,
  issues: ValidationIssue[],
): void {
  for (const env of environments) {
    if (UUID_RE.test(env.id)) {
      issues.push({
        file,
        message: `Environment ID "${env.id}" is a UUID — must be a human-readable slug (e.g., "production", "my-ci-env")`,
        severity: 'error',
        suggestion: `Replace the UUID with the environment's slugified name`,
      })
    } else if (!SLUG_RE.test(env.id)) {
      issues.push({
        file,
        message: `Environment ID "${env.id}" is not a valid slug (expected lowercase alphanumeric + dashes)`,
        severity: 'error',
        suggestion: `Use a slugified name like "production" or "my-ci-env"`,
      })
    }
  }
}

// FS-safety floor checks (qfg-6na9.4). These are the names that pass the loose
// historical rule but produce a file that cannot be cloned/checked-out on a
// customer machine (macOS/Windows). The audit (project/plans/26-06-tighter-naming.md,
// "FS-safety floor") found ZERO existing violations, so every one is a hard
// error from day one.
//
// IMPORTANT: this floor must stay conceptually in lockstep with app-quonfig's
// src/lib/domain/config-schemas.ts (the charset precedent there is
// `SchemaKeySchema`; Policy A is `PolicyAKeySchema`). The general charset check
// (`^[A-Za-z0-9._-]+$`) is deliberately NOT here — it lives in `validateKey`
// below (warning per qfg-6na9.5, hard error since qfg-6na9.6). This list is the
// FS-floor only.
//
// Structured as a table so severity is trivially adjustable later.
const FS_SAFETY_FLOOR_CHECKS: ReadonlyArray<{test: (k: string) => boolean; message: string}> = [
  {test: (k) => k.startsWith('.'), message: `Key has a leading dot (files starting with "." are skipped by verify)`},
  // eslint-disable-next-line no-control-regex -- matching control chars/NUL is the point
  {test: (k) => /[\u0000-\u001F\u007F]/.test(k), message: `Key contains control chars or NUL`},
  {test: (k) => /["*:<>?|]/.test(k), message: `Key contains Windows-reserved chars (: * ? " < > |)`},
  {
    test: (k) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(k.split('.')[0]),
    message: `Key is a Windows reserved device name (con/prn/aux/nul/com1-9/lpt1-9)`,
  },
  {test: (k) => /[ .]$/.test(k), message: `Key has a trailing dot or space (silently stripped on Windows)`},
]

// Exported so the FS-safety floor (incl. the leading-dot rule, whose files are
// pre-filtered by the directory walk before they'd reach the file-map path) can
// be unit-tested directly.
export function validateKey(key: string, file: string, issues: ValidationIssue[]): void {
  const errorsBefore = issues.length
  if (key.length === 0) {
    issues.push({file, message: `Key is empty`, severity: 'error'})
  }
  // Length cap lowered 512 -> 200 (project/plans/26-06-tighter-naming.md,
  // "Length cap: 200"): ASCII-only Policy A means 200 chars == 200 bytes, well
  // under the 255-byte filesystem path-component limit even with `.json`.
  if (key.length > 200) {
    issues.push({file, message: `Key exceeds 200 characters (${key.length})`, severity: 'error'})
  }
  if (key === 'new') {
    issues.push({file, message: `Key cannot be "new" (reserved)`, severity: 'error'})
  }
  if (/[/\\]/.test(key)) {
    issues.push({file, message: `Key contains slash or backslash`, severity: 'error'})
  }
  for (const check of FS_SAFETY_FLOOR_CHECKS) {
    if (check.test(key)) {
      issues.push({file, message: check.message, severity: 'error'})
    }
  }

  // qfg-6na9.6: the general Policy A charset as a HARD ERROR. Shipped as a
  // warning first (qfg-6na9.5), flipped after a full-corpus enumeration of all
  // prod workspaces verified zero non-conforming keys (2026-07-03; see the bead
  // and project/plans/26-06-tighter-naming.md). The charset `^[A-Za-z0-9._-]+$`
  // is kept in sync with app-quonfig's PolicyAKeySchema (hard at create).
  // Skipped when this key already earned an error above (e.g. a
  // Windows-reserved char is both a floor error AND a charset miss) so we
  // don't double-report the same key.
  // eslint-disable-next-line unicorn/better-regex -- keep the explicit charset in sync with app-quonfig
  if (issues.length === errorsBefore && !/^[A-Za-z0-9._-]+$/.test(key)) {
    issues.push({
      file,
      message: `Key "${key}" has characters outside the allowed set (letters, numbers, ".", "-", "_").`,
      severity: 'error',
      suggestion: `Rename to use only letters, numbers, ".", "-", and "_"`,
    })
  }
}

// Case-insensitive duplicate-key detection (qfg-6na9.4,
// project/plans/26-06-tighter-naming.md "Case-insensitive uniqueness").
// `Foo` and `foo` are distinct keys server-side (case-sensitive Linux ext4) but
// collide to one file on a case-insensitive macOS/Windows clone, silently
// dropping a config. Group by the DOWNCASED key and branch the message:
//   - all original keys byte-identical -> exact-duplicate message
//   - they differ only by case        -> case-collision message
// The audit found 0 such collisions today, so this is a hard error from day one.
function detectDuplicateKeys(
  entries: ReadonlyArray<{key: string; file: string}>,
  label: 'key' | 'schema key',
  issues: ValidationIssue[],
): number {
  const byLowercase = new Map<string, Array<{key: string; file: string}>>()
  for (const e of entries) {
    const lower = e.key.toLowerCase()
    const existing = byLowercase.get(lower) || []
    existing.push(e)
    byLowercase.set(lower, existing)
  }
  for (const group of byLowercase.values()) {
    if (group.length <= 1) continue
    const files = group.map((g) => g.file).join(', ')
    const originalKeys = group.map((g) => g.key)
    const allIdentical = originalKeys.every((k) => k === originalKeys[0])
    if (allIdentical) {
      issues.push({
        file: files,
        message: `Duplicate ${label} "${originalKeys[0]}" found in multiple files`,
        severity: 'error',
        suggestion:
          label === 'schema key'
            ? `Each schema key must be unique across schema directories`
            : `Each key must be unique across the workspace`,
      })
    } else {
      issues.push({
        file: files,
        message: `Keys differ only by case (${originalKeys.join(', ')}); they collide to one file on case-insensitive filesystems (macOS/Windows)`,
        severity: 'error',
        suggestion: `Rename so the ${label}s are also unique when lowercased`,
      })
    }
  }
  return byLowercase.size
}

function validateRules(
  rules: z.infer<typeof ConfigRuleSchema>[],
  file: string,
  context: string,
  expectedValueType: string,
  issues: ValidationIssue[],
  variants: z.infer<typeof VariantSchema>[] = [],
): void {
  if (rules.length === 0) {
    issues.push({file, message: `${context}: no rules defined`, severity: 'warning'})
  }

  // Pre-compute serialized variant values for matching
  const variantValues = new Set(variants.map((v) => JSON.stringify(v.value)))

  for (const [i, rule] of rules.entries()) {
    const ruleCtx = `${context}.rules[${i}]`

    // Check value type consistency
    // Skip weighted_values (contains its own values), schema, and provided (special types)
    const SPECIAL_VALUE_TYPES = new Set(['weighted_values', 'schema', 'provided'])
    if (!SPECIAL_VALUE_TYPES.has(rule.value.type)) {
      if (rule.value.type !== expectedValueType) {
        issues.push({
          file,
          message: `${ruleCtx}: value type "${rule.value.type}" does not match config valueType "${expectedValueType}"`,
          severity: 'error',
        })
      }

      // Check that value matches one of the defined variants
      if (variants.length > 0) {
        const serialized = JSON.stringify(rule.value)
        if (!variantValues.has(serialized)) {
          issues.push({
            file,
            message: `${ruleCtx}: value does not match any defined variant`,
            severity: 'error',
            suggestion: `Rule value must be one of the defined variants`,
          })
        }
      }
    } else if (rule.value.type === 'weighted_values') {
      // Validate weighted values
      const wv = (rule.value as z.infer<typeof WeightedValuesSchema>).value
      if (wv.weightedValues.length === 0) {
        issues.push({file, message: `${ruleCtx}: weighted values list is empty`, severity: 'error'})
      }
      // Percentage rollouts must reference named variants — the UI cannot edit
      // a rollout when variants is empty. Bool configs are exempt because the
      // UI supplies implicit true/false variants.
      if (wv.weightedValues.length > 0 && variants.length === 0 && expectedValueType !== 'bool') {
        issues.push({
          file,
          message: `${ruleCtx}: weighted_values rollout requires at least one variant, but variants is empty`,
          severity: 'error',
          suggestion: `Define variants for the possible rollout values, then reference them from weightedValues.`,
        })
      }
      for (let j = 0; j < wv.weightedValues.length; j++) {
        if (wv.weightedValues[j].value.type !== expectedValueType) {
          issues.push({
            file,
            message: `${ruleCtx}.weightedValues[${j}]: value type "${wv.weightedValues[j].value.type}" does not match config valueType "${expectedValueType}"`,
            severity: 'error',
          })
        }

        // Check that each weighted value matches one of the defined variants
        if (variants.length > 0) {
          const serialized = JSON.stringify(wv.weightedValues[j].value)
          if (!variantValues.has(serialized)) {
            issues.push({
              file,
              message: `${ruleCtx}.weightedValues[${j}]: value does not match any defined variant`,
              severity: 'error',
              suggestion: `Weighted value must be one of the defined variants`,
            })
          }
        }
      }

      // Weight predicate (qfg-wis6.10): stored weights must be either an
      // even split (all weights equal and > 0) or percentages summing to
      // MAX_WEIGHT. Anything else was written by a broken client: evaluators
      // normalize by total, so it silently serves different percentages
      // than any display of the raw weights suggests.
      if (wv.weightedValues.length > 0) {
        const weights = wv.weightedValues.map((entry) => entry.weight)
        const total = weights.reduce((a, b) => a + b, 0)
        const evenSplit = weights[0] > 0 && weights.every((w) => w === weights[0])
        if (!evenSplit && total !== MAX_WEIGHT) {
          issues.push({
            file,
            message: `${ruleCtx}: weighted values must either be an even split (all weights equal and > 0) or sum to ${MAX_WEIGHT}; got [${weights.join(', ')}] summing to ${total}`,
            severity: 'error',
            suggestion: `Use equal weights for an even split, or make the weights sum to ${MAX_WEIGHT} (1000 units per percent).`,
          })
        }
      }
    }

    // Check criteria
    for (let j = 0; j < rule.criteria.length; j++) {
      const criterion = rule.criteria[j]
      const critCtx = `${ruleCtx}.criteria[${j}]`

      if (PROPERTY_OPERATORS.has(criterion.operator) && !criterion.propertyName) {
        issues.push({
          file,
          message: `${critCtx}: operator "${criterion.operator}" requires propertyName`,
          severity: 'error',
        })
      }

      if (VALUE_REQUIRED_OPERATORS.has(criterion.operator) && !criterion.valueToMatch) {
        issues.push({
          file,
          message: `${critCtx}: operator "${criterion.operator}" requires valueToMatch`,
          severity: 'error',
        })
      }
    }
  }
}

function collectSegmentReferences(config: z.infer<typeof StoredConfigSchema>): string[] {
  const refs: string[] = []

  function scanRules(rules: z.infer<typeof ConfigRuleSchema>[]) {
    for (const rule of rules) {
      for (const criterion of rule.criteria) {
        if (SEGMENT_OPERATORS.has(criterion.operator) && criterion.valueToMatch) {
          // The segment key is stored in the valueToMatch string value
          const val = criterion.valueToMatch
          if (val.type === 'string') {
            refs.push(val.value as string)
          } else if (val.type === 'string_list') {
            refs.push(...(val.value as string[]))
          }
        }
      }
    }
  }

  scanRules(config.default.rules)
  for (const env of config.environments) {
    scanRules(env.rules)
  }

  return refs
}

function typeToDir(type: string): string {
  for (const [dir, t] of Object.entries(DIR_TO_TYPE)) {
    if (t === type) return dir
  }
  return type
}

// ── Output formatting ───────────────────────────────────────────────────

export function formatResult(result: ValidationResult): string {
  const lines: string[] = []
  const s = result.stats

  if (result.valid) {
    lines.push(`OK: ${result.filesChecked} files checked, no errors found.\n`)
  } else {
    const errors = result.issues.filter((i) => i.severity === 'error')
    const warnings = result.issues.filter((i) => i.severity === 'warning')
    lines.push(`FAILED: ${errors.length} error(s), ${warnings.length} warning(s) in ${result.filesChecked} files.\n`)
  }

  // Show what was checked
  const fileCounts: string[] = []
  if (s.configs > 0) fileCounts.push(`${s.configs} configs`)
  if (s.featureFlags > 0) fileCounts.push(`${s.featureFlags} feature flags`)
  if (s.segments > 0) fileCounts.push(`${s.segments} segments`)
  if (s.logLevels > 0) fileCounts.push(`${s.logLevels} log levels`)
  if (s.schemas > 0) fileCounts.push(`${s.schemas} schemas`)

  if (fileCounts.length > 0) {
    lines.push(`  Files:       ${fileCounts.join(', ')}`)
  }

  const checks: string[] = []
  checks.push(
    `${result.filesChecked} JSON parsed`,
    `${result.filesChecked} schema-validated`,
    `${s.uniqueKeysVerified} unique keys`,
    `${s.rules} rules checked`,
  )
  if (s.environmentOverrides > 0) checks.push(`${s.environmentOverrides} env overrides`)
  if (s.segmentRefsChecked > 0) checks.push(`${s.segmentRefsChecked} segment refs`)
  if (s.schemaRefsChecked > 0) checks.push(`${s.schemaRefsChecked} schema refs`)
  if (s.envRefsChecked > 0) checks.push(`${s.envRefsChecked} env refs`)
  lines.push(`  Checks:      ${checks.join(', ')}`)

  // Group issues by file
  const byFile = new Map<string, ValidationIssue[]>()
  for (const issue of result.issues) {
    const existing = byFile.get(issue.file) || []
    existing.push(issue)
    byFile.set(issue.file, existing)
  }

  if (byFile.size > 0) {
    lines.push('')
  }

  for (const [file, fileIssues] of byFile) {
    lines.push(`  ${file}:`)
    for (const issue of fileIssues) {
      const prefix = issue.severity === 'error' ? 'ERROR' : 'WARN '
      lines.push(`    ${prefix}: ${issue.message}`)
      if (issue.suggestion) {
        lines.push(`           -> ${issue.suggestion}`)
      }
    }
    lines.push('')
  }

  if (result.issues.length > 0) {
    const warnings = result.issues.filter((i) => i.severity === 'warning')
    if (warnings.length > 0 && result.valid) {
      lines.push(`\n${warnings.length} warning(s) found.`)
    }
  }

  return lines.join('\n')
}
