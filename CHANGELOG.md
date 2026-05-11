# Changelog

## 0.0.45 - 2026-05-11

- fix(qfg-c3es): bump the hosted JSON Schema URL in `qfg init` templates to `https://api.quonfig.com/schemas/v1/stored-config.json`. 0.0.44 advertised an unversioned URL that didn't actually exist as a route (Next.js served the schema at `/api/schemas/...` while the templates pointed at `/schemas/...`, which 307'd to WorkOS auth on production). app-quonfig now serves the schema at the versioned, no-`/api/`-prefix path; this release aligns the workspace templates so newly-emitted `$schema` references resolve. The `/v1/` segment also gives us an immutable-`$id` escape hatch — future breaking changes ship as `/v2/...` instead of mutating in place.

## 0.0.44 - 2026-05-11

- feat(qfg-sv3c): `qfg init` no longer emits a per-workspace `quonfig.schema.json`. The README.md, CLAUDE.md, and AGENTS.md templates now reference the hosted JSON Schema at `https://api.quonfig.com/schemas/stored-config.json` (served by app-quonfig as of qfg-c3es), so every workspace gets the current schema without needing to re-run `qfg init`. Existing stale `quonfig.schema.json` files in customer repos are left untouched — explicit non-migration decision; they're harmless and the hosted URL takes precedence in `$schema` references. `src/init/schema.ts` is kept (not deleted) because `qfg config-schema --json-schema` and the operator-parity test still import `storedConfigJsonSchema()`.
- fix(schema): align the hand-curated `storedConfigJsonSchema()` with the Zod `StoredConfigSchema` source-of-truth in app-quonfig. Adds the `readyForCleanup` property (added to Zod in qfg-580q, never ported here) and renames `variant.key` → `variant.name` to match the Zod (the cli copy was stale; no workspace data references either field name). Drift surfaced by the new cross-repo drift check in qfg-svmx; the check now reports "No drift detected".

## 0.0.43 - 2026-05-10

- chore(qfg-y7xh): bump `engines.node` floor to `>=20.9.0` to align with the rest of the Quonfig SDK family (Node 20.9 is the minimum LTS that supports `fetch`, `--import`, and the global `crypto` shape we rely on).
- feat(qfg-7jnb.8): `qfg verify` accepts `IS_PRESENT` and `IS_NOT_PRESENT` operators in rule criteria. (Also shipped in 0.0.42; included here for the intentional release-commit gap that 0.0.42's tag covered.)
- fix(qfg-3fc6): `qfg push` on the clone path now picks up untracked files in the working tree instead of silently skipping anything not yet `git add`'d. The clone-path stager was using `git diff --name-only` against `HEAD`, which by definition only sees tracked files; switched to a `git status --porcelain`-based enumeration that includes `??` entries so a brand-new config file gets pushed on first try.
- ci(qfg-uzoo): the cli repo now runs `lint`, `prettier`, `build`, and `test` on every push to `main` (not just PRs) so an admin-merge through a red PR can't silently land a regression. Three "not logged in" tests were leaking the user's real `~/.quonfig/tokens.json` via process-wide env state and have been migrated to the `setupTestAuth` / `cleanupTestAuth` helpers that redirect `~/.quonfig/` to a per-test tmp dir via `QUONFIG_CONFIG_HOME`.
- fix(qfg-3uks): `qfg push --no-interactive` now aborts with a specific, actionable error when the gitea token mint step fails (e.g. expired session, missing scope) instead of silently falling back to an interactive prompt that no automation can answer. The same mint-failure path on the bare-token bootstrap now reports the underlying gitea error rather than a generic "auth failed".
- chore(cli): expand the published `package.json` `description` with a one-liner showing `qfg run` usage so the npm registry page surfaces the new env-injection workflow. Add `.beads/` to `.gitignore`.

## 0.0.42 - 2026-05-07

- feat(qfg-7jnb.8): `qfg verify` accepts `IS_PRESENT` and `IS_NOT_PRESENT` operators in rule criteria. These take only `propertyName` and intentionally have no `valueToMatch`. The verify schema's `OperatorSchema` enum, the `PROPERTY_OPERATORS` set (so missing `propertyName` is still flagged), and the Launch migrator allowlist are all extended in lockstep — the existing parity test asserts the migrator and verify enums never drift. The `qfg init` operator-reference table and `qfg config-schema` REFERENCE table both get a new presence-operator row.
- fix(qfg-7jnb.8): the `QUONFIG_SUPPORTED_OPERATORS` parity test (`test/migrate/operator-validation.test.ts`) now reads the runtime-exported `OPERATORS` tuple from `src/verify/validate.ts` instead of regex-matching an inline `z.enum([...])` literal. The regex hadn't matched since `OPERATORS` was extracted into a `const` (and `z.enum(OPERATORS)` was substituted in its place), so the lockstep guard had been silently failing on `null` — fixed and now actually enforces parity.

## 0.0.41 - 2026-05-06

- fix(qfg-84df): `qfg create … --env-var=X` and `qfg set-default … --env-var=X` no longer fail with `defaultValue.value: Invalid input: expected string, received undefined`. The CLI was emitting `{type: '<scalar>', provided: {…}}`, but the API's `ProvidedValueSchema` is a Zod discriminated union expecting `{type: 'provided', value: {source, lookup}}`. Both write paths now emit the correct shape via the shared `mapConfigValueToDto` helper. Unblocks the encryption-key bootstrap (`qfg create quonfig.secrets.encryption.key --type string --env-var=QUONFIG_ENCRYPTION_KEY`).

## 0.0.40 - 2026-05-06

- feat(qfg-4jya): new `qfg run` command wraps a child process with Quonfig values resolved into env vars — for build steps, migrations, and one-shot scripts that read config from `process.env` before user code runs (e.g. `drizzle-kit migrate`, `next-auth`'s `AUTH_SECRET`). Inline form `qfg run --env DATABASE_URL=db.url -- drizzle-kit migrate` and env-file form `qfg run --env-file=.qfg.env -- next build`. Required `--` separates qfg flags from the child command. Default behavior overrides parent env (`--preserve-env` to skip already-set vars). Fail-fast on missing keys before spawning the child. Auth/environment uses a binary mutually-exclusive rule: Mode A (`QUONFIG_BACKEND_SDK_KEY` set, env encoded in key — error if `--environment` or `QUONFIG_ENVIRONMENT` is also set, even if they would agree) or Mode B (no SDK key, requires exactly one of `--environment` or `QUONFIG_ENVIRONMENT`). Companion docs site update tracked separately (qfg-kj0e).

## 0.0.39 - 2026-05-06

- fix(qfg-57q): `qfg generate` no longer crashes with `template.match is not a function` on workspaces that contain a `weighted_values` rule. The `local-config-reader.mapGitValue` default branch was casting the weighted-values wrapper object into `valueObj.value.string`, and downstream codegen called `.match()` on the object from `MustacheExtractor`. The fix expands `weighted_values` rules into N row values (one per variant) so codegen sees real strings, drops unknown rule types instead of corrupting `value.string`, and adds defensive type guards in `MustacheExtractor.extractSchema` and `SchemaExtractor.getAllStringsAtLocation` so a future malformed row can't crash codegen. JSON-typed configs were always handled correctly via `resolveUserSchema` + `jsonSchemaToZod`; the original bug report's diagnosis ("JSON configs break codegen") was a misattribution — the actual trigger was a sibling string config with a weighted-values rule.

## 0.0.38 - 2026-05-05

- feat(qfg-d6cn): new `qfg activity` namespace surfaces audit-log / history events, with `qfg audit-log`, `qfg history`, and `qfg log` aliases pointing at the same command.
- fix(qfg-kemk): `qfg info` now passes the environment **name** (not UUID) to `evaluationStats`, fixing the empty-stats output users saw when scoping `qfg info` to a specific environment.

## 0.0.37 - 2026-05-03

- feat: `qfg push` sends `expectedSha = origin/main HEAD sha at fetch time` to the server-side `configs.push` optimistic lock (qfg-gj3i). CLI half of the atomic flip with the upcoming app-quonfig change that makes the server enforce this. Bare-path pushes (no `.git/`) omit the field entirely so the server applies its bare-path lock policy unchanged.

## 0.0.36 - 2026-05-03

- feat(qfg-0q1f): `qfg verify` accepts `PROP_SEMVER_LESS_THAN`, `PROP_SEMVER_EQUAL`, and `PROP_SEMVER_GREATER_THAN` operators in rule criteria. Schema's `OperatorSchema` extended; parity test asserts the migrator allowlist stays in lockstep.
- feat(qfg-0q1f): Launch migrator now passes `PROP_SEMVER_*` rules through to the output config instead of skipping them as unsupported. Resolves the FormHealth migration blocker on mobile-app-version-gated flags (qfg-l18w).

## 0.0.35 - 2026-05-03

- fix(qfg-7eig): `MIGRATION_REPORT.md` Counts section now reflects what was actually written to disk per type (flags, configs, segments, schemas, log-levels) instead of the source change-event count. The migrator commit message uses the same per-type summary (e.g. `migrator: imported 166 flag(s), 142 config(s), 1 segment(s) from launch`) instead of `migrator: import 5332 change(s)`.
- fix(qfg-qhk1): migrator now normalizes `/` to `.` in source keys so outputs are always flat `<type-dir>/<key>.json`. Detects post-normalization key collisions and throws `MigratorKeyCollisionError` with both colliding source keys named. Refuses to write nested paths if a translate() emits one. Cleans up empty parent dirs left over from legacy nested layouts on tombstone.
- fix(qfg-l18w): migrator validates rule operators against the Quonfig schema at migrate time. Configs whose rules use unsupported operators (e.g. `PROP_SEMVER_*`) are now per-config skipped — the offending key lands in `MIGRATION_REPORT.md`'s "Skipped invalid configs" section with the operator name(s) listed, instead of silently writing JSON that fails at qfg-verify. A parity test asserts the migrator's allowlist stays in lockstep with verify's `OperatorSchema`.
- fix(qfg-fbh0): when `qfg migrate --push` refuses to clobber a local dir whose origin doesn't match the target, the error now names the most likely cause (you ran `qfg migrate --dir` first, which `git init`'d a no-remote repo) and lists two concrete fixes (re-run with `--push` against a NEW empty path, or `qfg pull` first then re-run). Docs at https://docs.quonfig.com/docs/migrating/from-launch updated to use the proven single-command flow.

## 0.0.34 - 2026-05-03

- fix: `qfg push` refuses to run when local HEAD is behind or has diverged from origin/main. Previously the clone-path push computed `HEAD..origin/main` after fetch and shipped the _reversal_ deltas to the server, silently undoing any commits landed since the user's last `qfg pull`. Working-tree edits the user had not committed were also dropped without warning. Now throws `STALE_HEAD` with a "run `qfg pull` first" message, and warns about every dirty tracked file so the user knows their uncommitted edits were not pushed (qfg-fboj). The same guard also covers the delete-vs-edit silent-revival case (qfg-0j59).
- feat: `qfg pull --rebase` invokes `git pull --rebase origin main` to replay local commits on top of origin. Conflicts are surfaced via standard git markers with a step-by-step recovery recipe (resolve markers → `git add` → `git rebase --continue` → `qfg push`, plus `git rebase --abort` as the escape hatch) (qfg-4tey).
- fix: `qfg pull` divergence error now lists concrete recovery options (rebase vs `git reset --hard origin/main`) with the directory path filled in, instead of the previous "resolve manually" message that left non-git-savvy users stranded.

## 0.0.24 - 2026-04-28

- feat: `qfg login` now opens the WorkOS verification URL in the browser when the user presses Enter. Polling for the device-code token continues regardless, so manual paste still works exactly as before.
- style: prettier --write across the codebase — 20 files reformatted with no semantic changes.

## 0.0.23 - 2026-04-28

- feat: `qfg push` now produces a JSON diff and POSTs it to the new server-side `configs.push` oRPC procedure instead of running `git push` against Gitea with a user-held write token. Surfaces per-file permission denials and conflict→pull-and-retry hints. The bootstrap and migrate carve-outs still mint a write-PAT (qfg-azk.13).
- feat: `qfg verify` validates the renamed `access` enum (`support`, `standard`, `protected-env`, `protected-all-envs`) on configs. Drops the unused `protection` field. JSON Schema generator emits the new enum (qfg-azk.1).
- fix: test-auth-helper now redirects `~/.quonfig/` to a per-test tmp dir via a new `QUONFIG_CONFIG_HOME` env var. Previously `setupTestAuth`/`cleanupTestAuth` overwrote and unlinked the user's real `~/.quonfig/tokens.json` and `~/.quonfig/config` on every CLI test run.

## 0.0.22 - 2026-04-27

- feat: `qfg delete <key>` — server-mediated delete that resolves the key's type via `metadata.list` and dispatches to the existing flags/configs/logLevels delete oRPC endpoints. Confirmation required: `--yes` for scripts, otherwise an interactive type-back prompt; refuses to proceed when stdin is not a TTY without `--yes` (qfg-88a).
- feat: `qfg delete` threads `expectedCommitSha` from `metadata.list` and retries once on a 409 conflict by parsing the fresh SHA from the server message — matches the override pattern (qfg-o2s).
- fix: SDK-key eval path no longer defaults to the dead `api.quonfig.com` hostname. The CLI now resolves the delivery URL via a new `getDeliveryUrl()` helper that returns `QUONFIG_API_URL` if set, else `https://primary.${QUONFIG_DOMAIN || 'quonfig.com'}`. Staging users with `QUONFIG_DOMAIN=quonfig-staging.com` automatically pick up `primary.quonfig-staging.com` with no extra env var.

## 0.0.21 - 2026-04-26

- feat: `qfg override <flag> <value>` rewritten against the new oRPC `flags/findOrCreateOverride` endpoint. Previous releases pointed at the dead Prefab `/internal/ops/v1/assign-variant` endpoint and failed with `Unexpected token <` (qfg-pj0.6, qfg-pj0.1).
- feat: `qfg create --type duration` for ISO-8601 duration configs (qfg-n53).
- feat: `qfg generate` works without `--dir` by cloning the workspace into a tmp dir (qfg-0mj).
- fix: `qfg login` verifies token and config writes actually persisted before reporting success (qfg-2qj).
- fix: recover auth config from existing tokens before declaring `Not logged in` (qfg-ogr).
- fix: codegen `JSON.stringify`s object-form JSON default values; surfaces a clearer hint when `mustache` isn't installed.

## 0.0.20 - 2026-04-24

- chore: fix stale `'gen' command` string in the autogen header emitted by `qfg generate` (both node-ts and react-ts targets). The command has been named `generate` since the Reforge fork; the comment now matches.

  Note: `qfg generate --targets node-ts` output requires `@quonfig/node` **>=0.0.16**, which widens `ContextValue` to `unknown` so the generated `contexts?: Contexts | ContextObj` signatures compile.

## 0.0.11 - 2026-04-18

- fix: `qfg get` resolves `providedBy` (ENV_VAR) pointers and decrypts `decryptWith` ciphertext locally against the new raw-match response shape from `/api/v1/evaluations/evaluate` (qfg-c7d.3). Prior 0.0.10 still expected the legacy shape and silently printed nothing for confidential configs.

## 0.0.8 - 2026-04-17

- fix: `qfg get` sends the environment slug instead of the DB UUID to `/api/v1/evaluations/evaluate` (rename `environmentId` → `environmentName` on that endpoint). Fixes 500s on value evaluation.

## 0.0.6 - 2026-04-11

- feat: workspace-first login UX — picker shows all workspaces across orgs with `Organization / workspace` format
- feat: `qfg workspace switch` — switch workspace without re-authenticating
- feat: `QUONFIG_WORKSPACE=slug` env var and `--workspace` flag to pin workspace per project or per command
- feat: `qfg workspace` — shows current workspace with org name and hints for switching
- chore: `qfg profile` hidden and redirected to `qfg workspace switch` (deprecated)
- chore: `--profile` flag hidden on all commands; use `--workspace` instead

## 0.0.5 - 2026-03-31

- feat: `qfg init` — initialize or update a Quonfig workspace. Creates directory structure, managed docs (README.md, CLAUDE.md, AGENTS.md), `quonfig.schema.json`, git repo, and pre-commit hook. Idempotent — safe to re-run for updates.
  - `--samples` / `--no-samples` to control example config generation
  - `--dry-run` to preview without writing
- feat: `qfg verify` now shows detailed summary of checks performed: file counts by type, rules validated, unique keys verified, segment and schema ref integrity.
- fix: staging and production token storage separated by domain so credentials don't collide.

## 0.0.13 - 2025-12-08

- fix: string/number comparison issue

## 0.0.11 - 2025-11-24

- fix: typos in 'reforge generate --help'

## 0.0.10 - 2025-11-24

- fix: ignore Zod.describe method to not interfere with type generation

## 0.0.9 - 2025-11-20

- feat: upgrade to zod v4 + support for `meta`
- docs: encourage use of direnv when contributing

## 0.0.8 - 2025-10-29

- Added support for `ZodRecord` types in code generation mappers
- Added `-o` / `--output-directory` flag to `generate` command to specify output directory per run

## 0.0.7 - 2025-10-20

- Adds "whoami" command and optional verbose logging to debug login process [#65]
- Updated `get` command to support encrypted config values that need a local env var to decrypt [#66]

## 0.0.6 - 2025-10-13

- fix: Handle enum values that come back as a single string, not an array of strings

## 0.0.5 - 2025-10-09

- Updated `get` command to no longer prompt for an sdk key, ensured no other commands will either
- Updated `create` command to better handle creation of encrypted values

## 0.0.4 - 2025-10-09

- Adds mcp command to assist installation of quonfig's mcp in claude desktop
- Clean up logging output (especially test output)
- Improve the get command to interactively prompt for a key and confirm it exists before proceeding

## 0.0.3 - 2025-10-07

- fix: automated release process

## 0.0.2

N/A

## 0.0.1 - 2025-10-07

- feat: OAuth login with JWT authentication and v1 API migration
- feat: nodejs typegen shouldn't generate unnecessary async methods
- feat: expose the reforge client directly in nodejs typegen

## 0.0.0-pre.11 - 2025-10-01

- fix: don't assume feature flags are boolean values in typegen

## 0.0.0-pre.10 - 2025-09-30

- Type generation improvements to support javascript sdk

## 0.0.0-pre.9 - 2025-09-05

- Type generation improvements to support module augmentation

## 0.0.0-pre.8 - 2025-08-18

- Type generation support for node + react

## 0.0.0-pre.0 - 2025-08-04

- Reforge rebrand

# @prefab-cloud/prefab

All releases below were released as part of the
[@prefab-cloud/prefab-cli](https://github.com/prefab-cloud/prefab-cli) package.

## @prefab-cloud/prefab - [0.4.6](https://github.com/oclif/hello-world/compare/0.4.5...0.4.6) (2023-11-11)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 4.0.2 to 4.1.5 ([90e69e5](https://github.com/oclif/hello-world/commit/90e69e58caab0d401869a7523dbcd1387803234d))

## @prefab-cloud/prefab - [0.4.5](https://github.com/oclif/hello-world/compare/0.4.4...0.4.5) (2023-11-05)

### Bug Fixes

- **deps:** bump @oclif/plugin-help from 5.2.19 to 5.2.20 ([d710325](https://github.com/oclif/hello-world/commit/d710325af125cd0acc4cb7ee732569efa29d9e6c))

## @prefab-cloud/prefab - [0.4.4](https://github.com/oclif/hello-world/compare/0.4.3...0.4.4) (2023-10-28)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 3.7.0 to 3.9.4 ([8369b56](https://github.com/oclif/hello-world/commit/8369b566d0ce50909e54b477ae5bb6c11b082f3d))

## @prefab-cloud/prefab - [0.4.3](https://github.com/oclif/hello-world/compare/0.4.2...0.4.3) (2023-10-10)

### Bug Fixes

- update dev.cmd too ([2ce7bdc](https://github.com/oclif/hello-world/commit/2ce7bdc2c2b262f8f16bcab62fe7c9c5dd8d3f48))
- use node with ts-node loader ([5f406d6](https://github.com/oclif/hello-world/commit/5f406d6dd2ce06bcfe50a9c003bcfe25c63d93b4))

## @prefab-cloud/prefab - [0.4.2](https://github.com/oclif/hello-world/compare/0.4.1...0.4.2) (2023-10-09)

### Bug Fixes

- use latest eslint-config-oclif-typescript ([a010663](https://github.com/oclif/hello-world/commit/a010663092a2c269c56cecc96bfd4ff3bcb4a2f1))

## @prefab-cloud/prefab - [0.4.1](https://github.com/oclif/hello-world/compare/0.4.0...0.4.1) (2023-10-04)

### Bug Fixes

- deps ([ede92f9](https://github.com/oclif/hello-world/commit/ede92f95be182a8cd08f970781988959e02550b0))
- satisfy linter ([896fd96](https://github.com/oclif/hello-world/commit/896fd96ab5821774751811567ab7d97d01e8bb2b))

# [0.4.0](https://github.com/oclif/hello-world/compare/0.3.0...0.4.0) (2023-10-04)

### Features

- bump core, add prettier ([5be0350](https://github.com/oclif/hello-world/commit/5be0350ed4446ec1fc2eba55b73b459875f8b90b))

# [0.3.0](https://github.com/oclif/hello-world/compare/0.2.3...0.3.0) (2023-09-18)

### Features

- update eslint configs ([85c1530](https://github.com/oclif/hello-world/commit/85c15307f8faefb2646050276a58c310f48cff2b))

## @prefab-cloud/prefab - [0.2.3](https://github.com/oclif/hello-world/compare/0.2.2...0.2.3) (2023-09-17)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 3.4.0 to 3.7.0 ([04939c2](https://github.com/oclif/hello-world/commit/04939c21e6db4018ab8655c1f37ae3c10d85f0d1))

## @prefab-cloud/prefab - [0.2.2](https://github.com/oclif/hello-world/compare/0.2.1...0.2.2) (2023-09-16)

### Bug Fixes

- **deps:** bump @oclif/core from 3.0.0-beta.12 to 3.0.0-beta.13 ([f054f82](https://github.com/oclif/hello-world/commit/f054f823c30b6080ae005a8f9fe5dd30290ad061))

## @prefab-cloud/prefab - [0.2.1](https://github.com/oclif/hello-world/compare/0.2.0...0.2.1) (2023-09-09)

### Bug Fixes

- **deps:** bump @oclif/plugin-help from 5.2.17 to 5.2.19 ([60d2b33](https://github.com/oclif/hello-world/commit/60d2b338401d4d9a5790416c99b7cbe6c019346f))

# [0.2.0](https://github.com/oclif/hello-world/compare/0.1.6...0.2.0) (2023-09-07)

### Features

- use ts-node in bin/dev.js ([6ab5e0f](https://github.com/oclif/hello-world/commit/6ab5e0f31cb7c09c196d30bd3ecdf2f9e7462ea8))

## @prefab-cloud/prefab - [0.1.6](https://github.com/oclif/hello-world/compare/0.1.5...0.1.6) (2023-09-05)

### Bug Fixes

- remove ts-node loader ([370eba5](https://github.com/oclif/hello-world/commit/370eba5db778c240bf95fca27f5afac71aa48466))

## @prefab-cloud/prefab - [0.1.5](https://github.com/oclif/hello-world/compare/0.1.4...0.1.5) (2023-09-05)

### Bug Fixes

- update bin scripts ([9d14905](https://github.com/oclif/hello-world/commit/9d1490590a11ff79f817dd8ec8e9a548b70d9aa6))

## @prefab-cloud/prefab - [0.1.4](https://github.com/oclif/hello-world/compare/0.1.3...0.1.4) (2023-09-03)

### Bug Fixes

- **deps:** bump @oclif/core from 3.0.0-beta.6 to 3.0.0-beta.12 ([4a67b9f](https://github.com/oclif/hello-world/commit/4a67b9f67e287de7fca92376899b00cab25a2ada))

## @prefab-cloud/prefab - [0.1.3](https://github.com/oclif/hello-world/compare/0.1.2...0.1.3) (2023-09-02)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 3.3.2 to 3.4.0 ([d077b38](https://github.com/oclif/hello-world/commit/d077b38d54d06aefd3ffc3d78235f4a682da423b))

## @prefab-cloud/prefab - [0.1.2](https://github.com/oclif/hello-world/compare/0.1.1...0.1.2) (2023-08-31)

### Bug Fixes

- use core v3 ([0896ec1](https://github.com/oclif/hello-world/commit/0896ec15081020dd38f8cf9a26fd61f899182d29))

## @prefab-cloud/prefab - [0.1.1](https://github.com/oclif/hello-world/compare/0.1.0...0.1.1) (2023-08-23)

### Bug Fixes

- add void to bin scripts ([a3e257e](https://github.com/oclif/hello-world/commit/a3e257efa4984834d221ec356dc5269dc8c39ee9))

# [0.1.0](https://github.com/oclif/hello-world/compare/0.0.10...0.1.0) (2023-08-21)

### Features

- remove ts-node/esm shebang ([c2c3aab](https://github.com/oclif/hello-world/commit/c2c3aabcea5edf646ef87874cd4c7b87ad05c5f5))

## @prefab-cloud/prefab - [0.0.10](https://github.com/oclif/hello-world/compare/0.0.9...0.0.10) (2023-08-13)

### Bug Fixes

- **deps:** bump @oclif/plugin-help from 5.2.15 to 5.2.17 ([08b2587](https://github.com/oclif/hello-world/commit/08b25875b07788a2969393efcbb7b1d7a1bdc1dd))

## @prefab-cloud/prefab - [0.0.9](https://github.com/oclif/hello-world/compare/0.0.8...0.0.9) (2023-08-12)

### Bug Fixes

- **deps:** bump @oclif/plugin-plugins from 3.1.8 to 3.2.6 ([11e89e0](https://github.com/oclif/hello-world/commit/11e89e06d3eb1e12104bd562ff79ca2eaf0e3425))

## @prefab-cloud/prefab - [0.0.8](https://github.com/oclif/hello-world/compare/0.0.7...0.0.8) (2023-08-12)

### Bug Fixes

- **deps:** bump @oclif/core from 2.11.7 to 2.11.8 ([ff1da5a](https://github.com/oclif/hello-world/commit/ff1da5aa66ede6dc657f2ceb0c57b3a3d71fa8ba))

## @prefab-cloud/prefab - [0.0.7](https://github.com/oclif/hello-world/compare/0.0.6...0.0.7) (2023-08-10)

### Bug Fixes

- update tsconfig ([0cd7321](https://github.com/oclif/hello-world/commit/0cd73218c2a0c3fc44de072331a1b77217d06cc9))

## @prefab-cloud/prefab - [0.0.6](https://github.com/oclif/hello-world/compare/0.0.5...0.0.6) (2023-08-10)

### Bug Fixes

- bin/dev shebang ([e1633f2](https://github.com/oclif/hello-world/commit/e1633f21c04eec833747080a3da9e10b51653840))

## @prefab-cloud/prefab - [0.0.5](https://github.com/oclif/hello-world/compare/0.0.4...0.0.5) (2023-08-09)

### Bug Fixes

- bin/run shebang ([abbf92a](https://github.com/oclif/hello-world/commit/abbf92ab774077ef2e3634c6c8b679932d5f6158))

## @prefab-cloud/prefab - [0.0.4](https://github.com/oclif/hello-world/compare/0.0.3...0.0.4) (2023-08-06)

### Bug Fixes

- **deps:** bump @oclif/plugin-help from 5.2.14 to 5.2.15 ([5a25888](https://github.com/oclif/hello-world/commit/5a258889436705c8a430188343294660b0aec8af))

## @prefab-cloud/prefab - [0.0.3](https://github.com/oclif/hello-world/compare/0.0.2...0.0.3) (2023-08-03)

### Bug Fixes

- add experimentalSpecifierResolution ([a57c7e0](https://github.com/oclif/hello-world/commit/a57c7e07f2cfcc6a67d598773fe3a6ab7903c4ae))

## @prefab-cloud/prefab - [0.0.2](https://github.com/oclif/hello-world/compare/0.0.1...0.0.2) (2023-07-29)

### Bug Fixes

- **deps:** bump @oclif/core from 2.10.0 to 2.11.1 ([2a28629](https://github.com/oclif/hello-world/commit/2a286297f0e021df4ab2c3f33686b142351c70ea))

## @prefab-cloud/prefab - [0.0.1](https://github.com/oclif/hello-world/compare/27cc5bb44cc4aee53f74bfaef39c1fe03e637d72...0.0.1) (2023-07-27)

### Bug Fixes

- **deps:** bump @oclif/core from 2.9.4 to 2.10.0 ([27cc5bb](https://github.com/oclif/hello-world/commit/27cc5bb44cc4aee53f74bfaef39c1fe03e637d72))
