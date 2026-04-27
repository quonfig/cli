# Changelog

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
