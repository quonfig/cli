# Quonfig CLI — Migration TODO

What's been done and what still needs to change to make this a fully functional Quonfig CLI.

## Done (Basic Rename)

- [x] Copied from `ReforgeHQ/cli`
- [x] Binary name: `reforge` -> `qfg`
- [x] Package name: `@reforge-com/cli` -> `@quonfig/cli`
- [x] npm scope: `@reforge-com/*` -> `@quonfig/*`
- [x] oclif config: bin/dirname set to `qfg`
- [x] Config directory: `~/.reforge/` -> `~/.quonfig/`
- [x] Config file: `reforge.config.json` -> `quonfig.config.json`
- [x] Environment variables: `REFORGE_*` -> `QUONFIG_*`
- [x] OAuth client ID: `reforge-cli-public` -> `quonfig-cli-public`
- [x] Default domain: `reforge.com` -> `quonfig.com`
- [x] App URL: `launch.reforge.com` -> `app.quonfig.com`
- [x] MCP entry key: `reforge-launch` -> `quonfig`
- [x] Class names: `Reforge` -> `Quonfig`, `ReforgeTypesafe*` -> `QuonfigTypesafe*`
- [x] All user-facing strings, descriptions, error messages
- [x] GitHub references: `ReforgeHQ/cli` -> `quonfig/cli`
- [x] Generated file names: `reforge-server.ts` -> `quonfig-server.ts`, etc.
- [x] Test helpers: directory paths, env vars
- [x] Git repo initialized
- [x] Version reset to 0.1.0

## Must Do — SDK & Dependency Changes

### 1. Replace `@quonfig/node` SDK dependency
The CLI currently depends on `@reforge-com/node` (renamed to `@quonfig/node` in package.json). This package doesn't exist yet.

**Options:**
- (a) Publish the existing `sdk-node` as `@quonfig/node` on npm
- (b) Fork `sdk-node` into `quonfig/sdk-node`, rename, publish
- (c) Use a local file dependency during development (`"@quonfig/node": "file:../sdk-node"`)

**Affected files:** `package.json`, `src/quonfig.ts`, all files importing from `@quonfig/node`

### 2. Replace `quonfig-common` submodule
The CLI uses a git submodule `src/quonfig-common` (was `reforge-common`) for shared types and API client. The submodule is currently empty.

**Imports from quonfig-common:**
- `src/api/client.js` — HTTP API client
- `src/types.js` — `ConfigValue`, `ConfigValueType`, `Config`
- `src/valueOf.js` — `valueOfToString`
- `src/valueType.js` — `valueTypeStringForConfig`
- `src/getProjectEnvFromSdkKey.js` — `ProjectEnvId`, `getProjectEnvFromSdkKey`
- `src/api/getEnvironmentsFromApi.js` — `Environment` type

**Options:**
- (a) Fork `reforge-common` into `quonfig/quonfig-common`, update submodule URL
- (b) Inline the needed types/code directly into the CLI (they're small)
- (c) Publish as `@quonfig/common` npm package

### 3. Replace `@quonfig/javascript` and `@quonfig/react` references
The codegen templates reference `@quonfig/javascript` and `@quonfig/react` for frontend SDK imports.

**Affected files:** `src/codegen/code-generators/react-typescript-generator.ts`

These packages need to exist when customers use the generated code.

## Must Do — Auth & API Changes

### 4. OAuth / Identity Service
The CLI authenticates via OAuth against `id.quonfig.com`:
- OAuth client ID is `quonfig-cli-public` — this client needs to be registered in whatever auth system Quonfig uses (WorkOS direct per spec)
- Token introspection endpoint: `GET {idUrl}/api/oauth/identity`
- Token exchange: `POST {idUrl}/oauth/token`

**Decision needed:** Will the CLI continue using OAuth PKCE flow, or switch to a different auth mechanism for WorkOS direct?

### 5. API Endpoints
The CLI talks to the Quonfig API via `api.quonfig.com`. All API paths match the current Reforge/Launch API:
- `/all-config-types/v1/*` — list, get configs
- `/feature-flags/v1/*` — CRUD flags
- `/configs/v1/*` — CRUD configs
- `/schemas/v1/*` — CRUD schemas
- `/environments/v1/*` — list environments

**These endpoints must be implemented in the Quonfig Node backend** (Epic 1) before the CLI is functional.

### 6. SDK default source URL
`src/quonfig.ts` line 41 still defaults to `https://api.prefab.cloud` for the SDK source. This should become the Quonfig delivery service URL once available.

```typescript
// Current:
options.sources = process.env.QUONFIG_API_URL ? [process.env.QUONFIG_API_URL] : ['https://api.prefab.cloud']
// Should become:
options.sources = process.env.QUONFIG_API_URL ? [process.env.QUONFIG_API_URL] : ['https://api.quonfig.com']
```

### 7. Context namespace
`src/quonfig.ts` line 15 uses `prefab-api-key` as the default context namespace. Decide whether to keep for backward compatibility or change to `quonfig-api-key`.

## Should Do — CLI Strategy Alignment

### 8. Align with spec Section 20 (CLI & Agent Strategy)
The spec outlines a P0/P1/P2 priority for CLI features:

**P0 (must have):**
- `--output json` on all commands (structured JSON envelope with `data` + `meta`) — currently uses oclif's `--json` which is close but may need envelope standardization
- Flag CRUD (`qfg create`, `qfg set-default`, `qfg list`, `qfg get`)
- `qfg eval` — local evaluation against git files (NEW command, doesn't exist yet)

**P1:**
- `--dry-run` on all mutations — returns diff/preview without modifying state (NEW)
- Schema introspection: `qfg schema flag`, `qfg schema operators`, `qfg <cmd> --describe` (NEW)
- `--fields` projection, `--env` filtering, `--count` mode (NEW flags)

**P2:**
- `qfg mcp serve` — MCP server surface (partially exists, needs expansion)
- Agent skill files — `.qf/agent-context.md`

### 9. New command: `qfg eval`
Spec calls for local evaluation: `qfg eval <key> --env <env> --context <json>`. Pure compute against local git files, no server required. This is a new command not in the Reforge CLI.

### 10. Direct git operations
The spec's unique value prop is that configs are JSON files in git. The CLI should support:
- Working against a local git checkout (not just API)
- `qfg eval` reads from local files
- Possibly `qfg diff`, `qfg validate` for pre-push checks

## Nice to Have — Cleanup

### 11. Remove Prefab-specific features
- `override` command — variant overrides are cut from Quonfig scope (spec Section 3)
- `serve` command — serves a Prefab-format datafile locally; may need rework for Quonfig format
- `download` command — downloads Prefab-format datafile; needs rework for Quonfig

### 12. Remove or update `generate` command
The codegen system generates TypeScript types from Prefab's config format. It needs to:
- Read from Quonfig's JSON config format (different structure)
- Generate imports from `@quonfig/node` and `@quonfig/javascript`/`@quonfig/react`

### 13. Update test fixtures
Test response mocks are based on the Prefab API. These need to match Quonfig API responses once the backend is built. Config key names in tests (`jeffreys.test.key.reforge`, `a.secret.config.reforge`) are harmless but could be updated.

### 14. npm registry / publishing
- Configure npm scope `@quonfig` on npm registry
- Update `.yarnrc.yml` registry mapping (currently has `quonfig:` scope pointing to `https://npm.pkg.github.com`)
- Set up GitHub Actions for publishing

### 15. CONTRIBUTING.md / README.md
- Full rewrite for Quonfig context
- Update setup instructions (no more submodule init for reforge-common)
- Update the fish shell dev command reference
