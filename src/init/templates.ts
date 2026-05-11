/**
 * Managed document templates for `qfg init`.
 *
 * These are overwritten on every run of `qfg init` — they are not
 * user-editable.  Each starts with a comment so users know not to
 * hand-edit them.
 */

const MANAGED_HEADER = '<!-- Managed by `qfg init` — do not edit manually. Run `qfg init` to update. -->'

// ── README.md ──────────────────────────────────────────────────────────

export function readmeTemplate(): string {
  return `${MANAGED_HEADER}

# Quonfig Workspace

This is a [Quonfig](https://quonfig.com) workspace repository. All configuration — feature flags, configs, segments, log levels, and schemas — is stored as JSON files tracked in git.

## Directory layout

| Directory | What goes here |
|-----------|---------------|
| \`configs/\` | Application configuration (strings, ints, JSON, etc.) |
| \`feature-flags/\` | Boolean or multi-variant feature flags |
| \`segments/\` | Audience segments for targeting rules |
| \`log-levels/\` | Dynamic log level configuration |
| \`schemas/\` | JSON Schemas that configs can reference for validation |
| \`schemas-protected/\` | Admin-only schemas |

## Quick start

\`\`\`bash
# Validate the workspace
qfg verify

# Create a new feature flag
qfg create my.new.flag --type=boolean-flag

# List all configs
qfg list
\`\`\`

## Schema

Config files reference the hosted JSON Schema at <https://api.quonfig.com/schemas/v1/stored-config.json> via their \`$schema\` field. Editors that support JSON Schema will provide autocomplete and validation automatically.

## Validation

Run \`qfg verify\` after every change. A git pre-commit hook is installed to do this automatically.
`
}

// ── CLAUDE.md ──────────────────────────────────────────────────────────

export function claudeMdTemplate(): string {
  return `${MANAGED_HEADER}

# Quonfig Workspace — Agent Reference

This is a Quonfig workspace repository. Configuration is stored as JSON files in git.

**After every change to this repo, run \`qfg verify\` to validate.**

## JSON Schema

The canonical schema for config files is hosted at <https://api.quonfig.com/schemas/v1/stored-config.json>. Use it as the source of truth for field names, types, enums, and constraints.

Config files can reference it for editor support:

\`\`\`json
{ "$schema": "https://api.quonfig.com/schemas/v1/stored-config.json", "key": "my.config", ... }
\`\`\`

## Directory Structure

Files must live in the directory matching their \`type\`. The filename (without \`.json\`) must exactly match the \`key\` field.

| Directory | Config \`type\` field | Description |
|-----------|---------------------|-------------|
| \`configs/\` | \`"config"\` | Application configuration values |
| \`feature-flags/\` | \`"feature_flag"\` | Boolean or multi-variant feature flags |
| \`segments/\` | \`"segment"\` | Audience segments for targeting rules |
| \`log-levels/\` | \`"log_level"\` | Dynamic log level configuration |
| \`schemas/\` | \`"schema"\` | JSON Schemas that configs can reference |
| \`schemas-protected/\` | \`"schema"\` | Protected schemas (admin-only) |

## Minimal Example

\`\`\`json
{
  "$schema": "https://api.quonfig.com/schemas/v1/stored-config.json",
  "key": "my-app.timeout",
  "type": "config",
  "valueType": "int",
  "default": {
    "rules": [
      {
        "criteria": [{ "operator": "ALWAYS_TRUE" }],
        "value": { "type": "int", "value": 30 }
      }
    ]
  },
  "environments": [],
  "variants": []
}
\`\`\`

## Rules and Criteria

The \`default\` block (and each environment override) contains a \`rules\` array. Rules are evaluated in order; the first rule whose criteria all match wins. All criteria within one rule are ANDed. Use multiple rules for OR logic.

### Operator quick reference

| Category | Operators | Required fields |
|----------|-----------|----------------|
| Always match | \`ALWAYS_TRUE\` | (none) |
| Property string | \`PROP_IS_ONE_OF\`, \`PROP_IS_NOT_ONE_OF\`, \`PROP_STARTS_WITH_ONE_OF\`, \`PROP_ENDS_WITH_ONE_OF\`, \`PROP_CONTAINS_ONE_OF\` + negative variants | \`propertyName\`, \`valueToMatch\` |
| Property comparison | \`PROP_LESS_THAN\`, \`PROP_LESS_THAN_OR_EQUAL\`, \`PROP_GREATER_THAN\`, \`PROP_GREATER_THAN_OR_EQUAL\` | \`propertyName\`, \`valueToMatch\` |
| Property date | \`PROP_BEFORE\`, \`PROP_AFTER\` | \`propertyName\`, \`valueToMatch\` |
| Property regex | \`PROP_MATCHES\`, \`PROP_DOES_NOT_MATCH\` | \`propertyName\`, \`valueToMatch\` |
| Property presence | \`IS_PRESENT\`, \`IS_NOT_PRESENT\` | takes only \`propertyName\` |
| Segment | \`IN_SEG\`, \`NOT_IN_SEG\` | \`valueToMatch\` (segment key) |
| Other | \`IN_INT_RANGE\`, \`LOOKUP_KEY_IN\`, \`LOOKUP_KEY_NOT_IN\` | \`valueToMatch\` |

See <https://api.quonfig.com/schemas/v1/stored-config.json> for the full operator enum and value type definitions.

## Environments

Environment overrides go in the \`environments\` array. Each has an \`id\` (lowercase slug like \`production\`, never a UUID) and its own \`rules\` array. Environment IDs are defined in \`quonfig.json\` at the repo root.

## Cross-File Validation Rules

These constraints span multiple files and are enforced by \`qfg verify\` (not expressible in the JSON Schema alone):

1. **Filename = key**: the JSON filename (without .json) must exactly match the \`key\` field
2. **No duplicate keys** across the entire workspace
3. **Segment references** (\`IN_SEG\`/\`NOT_IN_SEG\`) must point to existing segments in \`segments/\`
4. **Schema references** (\`schemaKey\`) must point to existing files in \`schemas/\` or \`schemas-protected/\`
`
}

// ── AGENTS.md ──────────────────────────────────────────────────────────

export function agentsMdTemplate(): string {
  return `${MANAGED_HEADER}

# Agent Instructions

This is a Quonfig workspace repository. See \`CLAUDE.md\` for the complete schema reference and validation rules.

## Key rules

1. **Always validate**: run \`qfg verify\` after any change to this repo.
2. Filename must match the \`key\` field (e.g. \`my.flag.json\` has \`"key": "my.flag"\`).
3. Files must be in the correct directory for their \`type\`.
4. See \`CLAUDE.md\` for the full list of value types, operators, and constraints.
`
}

// ── Pre-commit hook ────────────────────────────────────────────────────

export const PRE_COMMIT_MARKER = '# --- qfg-verify ---'

export function preCommitHookContent(): string {
  return `#!/bin/sh
${PRE_COMMIT_MARKER}
# Validate workspace before committing.
# Installed by \`qfg init\`. Safe to remove if you prefer manual validation.
qfg verify .
`
}
