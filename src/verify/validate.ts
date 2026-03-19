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

import { z } from "zod";

// ── Schemas (subset of app-quonfig config-schemas.ts) ───────────────────

const ConfigTypeSchema = z.enum([
  "feature_flag",
  "config",
  "log_level",
  "segment",
  "schema",
]);

const ValueTypeSchema = z.enum([
  "bool",
  "string",
  "int",
  "double",
  "json",
  "string_list",
  "duration",
  "log_level",
]);

const OperatorSchema = z.enum([
  "ALWAYS_TRUE",
  "PROP_IS_ONE_OF",
  "PROP_IS_NOT_ONE_OF",
  "PROP_STARTS_WITH_ONE_OF",
  "PROP_DOES_NOT_START_WITH_ONE_OF",
  "PROP_ENDS_WITH_ONE_OF",
  "PROP_DOES_NOT_END_WITH_ONE_OF",
  "PROP_CONTAINS_ONE_OF",
  "PROP_DOES_NOT_CONTAIN_ONE_OF",
  "PROP_LESS_THAN",
  "PROP_LESS_THAN_OR_EQUAL",
  "PROP_GREATER_THAN",
  "PROP_GREATER_THAN_OR_EQUAL",
  "PROP_BEFORE",
  "PROP_AFTER",
  "PROP_MATCHES",
  "PROP_DOES_NOT_MATCH",
  "IN_SEG",
  "NOT_IN_SEG",
  "IN_INT_RANGE",
  "LOOKUP_KEY_IN",
  "LOOKUP_KEY_NOT_IN",
]);

const LogLevelSchema = z.enum([
  "TRACE",
  "DEBUG",
  "INFO",
  "WARN",
  "ERROR",
  "FATAL",
]);

const BoolValueSchema = z.object({ type: z.literal("bool"), value: z.boolean() });
const StringValueSchema = z.object({ type: z.literal("string"), value: z.string() });
const IntValueSchema = z.object({ type: z.literal("int"), value: z.union([z.number(), z.string()]) });
const DoubleValueSchema = z.object({ type: z.literal("double"), value: z.union([z.number(), z.string()]) });
const JsonValueSchema = z.object({ type: z.literal("json"), value: z.unknown() });
const StringListValueSchema = z.object({ type: z.literal("string_list"), value: z.array(z.string()) });
const DurationValueSchema = z.object({ type: z.literal("duration"), value: z.string() });
const LogLevelValueSchema = z.object({ type: z.literal("log_level"), value: LogLevelSchema });
const SchemaValueSchema = z.object({
  type: z.literal("schema"),
  value: z.object({ schemaType: z.string(), schema: z.string() }),
});
const ProvidedValueSchema = z.object({
  type: z.literal("provided"),
  value: z.object({ source: z.string(), lookup: z.string() }),
});

const ValueSchema = z.discriminatedUnion("type", [
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
]);

const MAX_WEIGHT = 100_000;

const WeightedValueSchema = z.object({
  value: ValueSchema,
  weight: z.number().int().min(0).max(MAX_WEIGHT),
});

const WeightedValuesSchema = z.object({
  type: z.literal("weighted_values"),
  value: z.object({
    weightedValues: z.array(WeightedValueSchema),
    hashByPropertyName: z.string().default("user.key"),
    splitEvenly: z.boolean().optional(),
  }),
});

const RuleValueSchema = z.union([ValueSchema, WeightedValuesSchema]);

const CriterionSchema = z.object({
  propertyName: z.string().optional(),
  operator: OperatorSchema,
  valueToMatch: ValueSchema.optional(),
});

const ConfigRuleSchema = z.object({
  criteria: z.array(CriterionSchema),
  value: RuleValueSchema,
});

const ConfigEnvironmentSchema = z.object({
  id: z.string(),
  rules: z.array(ConfigRuleSchema),
});

const VariantSchema = z.object({
  id: z.string().optional(),
  key: z.string().optional(),
  value: ValueSchema,
  description: z.string().optional(),
});

const StoredConfigSchema = z.object({
  id: z.string().optional(),
  projectId: z.string().optional(),
  key: z.string(),
  type: ConfigTypeSchema,
  valueType: ValueTypeSchema,
  name: z.string().optional(),
  description: z.string().optional(),
  sendToClientSdk: z.boolean().default(false),
  schemaKey: z.string().optional(),
  accessLevel: z.string().optional(),
  protection: z.string().optional(),
  default: z.object({
    rules: z.array(ConfigRuleSchema),
  }),
  environments: z.array(ConfigEnvironmentSchema).default([]),
  variants: z.array(VariantSchema).default([]),
}).passthrough(); // Allow extra fields (tags, schemaUsageMode, etc.)

// ── Types ───────────────────────────────────────────────────────────────

export type Severity = "error" | "warning";

export interface ValidationIssue {
  file: string;
  message: string;
  severity: Severity;
  suggestion?: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  filesChecked: number;
  valid: boolean;
}

/** Maps directory names to their expected config type. */
const DIR_TO_TYPE: Record<string, string> = {
  "configs": "config",
  "feature-flags": "feature_flag",
  "segments": "segment",
  "log-levels": "log_level",
  "schemas": "schema",
};

const KNOWN_DIRS = new Set(Object.keys(DIR_TO_TYPE));

// Operators that reference segments
const SEGMENT_OPERATORS = new Set(["IN_SEG", "NOT_IN_SEG"]);

// Operators that require a propertyName
const PROPERTY_OPERATORS = new Set([
  "PROP_IS_ONE_OF", "PROP_IS_NOT_ONE_OF",
  "PROP_STARTS_WITH_ONE_OF", "PROP_DOES_NOT_START_WITH_ONE_OF",
  "PROP_ENDS_WITH_ONE_OF", "PROP_DOES_NOT_END_WITH_ONE_OF",
  "PROP_CONTAINS_ONE_OF", "PROP_DOES_NOT_CONTAIN_ONE_OF",
  "PROP_LESS_THAN", "PROP_LESS_THAN_OR_EQUAL",
  "PROP_GREATER_THAN", "PROP_GREATER_THAN_OR_EQUAL",
  "PROP_BEFORE", "PROP_AFTER",
  "PROP_MATCHES", "PROP_DOES_NOT_MATCH",
]);

// Operators that require a valueToMatch
const VALUE_REQUIRED_OPERATORS = new Set([
  ...PROPERTY_OPERATORS,
  "IN_SEG", "NOT_IN_SEG",
  "IN_INT_RANGE",
  "LOOKUP_KEY_IN", "LOOKUP_KEY_NOT_IN",
]);

// ── Validation from filesystem ──────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Validate an entire workspace directory on disk.
 */
export function validateWorkspace(workspaceDir: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  let filesChecked = 0;

  // Collect all configs for cross-reference checks
  const allConfigs: Array<{ key: string; type: string; dir: string; file: string }> = [];
  const segmentKeys = new Set<string>();
  const schemaKeys = new Set<string>();

  // Check for unexpected top-level entries
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
  } catch (err: unknown) {
    return {
      issues: [{
        file: workspaceDir,
        message: `Cannot read workspace directory: ${(err as Error).message}`,
        severity: "error",
      }],
      filesChecked: 0,
      valid: false,
    };
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip .git, .qf, etc.
    if (entry.isDirectory() && !KNOWN_DIRS.has(entry.name)) {
      issues.push({
        file: entry.name,
        message: `Unexpected directory "${entry.name}"`,
        severity: "warning",
        suggestion: `Expected directories: ${[...KNOWN_DIRS].join(", ")}`,
      });
    }
  }

  // First pass: parse all files and collect keys
  for (const dir of KNOWN_DIRS) {
    const dirPath = path.join(workspaceDir, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith("."));
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const relPath = `${dir}/${file}`;
      filesChecked++;

      // Read and parse JSON
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf-8");
      } catch (err: unknown) {
        issues.push({ file: relPath, message: `Cannot read file: ${(err as Error).message}`, severity: "error" });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err: unknown) {
        issues.push({
          file: relPath,
          message: `Invalid JSON: ${(err as Error).message}`,
          severity: "error",
        });
        continue;
      }

      // Validate against StoredConfigSchema
      const result = StoredConfigSchema.safeParse(parsed);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            file: relPath,
            message: `Schema: ${issue.path.join(".")} - ${issue.message}`,
            severity: "error",
          });
        }
        continue;
      }

      const config = result.data;
      const expectedKey = file.replace(/\.json$/, "");

      // Key matches filename
      if (config.key !== expectedKey) {
        issues.push({
          file: relPath,
          message: `Key "${config.key}" does not match filename "${expectedKey}"`,
          severity: "error",
          suggestion: `Rename file to "${config.key}.json" or set key to "${expectedKey}"`,
        });
      }

      // Key constraints
      validateKey(config.key, relPath, issues);

      // Config type matches directory
      const expectedType = DIR_TO_TYPE[dir];
      if (expectedType && config.type !== expectedType) {
        issues.push({
          file: relPath,
          message: `Type "${config.type}" in directory "${dir}" (expected "${expectedType}")`,
          severity: "error",
          suggestion: `Move to "${typeToDir(config.type)}/" or change type to "${expectedType}"`,
        });
      }

      // Type-specific constraints
      if (config.type === "segment") {
        if (config.valueType !== "bool") {
          issues.push({
            file: relPath,
            message: `Segment must have valueType "bool", got "${config.valueType}"`,
            severity: "error",
          });
        }
        if (config.sendToClientSdk) {
          issues.push({
            file: relPath,
            message: `Segment must have sendToClientSdk=false`,
            severity: "error",
          });
        }
        segmentKeys.add(config.key);
      }

      if (config.type === "log_level" && config.valueType !== "log_level") {
        issues.push({
          file: relPath,
          message: `Log level must have valueType "log_level", got "${config.valueType}"`,
          severity: "error",
        });
      }

      if (config.type === "schema") {
        schemaKeys.add(config.key);
      }

      // Validate rules
      validateRules(config.default.rules, relPath, "default", config.valueType, issues);
      for (const env of config.environments) {
        validateRules(env.rules, relPath, `environments[${env.id}]`, config.valueType, issues);
      }

      // Collect for cross-reference
      allConfigs.push({ key: config.key, type: config.type, dir, file: relPath });

      // Check schemaKey reference (collected, validated in second pass)
      if (config.schemaKey) {
        // Will be checked after all files are parsed
      }
    }
  }

  // Second pass: referential integrity
  for (const dir of KNOWN_DIRS) {
    const dirPath = path.join(workspaceDir, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith("."));
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const relPath = `${dir}/${file}`;

      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }

      const result = StoredConfigSchema.safeParse(parsed);
      if (!result.success) continue;

      const config = result.data;

      // Check segment references in criteria
      const segRefs = collectSegmentReferences(config);
      for (const ref of segRefs) {
        if (!segmentKeys.has(ref)) {
          issues.push({
            file: relPath,
            message: `References segment "${ref}" which does not exist`,
            severity: "error",
            suggestion: `Create segments/${ref}.json or remove the segment reference`,
          });
        }
      }

      // Check schemaKey references
      if (config.schemaKey && !schemaKeys.has(config.schemaKey)) {
        issues.push({
          file: relPath,
          message: `References schema "${config.schemaKey}" which does not exist`,
          severity: "error",
          suggestion: `Create schemas/${config.schemaKey}.json or remove schemaKey`,
        });
      }
    }
  }

  // Check for duplicate keys across directories
  const keyToFiles = new Map<string, string[]>();
  for (const c of allConfigs) {
    const existing = keyToFiles.get(c.key) || [];
    existing.push(c.file);
    keyToFiles.set(c.key, existing);
  }
  for (const [key, files] of keyToFiles) {
    if (files.length > 1) {
      issues.push({
        file: files.join(", "),
        message: `Duplicate key "${key}" found in multiple files`,
        severity: "error",
        suggestion: `Each key must be unique across the workspace`,
      });
    }
  }

  const hasErrors = issues.some(i => i.severity === "error");
  return { issues, filesChecked, valid: !hasErrors };
}

// ── Validate from in-memory file map (for git hook) ─────────────────────

/**
 * Validate configs provided as a map of { "dir/file.json": jsonString }.
 * Used by the pre-receive hook which reads files from git objects.
 */
export function validateFileMap(files: Map<string, string>): ValidationResult {
  const issues: ValidationIssue[] = [];
  let filesChecked = 0;

  const segmentKeys = new Set<string>();
  const schemaKeys = new Set<string>();
  const allConfigs: Array<{ key: string; file: string }> = [];
  const parsedConfigs: Array<{ relPath: string; config: z.infer<typeof StoredConfigSchema>; dir: string }> = [];

  for (const [relPath, content] of files) {
    const parts = relPath.split("/");
    if (parts.length < 2) continue;
    const dir = parts[0];
    const file = parts[parts.length - 1];

    if (!KNOWN_DIRS.has(dir)) continue;
    if (!file.endsWith(".json") || file.startsWith(".")) continue;

    filesChecked++;

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err: unknown) {
      issues.push({ file: relPath, message: `Invalid JSON: ${(err as Error).message}`, severity: "error" });
      continue;
    }

    const result = StoredConfigSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          file: relPath,
          message: `Schema: ${issue.path.join(".")} - ${issue.message}`,
          severity: "error",
        });
      }
      continue;
    }

    const config = result.data;
    const expectedKey = file.replace(/\.json$/, "");

    if (config.key !== expectedKey) {
      issues.push({
        file: relPath,
        message: `Key "${config.key}" does not match filename "${expectedKey}"`,
        severity: "error",
        suggestion: `Rename file to "${config.key}.json" or set key to "${expectedKey}"`,
      });
    }

    validateKey(config.key, relPath, issues);

    const expectedType = DIR_TO_TYPE[dir];
    if (expectedType && config.type !== expectedType) {
      issues.push({
        file: relPath,
        message: `Type "${config.type}" in directory "${dir}" (expected "${expectedType}")`,
        severity: "error",
        suggestion: `Move to "${typeToDir(config.type)}/" or change type to "${expectedType}"`,
      });
    }

    if (config.type === "segment") {
      if (config.valueType !== "bool") {
        issues.push({ file: relPath, message: `Segment must have valueType "bool", got "${config.valueType}"`, severity: "error" });
      }
      if (config.sendToClientSdk) {
        issues.push({ file: relPath, message: `Segment must have sendToClientSdk=false`, severity: "error" });
      }
      segmentKeys.add(config.key);
    }

    if (config.type === "log_level" && config.valueType !== "log_level") {
      issues.push({ file: relPath, message: `Log level must have valueType "log_level", got "${config.valueType}"`, severity: "error" });
    }

    if (config.type === "schema") schemaKeys.add(config.key);

    validateRules(config.default.rules, relPath, "default", config.valueType, issues);
    for (const env of config.environments) {
      validateRules(env.rules, relPath, `environments[${env.id}]`, config.valueType, issues);
    }

    allConfigs.push({ key: config.key, file: relPath });
    parsedConfigs.push({ relPath, config, dir });
  }

  // Referential integrity
  for (const { relPath, config } of parsedConfigs) {
    const segRefs = collectSegmentReferences(config);
    for (const ref of segRefs) {
      if (!segmentKeys.has(ref)) {
        issues.push({
          file: relPath,
          message: `References segment "${ref}" which does not exist`,
          severity: "error",
          suggestion: `Create segments/${ref}.json or remove the segment reference`,
        });
      }
    }
    if (config.schemaKey && !schemaKeys.has(config.schemaKey)) {
      issues.push({
        file: relPath,
        message: `References schema "${config.schemaKey}" which does not exist`,
        severity: "error",
        suggestion: `Create schemas/${config.schemaKey}.json or remove schemaKey`,
      });
    }
  }

  // Duplicate keys
  const keyToFiles = new Map<string, string[]>();
  for (const c of allConfigs) {
    const existing = keyToFiles.get(c.key) || [];
    existing.push(c.file);
    keyToFiles.set(c.key, existing);
  }
  for (const [key, fileList] of keyToFiles) {
    if (fileList.length > 1) {
      issues.push({
        file: fileList.join(", "),
        message: `Duplicate key "${key}" found in multiple files`,
        severity: "error",
      });
    }
  }

  const hasErrors = issues.some(i => i.severity === "error");
  return { issues, filesChecked, valid: !hasErrors };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function validateKey(key: string, file: string, issues: ValidationIssue[]): void {
  if (key.length === 0) {
    issues.push({ file, message: `Key is empty`, severity: "error" });
  }
  if (key.length > 512) {
    issues.push({ file, message: `Key exceeds 512 characters (${key.length})`, severity: "error" });
  }
  if (key === "new") {
    issues.push({ file, message: `Key cannot be "new" (reserved)`, severity: "error" });
  }
  if (/[/\\]/.test(key)) {
    issues.push({ file, message: `Key contains slash or backslash`, severity: "error" });
  }
}

function validateRules(
  rules: z.infer<typeof ConfigRuleSchema>[],
  file: string,
  context: string,
  expectedValueType: string,
  issues: ValidationIssue[],
): void {
  if (rules.length === 0) {
    issues.push({ file, message: `${context}: no rules defined`, severity: "warning" });
  }

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const ruleCtx = `${context}.rules[${i}]`;

    // Check value type consistency
    // Skip weighted_values (contains its own values), schema, and provided (special types)
    const SPECIAL_VALUE_TYPES = new Set(["weighted_values", "schema", "provided"]);
    if (!SPECIAL_VALUE_TYPES.has(rule.value.type)) {
      if (rule.value.type !== expectedValueType) {
        issues.push({
          file,
          message: `${ruleCtx}: value type "${rule.value.type}" does not match config valueType "${expectedValueType}"`,
          severity: "error",
        });
      }
    } else if (rule.value.type === "weighted_values") {
      // Validate weighted values
      const wv = (rule.value as z.infer<typeof WeightedValuesSchema>).value;
      if (wv.weightedValues.length === 0) {
        issues.push({ file, message: `${ruleCtx}: weighted values list is empty`, severity: "error" });
      }
      for (let j = 0; j < wv.weightedValues.length; j++) {
        if (wv.weightedValues[j].value.type !== expectedValueType) {
          issues.push({
            file,
            message: `${ruleCtx}.weightedValues[${j}]: value type "${wv.weightedValues[j].value.type}" does not match config valueType "${expectedValueType}"`,
            severity: "error",
          });
        }
      }
    }

    // Check criteria
    for (let j = 0; j < rule.criteria.length; j++) {
      const criterion = rule.criteria[j];
      const critCtx = `${ruleCtx}.criteria[${j}]`;

      if (PROPERTY_OPERATORS.has(criterion.operator) && !criterion.propertyName) {
        issues.push({
          file,
          message: `${critCtx}: operator "${criterion.operator}" requires propertyName`,
          severity: "error",
        });
      }

      if (VALUE_REQUIRED_OPERATORS.has(criterion.operator) && !criterion.valueToMatch) {
        issues.push({
          file,
          message: `${critCtx}: operator "${criterion.operator}" requires valueToMatch`,
          severity: "error",
        });
      }
    }
  }
}

function collectSegmentReferences(config: z.infer<typeof StoredConfigSchema>): string[] {
  const refs: string[] = [];

  function scanRules(rules: z.infer<typeof ConfigRuleSchema>[]) {
    for (const rule of rules) {
      for (const criterion of rule.criteria) {
        if (SEGMENT_OPERATORS.has(criterion.operator) && criterion.valueToMatch) {
          // The segment key is stored in the valueToMatch string value
          const val = criterion.valueToMatch;
          if (val.type === "string") {
            refs.push(val.value as string);
          } else if (val.type === "string_list") {
            refs.push(...(val.value as string[]));
          }
        }
      }
    }
  }

  scanRules(config.default.rules);
  for (const env of config.environments) {
    scanRules(env.rules);
  }

  return refs;
}

function typeToDir(type: string): string {
  for (const [dir, t] of Object.entries(DIR_TO_TYPE)) {
    if (t === type) return dir;
  }
  return type;
}

// ── Output formatting ───────────────────────────────────────────────────

export function formatResult(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.valid) {
    lines.push(`OK: ${result.filesChecked} files checked, no errors found.`);
  } else {
    const errors = result.issues.filter(i => i.severity === "error");
    const warnings = result.issues.filter(i => i.severity === "warning");
    lines.push(`FAILED: ${errors.length} error(s), ${warnings.length} warning(s) in ${result.filesChecked} files.\n`);
  }

  // Group issues by file
  const byFile = new Map<string, ValidationIssue[]>();
  for (const issue of result.issues) {
    const existing = byFile.get(issue.file) || [];
    existing.push(issue);
    byFile.set(issue.file, existing);
  }

  for (const [file, fileIssues] of byFile) {
    lines.push(`  ${file}:`);
    for (const issue of fileIssues) {
      const prefix = issue.severity === "error" ? "ERROR" : "WARN ";
      lines.push(`    ${prefix}: ${issue.message}`);
      if (issue.suggestion) {
        lines.push(`           -> ${issue.suggestion}`);
      }
    }
    lines.push("");
  }

  if (result.issues.length > 0) {
    const warnings = result.issues.filter(i => i.severity === "warning");
    if (warnings.length > 0 && result.valid) {
      lines.push(`\n${warnings.length} warning(s) found.`);
    }
  }

  return lines.join("\n");
}
