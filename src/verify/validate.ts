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
 *  - Key constraints (1-512 chars, no slashes, not "new")
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

const OperatorSchema = z.enum([
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
])

// Operators that require a valueToMatch
const VALUE_REQUIRED_OPERATORS = new Set([
  ...PROPERTY_OPERATORS,
  'IN_SEG',
  'NOT_IN_SEG',
  'IN_INT_RANGE',
  'LOOKUP_KEY_IN',
  'LOOKUP_KEY_NOT_IN',
])

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

  // First pass: parse all files and collect keys
  for (const dir of KNOWN_DIRS) {
    const dirPath = path.join(workspaceDir, dir)
    if (!fs.existsSync(dirPath)) continue

    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json') && !f.startsWith('.'))
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

  // Second pass: referential integrity
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

  // Check for duplicate keys across directories
  const keyToFiles = new Map<string, string[]>()
  for (const c of allConfigs) {
    const existing = keyToFiles.get(c.key) || []
    existing.push(c.file)
    keyToFiles.set(c.key, existing)
  }
  for (const [key, files] of keyToFiles) {
    if (files.length > 1) {
      issues.push({
        file: files.join(', '),
        message: `Duplicate key "${key}" found in multiple files`,
        severity: 'error',
        suggestion: `Each key must be unique across the workspace`,
      })
    }
  }

  const schemaKeyToFiles = new Map<string, string[]>()
  for (const schemaFile of allSchemaFiles) {
    const existing = schemaKeyToFiles.get(schemaFile.key) || []
    existing.push(schemaFile.file)
    schemaKeyToFiles.set(schemaFile.key, existing)
  }
  for (const [key, files] of schemaKeyToFiles) {
    if (files.length > 1) {
      issues.push({
        file: files.join(', '),
        message: `Duplicate schema key "${key}" found in multiple files`,
        severity: 'error',
        suggestion: `Each schema key must be unique across schema directories`,
      })
    }
  }

  stats.uniqueKeysVerified = keyToFiles.size + schemaKeyToFiles.size

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
    if (!file || !file.endsWith('.json') || file.startsWith('.')) continue

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

  // Duplicate keys
  const keyToFiles = new Map<string, string[]>()
  for (const c of allConfigs) {
    const existing = keyToFiles.get(c.key) || []
    existing.push(c.file)
    keyToFiles.set(c.key, existing)
  }
  for (const [key, fileList] of keyToFiles) {
    if (fileList.length > 1) {
      issues.push({
        file: fileList.join(', '),
        message: `Duplicate key "${key}" found in multiple files`,
        severity: 'error',
      })
    }
  }

  const schemaKeyToFiles = new Map<string, string[]>()
  for (const schemaFile of allSchemaFiles) {
    const existing = schemaKeyToFiles.get(schemaFile.key) || []
    existing.push(schemaFile.file)
    schemaKeyToFiles.set(schemaFile.key, existing)
  }
  for (const [key, fileList] of schemaKeyToFiles) {
    if (fileList.length > 1) {
      issues.push({
        file: fileList.join(', '),
        message: `Duplicate schema key "${key}" found in multiple files`,
        severity: 'error',
      })
    }
  }

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

function validateKey(key: string, file: string, issues: ValidationIssue[]): void {
  if (key.length === 0) {
    issues.push({file, message: `Key is empty`, severity: 'error'})
  }
  if (key.length > 512) {
    issues.push({file, message: `Key exceeds 512 characters (${key.length})`, severity: 'error'})
  }
  if (key === 'new') {
    issues.push({file, message: `Key cannot be "new" (reserved)`, severity: 'error'})
  }
  if (/[/\\]/.test(key)) {
    issues.push({file, message: `Key contains slash or backslash`, severity: 'error'})
  }
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
