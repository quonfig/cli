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

## Quick start (works fully offline — no account required)

This workspace is just a git repo full of JSON files. You can edit those files
directly, validate them locally, and point any Quonfig SDK at this directory.
No login, no API call, no internet connection needed.

\`\`\`bash
# 1. Edit a flag — see the sample files in feature-flags/ for the shape.
$EDITOR feature-flags/my.new.flag.json

# 2. Validate the workspace.
qfg verify

# 3. (Optional) Generate TypeScript types for your app.
qfg generate

# 4. Commit. The pre-commit hook re-runs qfg verify automatically.
git add . && git commit -m "Add my.new.flag"
\`\`\`

## Two ways to use this repo

**Open-source / fully local.** Edit JSON, run \`qfg verify\`, point your SDK
at this directory (\`datadir: "./quonfig"\`). Push the repo wherever you want
(GitHub, self-hosted Gitea, your own server). This is the no-account path.

**Hosted Quonfig.** If you also have a Quonfig account, server-side commands
like \`qfg push\`, \`qfg create\`, \`qfg list\`, \`qfg set-default\`, and
\`qfg get\` give you a UI, real-time SSE delivery to SDKs, evaluation
telemetry, and audit history. These all require \`qfg login\`.

## Local-only commands (no login required)

| Command | What it does |
|---------|--------------|
| \`qfg init\` | Re-initialize this workspace (idempotent, refreshes templates) |
| \`qfg verify\` | Validate every JSON file against the schema and cross-file rules |
| \`qfg generate\` | Generate typed SDK client code from the configs in this dir |
| \`qfg config-schema\` | Print the canonical config schema (great for AI agents) |
| \`qfg migrate\` | Import flags from LaunchDarkly, Flagsmith, etc. |

## Schema

Config files reference the hosted JSON Schema at <https://api.quonfig.com/schemas/v1/stored-config.json> via their \`$schema\` field. Editors that support JSON Schema will provide autocomplete and validation automatically. The schema URL is fetched once by your editor's LSP — the CLI and SDK don't need it.

## Validation

Run \`qfg verify\` after every change. A git pre-commit hook is installed to do this automatically.
`
}

// ── CLAUDE.md ──────────────────────────────────────────────────────────

export function claudeMdTemplate(): string {
  return `${MANAGED_HEADER}

# Quonfig Workspace — Agent Reference

This is a Quonfig workspace repository. Configuration is stored as JSON files in git.

## How to work in this repo

**You edit JSON files directly.** Do not run \`qfg create\`, \`qfg set-default\`,
\`qfg set-rollout\`, \`qfg override\`, \`qfg push\`, \`qfg pull\`, \`qfg get\`,
or \`qfg list\` — those commands talk to a hosted Quonfig server. In a local
workspace, the source of truth is this git repo, so edit JSON in place.

The complete local-only toolkit:

| Command | When to use |
|---------|-------------|
| \`qfg verify\` | After every change. Validates schema + cross-file rules. |
| \`qfg config-schema\` | Print the canonical schema. Use this to look up field names, operator enums, value-type shapes before you write a new config. |
| \`qfg generate\` | Regenerate typed SDK client code (consumers ask for this; you usually won't need to run it unless asked). |
| Read existing files | Look at sibling JSON files in the same directory for the canonical shape before writing a new one. |

**After every change to this repo, run \`qfg verify\` to validate.** If it
fails, fix the JSON until it passes — do not ship a broken workspace.

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

1. **Edit JSON files directly.** Do NOT use \`qfg create\`, \`qfg set-default\`, \`qfg push\`, \`qfg get\`, or \`qfg list\` — those require a hosted Quonfig account. The source of truth here is the git repo.
2. **Always validate**: run \`qfg verify\` after any change to this repo.
3. **Look before you leap**: read sibling JSON files for the canonical shape, and run \`qfg config-schema\` to confirm field names, operator enums, and value types before writing a new config.
4. Filename must match the \`key\` field (e.g. \`my.flag.json\` has \`"key": "my.flag"\`).
5. Files must be in the correct directory for their \`type\`.
6. See \`CLAUDE.md\` for the full list of value types, operators, and constraints.

## \`qfg\` or the Quonfig MCP?

Only relevant if this workspace is *also* hosted on a Quonfig account. On the
fully-local path, editing the JSON in this repo is the whole story.

- **This repo is checked out and you have a shell** -> use \`qfg\`. The files are
  already on disk, so reading them costs nothing.
- **Slack, claude.ai, or anywhere without a checkout** -> use the Quonfig MCP
  server. It reads and writes the hosted workspace directly. Do not try to shell
  out to \`qfg\` from a surface that has no repo.

Both surfaces cover the same everyday loop — create a flag or config, change what
an environment serves, set a log level. (\`qfg\` has all of it today; the MCP's
create/config/log-level verbs land with its v2 write surface.)

## Setting a value KEEPS that environment's targeting rules

Both surfaces write the same way, so learn it once:

\`qfg set-default\` (alias \`toggle\`), \`qfg set-rollout\`, and the MCP
\`set_flag\`/\`set_config\` verbs replace exactly ONE rule — the environment's
**fallback**, the unconditional rule at the end of its rule list that decides
what users receive when no targeting rule matches. Every targeting rule above
it is kept, and both surfaces report how many. An environment with no rules of
its own has them copied from default first, so inherited targeting is kept too.

| Surface | By default | To set the value for EVERYONE |
|---------|------------|-------------------------------|
| \`qfg set-default\` / \`qfg set-rollout\` | Keeps targeting; reports "Kept N targeting rule(s)" | add \`--replace-targeting\` |
| MCP \`set_flag\` / \`set_config\` | Keeps targeting; reports the kept count in its result | send \`replaceTargeting: true\` |

Setting the value for everyone DELETES that environment's targeting rules. They
stay in git history, and the write returns a \`previousCommitSha\` to restore from.

**Still read before you write.** \`qfg info <key>\` (or MCP \`get_flag\`) shows the
rules your value is about to sit next to. For anything a fallback cannot express —
multi-rule targeting, reordering, editing one targeting rule — edit the JSON
directly or use MCP \`set_document\`.

\`qfg log-level --target ...\` and MCP \`set_log_level\` are **surgical** in the same
way: they upsert the level for the loggers you name and leave every other rule in
place.
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
