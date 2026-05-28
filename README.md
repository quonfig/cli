# Quonfig CLI

<!-- toc -->
* [Quonfig CLI](#quonfig-cli)
* [Usage](#usage)
* [Running commands with injected env](#running-commands-with-injected-env)
* [.qfg.env](#qfgenv)
* [blank lines and # comments are skipped](#blank-lines-and--comments-are-skipped)
* [Commands](#commands)
<!-- tocstop -->

# Usage

<!-- usage -->
```sh-session
$ npm install -g @quonfig/cli
$ qfg COMMAND
running command...
$ qfg (--version)
@quonfig/cli/0.0.57 darwin-arm64 node-v24.4.1
$ qfg --help [COMMAND]
USAGE
  $ qfg COMMAND
...
```
<!-- usagestop -->

# Running commands with injected env

Some workflows need Quonfig values to land in `process.env` **before** application
code runs — Drizzle migrations read `DATABASE_URL` at module import, `next-auth`
reads `AUTH_SECRET` automatically, and arbitrary build steps / one-shot scripts
can't always go through `instrumentation.ts`. Use `qfg run` to resolve configs
and exec the child with those vars merged into its environment.

The flag separator `--` is **required** between `qfg run` flags and the child
command — without it, oclif tries to parse the child's flags as its own.

## Inline form

```sh
qfg run \
  --env DATABASE_URL=db.url \
  --env AUTH_SECRET=auth.secret \
  --environment=staging \
  -- \
  npm run migrate
```

The grammar is `VAR=key.path` (uses `=`, not `:`, to match `docker -e VAR=value`
muscle memory). `--env` is repeatable.

## File form

```sh
# .qfg.env
DATABASE_URL=db.url
AUTH_SECRET=auth.secret
# blank lines and # comments are skipped
```

```sh
qfg run --env-file=.qfg.env --environment=staging -- npm run migrate
```

## Auth / environment is binary

`qfg run` enforces a strict either/or rule, never a precedence chain. This is
intentional — a "match-only" exception drifts silently in CI and masks
misconfiguration.

| Mode  | When                                    | Provides                                                  |
|-------|-----------------------------------------|-----------------------------------------------------------|
| **A** | `QUONFIG_BACKEND_SDK_KEY` is set        | env + workspace from the SDK key                          |
| **B** | No SDK key — uses `qfg login` user auth | `--environment` _or_ `QUONFIG_ENVIRONMENT` (exactly one)  |

Mixing the two is an error:

- Mode A + `--environment` (or `QUONFIG_ENVIRONMENT`) → exits non-zero before
  spawning, even if they would agree.
- Mode B with neither → exits non-zero.
- Mode B with both `--environment` and `QUONFIG_ENVIRONMENT` → exits non-zero.

There is **no interactive prompt**. `qfg run` is meant for scripts and CI;
prompting mid-`&&`-chain would be worse UX than failing loud.

## Override vs preserve

By default `qfg run` **overrides** any value already set in the parent env —
the whole point is "make these vars come from Quonfig." Pass `--preserve-env`
to flip that: vars already set in the parent are kept, and only unset vars
are filled in.

```sh
qfg run --env DATABASE_URL=db.url --preserve-env --environment=staging -- npm test
```

## Missing keys fail before the child spawns

If any requested config key is missing from the workspace, `qfg run` exits
non-zero with a list of the missing keys and never spawns the child. This
avoids the trap where the child blows up later with an empty value and the
real cause is buried under unrelated stack traces.

## package.json example

```json
{
  "scripts": {
    "migrate": "qfg run --env-file=.qfg.env --environment=staging -- drizzle-kit migrate",
    "migrate:prod": "qfg run --env-file=.qfg.env -- drizzle-kit migrate"
  }
}
```

The first uses Mode B (`--environment=staging` flag). The second relies on
`QUONFIG_BACKEND_SDK_KEY` being set in the prod environment (Mode A) so the
script doesn't need to know which env it's running in.

# Commands

<!-- commands -->
* [`qfg activity`](#qfg-activity)
* [`qfg activity deleted`](#qfg-activity-deleted)
* [`qfg activity feed`](#qfg-activity-feed)
* [`qfg activity history [NAME]`](#qfg-activity-history-name)
* [`qfg activity restore [NAME]`](#qfg-activity-restore-name)
* [`qfg audit-log [NAME]`](#qfg-audit-log-name)
* [`qfg cleanup`](#qfg-cleanup)
* [`qfg cleanup list`](#qfg-cleanup-list)
* [`qfg cleanup remove [NAME]`](#qfg-cleanup-remove-name)
* [`qfg cleanup status [NAME]`](#qfg-cleanup-status-name)
* [`qfg cleanup verify [NAME]`](#qfg-cleanup-verify-name)
* [`qfg config-schema`](#qfg-config-schema)
* [`qfg create NAME`](#qfg-create-name)
* [`qfg delete NAME`](#qfg-delete-name)
* [`qfg flag info [NAME]`](#qfg-flag-info-name)
* [`qfg flag list`](#qfg-flag-list)
* [`qfg flag show [NAME]`](#qfg-flag-show-name)
* [`qfg generate`](#qfg-generate)
* [`qfg generate-new-hex-key`](#qfg-generate-new-hex-key)
* [`qfg get [NAME]`](#qfg-get-name)
* [`qfg history NAME`](#qfg-history-name)
* [`qfg info [NAME]`](#qfg-info-name)
* [`qfg init [DIRECTORY]`](#qfg-init-directory)
* [`qfg interactive`](#qfg-interactive)
* [`qfg list`](#qfg-list)
* [`qfg log`](#qfg-log)
* [`qfg log-level NAME`](#qfg-log-level-name)
* [`qfg login`](#qfg-login)
* [`qfg logout`](#qfg-logout)
* [`qfg migrate`](#qfg-migrate)
* [`qfg migrate doctor`](#qfg-migrate-doctor)
* [`qfg migrate my-code`](#qfg-migrate-my-code)
* [`qfg migrate status`](#qfg-migrate-status)
* [`qfg override [NAME] [VALUE]`](#qfg-override-name-value)
* [`qfg pull`](#qfg-pull)
* [`qfg push`](#qfg-push)
* [`qfg run [COMMAND]`](#qfg-run-command)
* [`qfg schema NAME`](#qfg-schema-name)
* [`qfg sdk-key`](#qfg-sdk-key)
* [`qfg sdk-key create`](#qfg-sdk-key-create)
* [`qfg sdk-key list`](#qfg-sdk-key-list)
* [`qfg sdk-key revoke KEYID`](#qfg-sdk-key-revoke-keyid)
* [`qfg serve`](#qfg-serve)
* [`qfg set-default [NAME]`](#qfg-set-default-name)
* [`qfg set-rollout [NAME]`](#qfg-set-rollout-name)
* [`qfg sync`](#qfg-sync)
* [`qfg toggle [NAME]`](#qfg-toggle-name)
* [`qfg verify [PATH]`](#qfg-verify-path)
* [`qfg whoami`](#qfg-whoami)
* [`qfg workspace`](#qfg-workspace)
* [`qfg workspace bootstrap`](#qfg-workspace-bootstrap)
* [`qfg workspace create SLUG`](#qfg-workspace-create-slug)
* [`qfg workspace switch [SLUG]`](#qfg-workspace-switch-slug)

## `qfg activity`

Inspect what changed in the workspace (recent commits, per-config history, deletions).

```
USAGE
  $ qfg activity [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Inspect what changed in the workspace (recent commits, per-config history, deletions).

EXAMPLES
  $ qfg activity feed

  $ qfg activity history my.flag

  $ qfg activity deleted

  $ qfg activity restore my.flag --yes
```

_See code: [src/commands/activity.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/activity.ts)_

## `qfg activity deleted`

List configs that were deleted from the workspace and have not been restored.

```
USAGE
  $ qfg activity deleted [--json] [--interactive] [--no-color] [--verbose] [-w <value>]

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  List configs that were deleted from the workspace and have not been restored.

  Useful for "did somebody delete X?" — pair with `qfg activity restore NAME`
  to undelete a tombstoned config.

EXAMPLES
  $ qfg activity deleted

  $ qfg activity deleted --json
```

_See code: [src/commands/activity/deleted.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/activity/deleted.ts)_

## `qfg activity feed`

Recent activity across the workspace, newest first.

```
USAGE
  $ qfg activity feed [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--limit <value>]

FLAGS
  --limit=<value>  [default: 30] Maximum number of feed entries (1-100)

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Recent activity across the workspace, newest first.

  Each entry shows who changed which config, the action (created/updated/deleted/restored),
  and the human-readable audit message produced by the server. The server already
  translates JSON diffs into messages — this command does not re-translate.

EXAMPLES
  $ qfg activity feed

  $ qfg activity feed --limit 5

  $ qfg activity feed --json
```

_See code: [src/commands/activity/feed.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/activity/feed.ts)_

## `qfg activity history [NAME]`

Per-config audit trail for a flag, config, log-level, segment, or schema.

```
USAGE
  $ qfg activity history [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Per-config audit trail for a flag, config, log-level, segment, or schema.

  Resolves NAME against the workspace metadata (no need to specify type) and
  returns the full commit history for that file with audit messages translated
  by the server. Restored entries are rendered distinctly so a recovery doesn't
  look like a fresh create.

EXAMPLES
  $ qfg activity history my.flag

  $ qfg activity history request.timeout --json
```

_See code: [src/commands/activity/history.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/activity/history.ts)_

## `qfg activity restore [NAME]`

Undelete a config that was previously removed.

```
USAGE
  $ qfg activity restore [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--type
    feature_flag|config|log_level|segment|flag|log-level] [--yes]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --type=<option>  Config type. Optional — inferred from history when omitted.
                   <options: feature_flag|config|log_level|segment|flag|log-level>
  --yes            Skip the confirmation prompt

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Undelete a config that was previously removed.

  Looks up the most recent deletion for the key (so you see who deleted it and when),
  then asks for confirmation before re-creating the file from the prior content.
  Schemas cannot be restored — use git history instead.

EXAMPLES
  $ qfg activity restore my.flag --yes

  $ qfg activity restore request.timeout --type config --yes
```

_See code: [src/commands/activity/restore.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/activity/restore.ts)_

## `qfg audit-log [NAME]`

Alias: `qfg audit-log` → `qfg activity feed`; `qfg audit-log NAME` → `qfg activity history NAME`.

```
USAGE
  $ qfg audit-log [NAME...] [--json] [--interactive] [--no-color] [--verbose]

ARGUMENTS
  NAME...  Optional config key. If present, dispatches to `activity history NAME`; otherwise `activity feed`.

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Alias: `qfg audit-log` → `qfg activity feed`; `qfg audit-log NAME` → `qfg activity history NAME`.

EXAMPLES
  $ qfg audit-log

  $ qfg audit-log my.flag
```

_See code: [src/commands/audit-log.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/audit-log.ts)_

## `qfg cleanup`

Retire feature flags that have done their job.

```
USAGE
  $ qfg cleanup [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Retire feature flags that have done their job.

  The cleanup workflow turns a flag's "Ready for cleanup" marker into an end-to-end
  removal flow: surface the flags that are safe to retire, hand the actual code
  removal to the qfg-flag-cleanup Claude skill, then delete the flag definition
  once the call sites are gone.

  Lifecycle (high-level):
  1. Owner flips readyForCleanup=true in the UI            (already exists)
  2. qfg cleanup list                                       see candidates + telemetry
  3. qfg cleanup status <key>                               drill into one flag
  4. qfg cleanup remove <key>                               handoff to the cleanup skill
  5. PR merges, SDK redeploys, telemetry confirms 0 evals
  6. qfg cleanup verify <key>                               (optional) confirm safe
  7. qfg delete <key>                                       remove the flag definition

EXAMPLES
  $ qfg cleanup list

  $ qfg cleanup list --json

  $ qfg cleanup status my.flag.key
```

_See code: [src/commands/cleanup.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/cleanup.ts)_

## `qfg cleanup list`

List feature flags marked readyForCleanup=true, with eval volume per window.

```
USAGE
  $ qfg cleanup list [--json] [--interactive] [--no-color] [--verbose] [-w <value>]

FLAGS
  --json  Return structured rows for agent consumption

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  List feature flags marked readyForCleanup=true, with eval volume per window.

  Columns:
  KEY         the flag key
  TYPE        the flag's valueType (bool, string, int, etc.)
  EVALS_24H   evals counted in today's bucket (latest day)
  EVALS_2D    evals in the last 2 calendar days
  EVALS_7D    evals in the last 7 calendar days
  EVALS_30D   evals in the last 30 calendar days
  LAST_EVAL   most recent calendar day with any evals (UTC), blank if none
  CLASS       quiet (zero evals in last 2 days) or active

  Default sort: quiet first, oldest LAST_EVAL at top.

  Pass --json for the structured object (rows[]). Each row carries the columns
  above plus the raw eval counts your agent can reason about itself.

  Once you've picked a candidate, run `qfg cleanup status <key>` for the
  drill-in or hand off the removal to the qfg-flag-cleanup Claude skill.

EXAMPLES
  $ qfg cleanup list

  $ qfg cleanup list --json
```

_See code: [src/commands/cleanup/list.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/cleanup/list.ts)_

## `qfg cleanup remove [NAME]`

Write a cleanup payload for a ready-for-cleanup flag and hand off to the qfg-flag-cleanup Claude skill.

```
USAGE
  $ qfg cleanup remove [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--force]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --force  Skip the evals_2d > 0 safety gate (useful when telemetry is delayed but you know the flag is dead)

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Write a cleanup payload for a ready-for-cleanup flag and hand off to the qfg-flag-cleanup Claude skill.

  Modeled on `qfg migrate my-code` — this command never edits source files
  itself. It validates that the flag is marked readyForCleanup=true, refuses to
  proceed if there are still evals_2d > 0 (use --force to override), writes
  `.qf/cleanup/<key>.json` describing the flag's current rule shape +
  telemetry, and prints instructions to invoke the qfg-flag-cleanup skill which
  asks the engineer which value should "win" and applies the inlining.

  The payload deliberately does NOT suggest a winning value; that's the
  engineer's call. Run `qfg cleanup status <key>` first if you want to inspect
  telemetry before retiring.

EXAMPLES
  $ qfg cleanup remove my.flag.key

  $ qfg cleanup remove my.flag.key --force

  $ qfg cleanup remove my.flag.key --json
```

_See code: [src/commands/cleanup/remove.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/cleanup/remove.ts)_

## `qfg cleanup status [NAME]`

Drill into one ready-for-cleanup flag — show telemetry across all environments and the current rule shape.

```
USAGE
  $ qfg cleanup status [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --json  Return structured object for agent consumption

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Drill into one ready-for-cleanup flag — show telemetry across all environments and the current rule shape.

  Use this after `qfg cleanup list` to inspect a specific flag before handing
  removal off to the qfg-flag-cleanup Claude skill. The eval counts come from
  analytics.configSparklines (the same backing data the per-flag sparklines on
  the flag detail page use), summed into 24h/2d/7d/30d windows so you can decide
  whether it's safe to retire.

  Pass --json for the structured object including the full rule shape per
  environment — the cleanup skill consumes this directly.

EXAMPLES
  $ qfg cleanup status my.flag.key

  $ qfg cleanup status my.flag.key --json
```

_See code: [src/commands/cleanup/status.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/cleanup/status.ts)_

## `qfg cleanup verify [NAME]`

Confirm zero evals for a flag in the trailing N days (default 7). Exits 0 if safe to delete, non-zero otherwise.

```
USAGE
  $ qfg cleanup verify [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--days <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --days=<value>  [default: 7] Number of trailing calendar days that must have zero evals
  --json          Return structured object for agent consumption

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Confirm zero evals for a flag in the trailing N days (default 7). Exits 0 if safe to delete, non-zero otherwise.

  Read-only gate intended for chaining with `qfg delete` after a cleanup PR
  has merged and the SDK has redeployed:

  qfg cleanup verify my.flag.key && qfg delete my.flag.key

  The trailing window is stricter than the `qfg cleanup remove` 2-day gate on
  purpose — `remove` only writes a payload describing the flag, but `delete`
  permanently removes the flag definition, so we want a longer quiet period
  before chaining. Bump --days N if you want a more conservative window.

EXAMPLES
  $ qfg cleanup verify my.flag.key

  $ qfg cleanup verify my.flag.key --days 14

  $ qfg cleanup verify my.flag.key --json

  $ qfg cleanup verify my.flag.key && qfg delete my.flag.key
```

_See code: [src/commands/cleanup/verify.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/cleanup/verify.ts)_

## `qfg config-schema`

Print the config file format reference: rules engine, operators, targeting criteria, segments, and weighted rollouts. Use --json-schema for the machine-readable JSON Schema document.

```
USAGE
  $ qfg config-schema [--json] [--interactive] [--no-color] [--verbose] [--json-schema]

FLAGS
  --json-schema  Output the full JSON Schema document for config files instead of the human-readable reference

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Print the config file format reference: rules engine, operators, targeting criteria, segments, and weighted rollouts.
  Use --json-schema for the machine-readable JSON Schema document.

EXAMPLES
  $ qfg config-schema                  # human-readable operator reference + examples

  $ qfg config-schema --json-schema    # full JSON Schema document (copy into your editor)
```

_See code: [src/commands/config-schema.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/config-schema.ts)_

## `qfg create NAME`

Create a new feature flag, config value, or other item.

```
USAGE
  $ qfg create NAME --type boolean-flag|boolean|string|double|int|string-list|json|duration|log_level
    [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--confidential] [--env-var <value>] [--value
    <value>] [--secret] [--secret-key-name <value>]

ARGUMENTS
  NAME  name for your new item (e.g. my.new.flag)

FLAGS
  --confidential             mark the value as confidential
  --env-var=<value>          environment variable to get value from
  --secret                   encrypt the value of this item
  --secret-key-name=<value>  [default: quonfig.secrets.encryption.key] name of the secret key to use for
                             encryption/decryption
  --type=<option>            (required)
                             <options: boolean-flag|boolean|string|double|int|string-list|json|duration|log_level>
  --value=<value>            default value for your new item

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Create a new feature flag, config value, or other item.

  Use --type to specify the kind of item:
  boolean-flag  On/off feature flag (sendToClientSdk defaults to true; best for gradual rollouts)
  string        A string configuration value
  int           An integer configuration value
  double        A floating-point configuration value
  string-list   A comma-separated list of strings
  json          An arbitrary JSON blob
  boolean       A plain boolean (not a feature flag)
  duration      An ISO 8601 duration string, e.g. PT30S, PT5M, PT1H30M (SDK returns milliseconds)
  log_level     A dynamic log level (value must be one of TRACE/DEBUG/INFO/WARN/ERROR/FATAL)

  This sets the global default value. Override per-environment with:
  qfg set-default my.flag --environment production --value true

  For a percentage rollout (gradual rollout / A/B test / canary deploy), use:
  qfg set-rollout my.flag --environment production --true-percent 20

  Or edit the JSON config file directly for complex targeting rules:
  qfg config-schema          # full operator reference + examples
  qfg pull --dir ./config    # clone workspace, then edit JSON and git push

  Log levels:
  qfg create log-level.my-app --type log_level --value WARN
  # Log-level keys must start with "log-level.".
  # For per-logger targeting, create ONE log-level config per service and add
  # rules on the "quonfig-sdk-logging.key" context property (e.g.
  # PROP_STARTS_WITH_ONE_OF MyPackage.) rather than one config per logger.

  When this flag has done its job, mark readyForCleanup: true in the UI and run `qfg cleanup list` to retire it.

EXAMPLES
  $ qfg create my.new.flag --type boolean-flag

  $ qfg create my.new.flag --type boolean-flag --value=true

  $ qfg create my.new.string --type string --value="hello world"

  $ qfg create my.new.string --type string --value="hello world" --secret

  $ qfg create my.new.string --type string --env-var=MY_ENV_VAR_NAME

  $ qfg create my.new.string --type json --value="{\"key\": \"value\"}"

  $ qfg create my.timeout --type duration --value PT90S

  $ qfg create log-level.my-app --type log_level --value WARN

  # After creating a flag, set a 20% rollout in production:

  $ qfg set-rollout my.new.flag --environment production --true-percent 20
```

_See code: [src/commands/create.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/create.ts)_

## `qfg delete NAME`

Delete a flag, config, or log-level from the workspace.

```
USAGE
  $ qfg delete NAME [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--yes]

ARGUMENTS
  NAME  flag/config/log-level key to delete

FLAGS
  --yes  skip confirmation prompt

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Delete a flag, config, or log-level from the workspace.

  DESTRUCTIVE — removes the underlying JSON file from the workspace git repo
  and commits with the actor's identity. The commit history preserves the
  prior content; this is a hard-delete on the file but a soft-delete on
  history.

  Confirmation is required:
  --yes                       skip the prompt (for scripts and CI)
  interactive (default)       you'll be asked to type the key name back

  Examples
  qfg delete my.flag --yes
  qfg delete my.flag                          # interactive: type the key back to confirm
  qfg delete my.config --yes

EXAMPLES
  $ qfg delete my.flag --yes

  $ qfg delete my.config --yes
```

_See code: [src/commands/delete.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/delete.ts)_

## `qfg flag info [NAME]`

Show current values, rules, and evaluation stats for a flag or config.

```
USAGE
  $ qfg flag info [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--exclude-evaluations]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --exclude-evaluations  Exclude evaluation data

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Show current values, rules, and evaluation stats for a flag or config.

  Output shows the value for each environment:
  - A simple value (true / false / "hello") means a single unconditional rule.
  - "[see rules]" means the environment has targeting rules or a percentage rollout.
  - "[inherit]" means the environment falls back to the Default value.

  Percentage rollouts are displayed as "20.0% true, 80.0% false".
  Evaluation counts for the past 24 hours are included by default.

  Related commands:
  qfg set-default my.flag --environment production --value true   # set a scalar fallback
  qfg set-rollout my.flag --environment production --true-percent 20  # set a % rollout

ALIASES
  $ qfg flag show
  $ qfg flag info

EXAMPLES
  $ qfg flag info my.config.name

  $ qfg flag info my.config.name --exclude-evaluations   # skip 24h stats
```

## `qfg flag list`

Show keys for your config/feature flags/etc.

```
USAGE
  $ qfg flag list [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--configs] [--feature-flags]
    [--log-levels] [--schemas] [--segments]

FLAGS
  --configs        include configs
  --feature-flags  include flags
  --log-levels     include log levels
  --schemas        include schemas
  --segments       include segments

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Show keys for your config/feature flags/etc.

  All types are returned by default. If you pass one or more type flags (e.g. --configs), only those types will be
  returned

ALIASES
  $ qfg flag list

EXAMPLES
  $ qfg flag list

  $ qfg flag list --feature-flags
```

## `qfg flag show [NAME]`

Show current values, rules, and evaluation stats for a flag or config.

```
USAGE
  $ qfg flag show [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--exclude-evaluations]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --exclude-evaluations  Exclude evaluation data

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Show current values, rules, and evaluation stats for a flag or config.

  Output shows the value for each environment:
  - A simple value (true / false / "hello") means a single unconditional rule.
  - "[see rules]" means the environment has targeting rules or a percentage rollout.
  - "[inherit]" means the environment falls back to the Default value.

  Percentage rollouts are displayed as "20.0% true, 80.0% false".
  Evaluation counts for the past 24 hours are included by default.

  Related commands:
  qfg set-default my.flag --environment production --value true   # set a scalar fallback
  qfg set-rollout my.flag --environment production --true-percent 20  # set a % rollout

ALIASES
  $ qfg flag show
  $ qfg flag info

EXAMPLES
  $ qfg flag show my.config.name

  $ qfg flag show my.config.name --exclude-evaluations   # skip 24h stats
```

## `qfg generate`

Generate type definitions for your Quonfig configuration

```
USAGE
  $ qfg generate [--json] [--interactive] [--no-color] [--verbose] [--dir <value>] [-o <value>] [--targets
    <value>] [-w <value>]

FLAGS
  -o, --output-directory=<value>  Override the output directory for generated files
  -w, --workspace=<value>         Workspace slug or UUID for the remote-fetch path (defaults to QUONFIG_WORKSPACE env
                                  var or active profile). Only used when --dir is omitted.
      --dir=<value>               Path to local QUONFIG_DIR (defaults to QUONFIG_DIR env var). When omitted,
                                  auto-detects a quonfig.json in the current directory; if none, fetches the workspace
                                  from the server.
      --targets=<value>           [default: react-ts] Determines for language/framework to generate code for (node-ts,
                                  react-ts)

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Generate type definitions for your Quonfig configuration

  You can use the default type-generation configuration, or by provide your own via a quonfig.config.json file:

  Format:
  {
  ​  outputDirectory?: string;
  ​  targets?: {
  ​    <language key>?: {
  ​      outputDirectory?: string;
  ​      outputFileName?: string;
  ​    }
  ​  }
  };

  Example quonfig.config.json:
  ```json
  {
  ​  "outputDirectory": "path/to/your/directory",
  ​  "targets": {
  ​    "react-ts": {
  ​      "outputDirectory": "diff/path/to/your/directory",
  ​      "declarationFileName": "quonfig-client-types.d.ts",
  ​      "clientFileName": "quonfig-client.ts",
  ​    },
  ​    "node-ts": {
  ​      "declarationFileName": "quonfig-server-types.d.ts",
  ​      "clientFileName": "quonfig-server.ts",
  ​    }
  ​  }
  }
  ```


EXAMPLES
  $ qfg generate # react-ts only by default

  $ qfg generate --targets node-ts # node-ts only

  $ qfg generate --targets react-ts,node-ts # both node + react-ts

  $ qfg generate -o ./src/generated # specify output directory

  $ qfg generate --targets node-ts -o ./dist # combine with targets
```

_See code: [src/commands/generate.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/generate.ts)_

## `qfg generate-new-hex-key`

Generate a new hex key suitable for secrets

```
USAGE
  $ qfg generate-new-hex-key [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Generate a new hex key suitable for secrets

EXAMPLES
  $ qfg generate-new-hex-key
```

_See code: [src/commands/generate-new-hex-key.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/generate-new-hex-key.ts)_

## `qfg get [NAME]`

Get the value of a config/feature-flag/etc.

```
USAGE
  $ qfg get [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--environment <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --environment=<value>  environment to evaluate in

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Get the value of a config/feature-flag/etc.

EXAMPLES
  $ qfg get my.config.name

  $ qfg get my.config.name --environment=production
```

_See code: [src/commands/get.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/get.ts)_

## `qfg history NAME`

Alias: `qfg history NAME` → `qfg activity history NAME`.

```
USAGE
  $ qfg history NAME... [--json] [--interactive] [--no-color] [--verbose]

ARGUMENTS
  NAME...  Config key to inspect

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Alias: `qfg history NAME` → `qfg activity history NAME`.

EXAMPLES
  $ qfg history my.flag
```

_See code: [src/commands/history.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/history.ts)_

## `qfg info [NAME]`

Show current values, rules, and evaluation stats for a flag or config.

```
USAGE
  $ qfg info [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--exclude-evaluations]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --exclude-evaluations  Exclude evaluation data

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Show current values, rules, and evaluation stats for a flag or config.

  Output shows the value for each environment:
  - A simple value (true / false / "hello") means a single unconditional rule.
  - "[see rules]" means the environment has targeting rules or a percentage rollout.
  - "[inherit]" means the environment falls back to the Default value.

  Percentage rollouts are displayed as "20.0% true, 80.0% false".
  Evaluation counts for the past 24 hours are included by default.

  Related commands:
  qfg set-default my.flag --environment production --value true   # set a scalar fallback
  qfg set-rollout my.flag --environment production --true-percent 20  # set a % rollout

ALIASES
  $ qfg flag show
  $ qfg flag info

EXAMPLES
  $ qfg info my.config.name

  $ qfg info my.config.name --exclude-evaluations   # skip 24h stats
```

_See code: [src/commands/info.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/info.ts)_

## `qfg init [DIRECTORY]`

Initialize or update a Quonfig workspace

```
USAGE
  $ qfg init [DIRECTORY] [--json] [--interactive] [--no-color] [--verbose] [--dry-run] [--samples]
    [--workspace <value>]

ARGUMENTS
  DIRECTORY  [default: .] Target directory (default: current directory)

FLAGS
  --dry-run            Show what would be done without writing anything
  --[no-]samples       Include sample configs (default: yes on first init, no on update)
  --workspace=<value>  Workspace pin in <org-slug>/<workspace-slug> form (Guard 1). If omitted, no pin is written.

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Initialize or update a Quonfig workspace

EXAMPLES
  $ qfg init

  $ qfg init ./my-workspace

  $ qfg init --no-samples

  $ qfg init --samples

  $ qfg init --dry-run
```

_See code: [src/commands/init.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/init.ts)_

## `qfg interactive`

Launch an interactive menu to browse and manage your workspace.

```
USAGE
  $ qfg interactive [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Launch an interactive menu to browse and manage your workspace.

  Common shortcuts:
  qfg set-default my.flag --environment production --value false   # catch-all fallback
  qfg set-rollout my.flag --environment production --true-percent 20   # % rollout

  For arbitrary targeting rules (e.g. user.email, plan, segment, custom property),
  run 'qfg config-schema' then 'qfg pull' and edit the JSON config directly.

EXAMPLES
  $ qfg
```

_See code: [src/commands/interactive.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/interactive.ts)_

## `qfg list`

Show keys for your config/feature flags/etc.

```
USAGE
  $ qfg list [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--configs] [--feature-flags]
    [--log-levels] [--schemas] [--segments]

FLAGS
  --configs        include configs
  --feature-flags  include flags
  --log-levels     include log levels
  --schemas        include schemas
  --segments       include segments

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Show keys for your config/feature flags/etc.

  All types are returned by default. If you pass one or more type flags (e.g. --configs), only those types will be
  returned

ALIASES
  $ qfg flag list

EXAMPLES
  $ qfg list

  $ qfg list --feature-flags
```

_See code: [src/commands/list.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/list.ts)_

## `qfg log`

Alias: `qfg log` → `qfg activity feed`.

```
USAGE
  $ qfg log [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Alias: `qfg log` → `qfg activity feed`.

EXAMPLES
  $ qfg log

  $ qfg log --limit 5
```

_See code: [src/commands/log.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/log.ts)_

## `qfg log-level NAME`

Create or add targeting rules to a log-level config.

```
USAGE
  $ qfg log-level NAME [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--environment <value>]
    [--target <value>...] [--value TRACE|DEBUG|INFO|WARN|ERROR|FATAL]

ARGUMENTS
  NAME  log-level key (must start with "log-level.", e.g. log-level.my-app)

FLAGS
  --environment=<value>  when used with --target, scope the rule to this environment instead of the default
  --target=<value>...    logger path prefix (matched via PROP_STARTS_WITH_ONE_OF on "quonfig-sdk-logging.key");
                         repeatable
  --value=<option>       log level — either the new default (create mode) or the level for the targeted loggers
                         <options: TRACE|DEBUG|INFO|WARN|ERROR|FATAL>

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Create or add targeting rules to a log-level config.

  Log-level keys must start with "log-level." (e.g. log-level.my-app). The
  default value applies to every logger in that service unless a targeting
  rule matches first.

  Two modes:

  1. Create a new log-level config with a default value:
  qfg log-level log-level.my-app --value=WARN

  2. Add a per-logger targeting rule to an existing config. SDKs populate
  the "quonfig-sdk-logging.key" context automatically from the logger path,
  so this rule fires for any logger whose name starts with --target:
  qfg log-level log-level.my-app --target=MyPackage.Noisy --value=ERROR

  Pass --target multiple times to match any of several prefixes (OR).
  Pass --environment=<env> to scope the rule to a single environment.

  To update the catch-all default for an existing log level, use set-default:
  qfg set-default log-level.my-app --value=DEBUG --environment=production

  For more complex rules (regex, multi-criterion, exact match) edit the JSON:
  qfg pull && $EDITOR log-levels/log-level.my-app.json
  qfg config-schema            # full operator reference

EXAMPLES
  $ qfg log-level log-level.my-app --value=WARN

  $ qfg log-level log-level.my-app --target=MyPackage.Noisy --value=ERROR

  $ qfg log-level log-level.my-app --target=A --target=B --value=DEBUG

  $ qfg log-level log-level.my-app --target=Chatty --value=INFO --environment=production
```

_See code: [src/commands/log-level.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/log-level.ts)_

## `qfg login`

Log in to Quonfig via WorkOS device authorization (mints one token per org)

```
USAGE
  $ qfg login [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Log in to Quonfig via WorkOS device authorization (mints one token per org)

EXAMPLES
  $ qfg login

  $ qfg login --profile myprofile
```

_See code: [src/commands/login.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/login.ts)_

## `qfg logout`

Log out and clear stored authentication tokens

```
USAGE
  $ qfg logout [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Log out and clear stored authentication tokens

EXAMPLES
  $ qfg logout
```

_See code: [src/commands/logout.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/logout.ts)_

## `qfg migrate`

Migrate flags and configs from a legacy feature-flag system into a Quonfig workspace.

```
USAGE
  $ qfg migrate --from launch|launchdarkly|flagsmith [--json] [--interactive] [--no-color] [--verbose]
    [--api-key <value>] [--dir <value>] [--dry-run] [--full-summary] [--project <value>] [--push] [--recent <value>]
    [--reset] [--since <value>] [--source-api-key <value>] [--staging] [--workspace <value>]

FLAGS
  --api-key=<value>         Deprecated alias for --source-api-key, kept for the `launch` source (or set LAUNCH_API_KEY).
                            Prefer --source-api-key.
  --dir=<value>             Target local workspace directory. Defaults to cwd if it looks like a Quonfig workspace,
                            otherwise ./quonfig-repo.
  --dry-run                 Fetch and summarize changes without writing anything
  --from=<option>           (required) Legacy source to migrate from
                            <options: launch|launchdarkly|flagsmith>
  --full-summary            Reify the full source-side audit log into per-change git commits (author = original user,
                            date = original timestamp, message = change summary). Only valid on first-run imports — pass
                            --reset to re-import everything from scratch with this flag.
  --project=<value>         Source-system project identifier. For --from launchdarkly this is the project KEY (default:
                            "default"; env: LAUNCHDARKLY_PROJECT_KEY). For --from flagsmith this is the numeric project
                            ID (env: FLAGSMITH_PROJECT_ID). Ignored by --from launch.
  --push                    After migrating to a local dir, also push to the given --workspace on Quonfig cloud
  --recent=<value>          Import only the last N changes (useful for tire-kicking)
  --reset                   Ignore the delta cursor and re-import everything from scratch
  --since=<value>           Override the delta cursor (epoch milliseconds or ISO-8601 timestamp)
  --source-api-key=<value>  API key for the legacy source. Set this, QUONFIG_MIGRATE_API_KEY, or the per-provider env
                            var (LAUNCHDARKLY_API_KEY, LAUNCH_API_KEY, FLAGSMITH_API_KEY).
  --staging                 Hit the staging API for the source (dev-only)
  --workspace=<value>       Quonfig cloud workspace slug to push to. Requires `qfg login` and is typically combined with
                            --push.

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Migrate flags and configs from a legacy feature-flag system into a Quonfig workspace.

  Currently supported sources:
  launch — Reforge Launch (ported from launch-migrator)

  See https://docs.quonfig.com/docs/migrating/from-launch for the step-by-step guide,
  and https://docs.quonfig.com/docs/migrating/troubleshooting when something goes sideways.

EXAMPLES
  $ qfg migrate --from launchdarkly --source-api-key $LAUNCHDARKLY_API_KEY --dir ./quonfig-repo

  $ qfg migrate --from launch --source-api-key $LAUNCH_API_KEY --workspace acme-prod --push

  $ qfg migrate --from launch --api-key $LAUNCH_API_KEY --dir ./quonfig-repo --reset

  $ qfg migrate --from launch --source-api-key $LAUNCH_API_KEY --dir ./quonfig-repo --dry-run

  $ qfg migrate --from launch --source-api-key $LAUNCH_API_KEY --dir ./quonfig-repo --staging
```

_See code: [src/commands/migrate.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/migrate.ts)_

## `qfg migrate doctor`

Preflight health checks for `qfg migrate`. Verifies auth, workspace provisioning, working tree, and identifier collisions.

```
USAGE
  $ qfg migrate doctor [--json] [--interactive] [--no-color] [--verbose] [--api-key <value>] [--dir <value>] [--from
    launch] [--language <value>]

FLAGS
  --api-key=<value>   Legacy SDK API key to validate against the source
  --dir=<value>       [default: .] Workspace directory to check (git clean / identifier map)
  --from=<option>     [default: launch] Legacy SDK to migrate from
                      <options: launch>
  --language=<value>  Customer SDK language — used to warn when datadir mode is unavailable (e.g. javascript-browser)

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Preflight health checks for `qfg migrate`. Verifies auth, workspace provisioning, working tree, and identifier
  collisions.

EXAMPLES
  $ qfg migrate doctor

  $ qfg migrate doctor --from launch --api-key $LAUNCH_API_KEY

  $ qfg migrate doctor --dir ./my-workspace --language node

  $ qfg migrate doctor --json
```

_See code: [src/commands/migrate/doctor.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/migrate/doctor.ts)_

## `qfg migrate my-code`

Migrate Launch SDK call sites in your codebase to Quonfig SDK call sites (invokes the qfg-migrate-code Claude skill)

```
USAGE
  $ qfg migrate my-code [--json] [--interactive] [--no-color] [--verbose] [--dry-run] [--from launch]

FLAGS
  --dry-run        Show what would be migrated without editing any files
  --from=<option>  [default: launch] Legacy SDK to migrate from
                   <options: launch>

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Migrate Launch SDK call sites in your codebase to Quonfig SDK call sites (invokes the qfg-migrate-code Claude skill)

EXAMPLES
  $ qfg migrate my-code

  $ qfg migrate my-code --from launch

  $ qfg migrate my-code --dry-run
```

_See code: [src/commands/migrate/my-code.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/migrate/my-code.ts)_

## `qfg migrate status`

Show the status of a workspace migrated with `qfg migrate`. Reads .qf/import-state.json and summarizes source, counts, and next steps.

```
USAGE
  $ qfg migrate status [--json] [--interactive] [--no-color] [--verbose] [--dir <value>]

FLAGS
  --dir=<value>  [default: .] Workspace directory to inspect

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Show the status of a workspace migrated with `qfg migrate`. Reads .qf/import-state.json and summarizes source, counts,
  and next steps.

EXAMPLES
  $ qfg migrate status

  $ qfg migrate status --dir ./my-workspace

  $ qfg migrate status --json
```

_See code: [src/commands/migrate/status.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/migrate/status.ts)_

## `qfg override [NAME] [VALUE]`

Override a flag value for your dev user.

```
USAGE
  $ qfg override [NAME] [VALUE] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--clear]
    [--env <value>] [--remove]

ARGUMENTS
  NAME   flag/config key to override
  VALUE  new value (type inferred: bool/int/double/json/string)

FLAGS
  --clear        remove ALL of your overrides in this env
  --env=<value>  environment to operate in (default: $QUONFIG_ENVIRONMENT)
  --remove       remove your override on this key

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Override a flag value for your dev user.

  Writes a top-priority rule keyed on the dev-only quonfig-user.email property,
  so the override only fires for SDK clients that set quonfig-user.email in
  their context. Production SDKs typically don't set this property, which makes
  overrides effectively inert in production.

  Examples
  qfg override                                # list flags where you have an override
  qfg override my.flag true                   # set bool override
  qfg override my.flag 42                     # set int override
  qfg override my.flag '{"a":1}'              # set json override
  qfg override my.flag --remove               # remove your override on my.flag
  qfg override --clear                        # remove ALL of your overrides in this env

EXAMPLES
  $ qfg override

  $ qfg override my.flag true

  $ qfg override my.flag --remove

  $ qfg override --clear

  $ qfg override my.flag true --env=staging
```

_See code: [src/commands/override.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/override.ts)_

## `qfg pull`

Clone or update a local copy of your workspace config files.

```
USAGE
  $ qfg pull [--json] [--interactive] [--no-color] [--verbose] [--dir <value>] [--rebase] [--workspace
    <value>]

FLAGS
  --dir=<value>        Local directory to clone/update (defaults to cwd / nearest ancestor with quonfig.json /
                       QUONFIG_DIR env var)
  --rebase             Replay local commits on top of origin/main when the two have diverged. Conflicts are surfaced via
                       standard git markers; resolve with `git rebase --continue`.
  --workspace=<value>  Workspace ID (defaults to active profile)

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Clone or update a local copy of your workspace config files.

  Use this when you need to edit flag JSON directly — for complex targeting rules,
  multi-rule configs, or anything beyond a single scalar value.

  For the config file format, operator reference, and examples:
  qfg config-schema              # human-readable reference
  qfg config-schema --json-schema  # machine-readable JSON Schema

  After editing files:
  qfg verify <dir>               # validate JSON before pushing
  git -C <dir> add -A && git -C <dir> commit -m "feat: ..." && git -C <dir> push

  CLI shortcuts (no JSON editing needed for simple cases):
  qfg set-rollout my.flag --environment production --true-percent 20
  qfg set-default my.flag --environment production --value true

EXAMPLES
  $ qfg pull --dir ./our-config

  $ qfg pull  # uses QUONFIG_DIR env var
```

_See code: [src/commands/pull.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/pull.ts)_

## `qfg push`

Push local config changes up to your workspace on Quonfig cloud.

```
USAGE
  $ qfg push [--json] [--interactive] [--no-color] [--verbose] [--dir <value>] [--workspace <value>]
    [--yes] [--skip-validate] [--no-pin-write] [-m <value>]

FLAGS
  -m, --message=<value>    Commit message for bare-path pushes (ignored on clone-path; push what is already committed)
      --dir=<value>        Local directory to push (defaults to cwd / nearest ancestor with quonfig.json / QUONFIG_DIR
                           env var)
      --no-pin-write       Do not offer to write workspace slug into quonfig.json on success
      --skip-validate      Skip `qfg validate` preflight
      --workspace=<value>  Workspace slug or UUID (defaults to active profile)
      --yes                Skip the standard Y/N confirm. Never skips typed-slug prompts.

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Push local config changes up to your workspace on Quonfig cloud.

  Enforces three guards before touching the remote:
  1. The dir's quonfig.json "workspace" pin must match the backend (if set).
  2. The dir's git origin must match the backend repo URL (if set).
  3. A diff summary is shown; destructive changes (10+ deletes, >=25% of
  files, or an unpinned dir) require typing the workspace slug to confirm.

  qfg push                                 # resolves dir from cwd, QUONFIG_DIR, or --dir
  qfg push --dir ./our-config
  qfg push --dir ./our-config --workspace acme-prod
  qfg push --dir ./our-config --yes        # skip normal Y/N (never skips typed-slug)
  qfg push --dir ./our-config --skip-validate

EXAMPLES
  $ qfg push --dir ./our-config

  $ qfg push --workspace acme-prod --dir ./our-config

  $ qfg push --dir ./our-config --yes
```

_See code: [src/commands/push.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/push.ts)_

## `qfg run [COMMAND]`

Run a child process with Quonfig configs injected as env vars.

```
USAGE
  $ qfg run [COMMAND...] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--env
    <value>...] [--env-file <value>] [--environment <value>] [--preserve-env]

ARGUMENTS
  COMMAND...  child command (after '--')

FLAGS
  --env=<value>...       [default: ] Inline env mapping in VAR=key.path form. Repeatable.
  --env-file=<value>     Path to a file with one VAR=key.path per line (# comments and blank lines OK).
  --environment=<value>  Quonfig environment to evaluate in (Mode B). Mutually exclusive with QUONFIG_ENVIRONMENT.
  --preserve-env         Skip vars that are already set in the parent env. Default: override.

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Run a child process with Quonfig configs injected as env vars.

  Resolves --env VAR=key.path mappings (and --env-file lines) against your
  workspace, merges them into the parent env, and exec's the child command.
  Exits with the child's exit code. Missing keys → fail before spawning.

  Auth / environment is BINARY:
  Mode A — QUONFIG_BACKEND_SDK_KEY set: env is encoded in the key.
  Setting --environment OR QUONFIG_ENVIRONMENT alongside is an error.
  Mode B — no SDK key: pass exactly one of --environment or QUONFIG_ENVIRONMENT.

  The flag separator '--' is REQUIRED between qfg flags and the child command.

EXAMPLES
  $ qfg run --env DATABASE_URL=db.url --environment=staging -- env

  $ qfg run --env-file=.qfg.env --environment=staging -- npm run migrate

  $ qfg run --env DATABASE_URL=db.url -- ./bin/migrate.js   # Mode A: relies on QUONFIG_BACKEND_SDK_KEY

  $ qfg run --env DATABASE_URL=db.url --preserve-env --environment=staging -- npm test
```

_See code: [src/commands/run.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/run.ts)_

## `qfg schema NAME`

Get or update first-class schema documents

```
USAGE
  $ qfg schema NAME [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--get] [--protected]
    [--set-json-schema <value>] [--set-zod <value>]

ARGUMENTS
  NAME  schema key

FLAGS
  --get                      get the schema document
  --protected                store the schema in protected storage
  --set-json-schema=<value>  set a plain JSON Schema document (inline JSON or @file path)
  --set-zod=<value>          compatibility alias for --set-json-schema; now expects plain JSON Schema

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Get or update first-class schema documents

EXAMPLES
  $ qfg schema my-schema --get

  $ qfg schema my-schema --set-json-schema='{"type":"object","properties":{}}'

  $ qfg schema my-schema --set-json-schema=@schemas/my-schema.json --protected
```

_See code: [src/commands/schema.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/schema.ts)_

## `qfg sdk-key`

Manage SDK keys for your workspace

```
USAGE
  $ qfg sdk-key [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Manage SDK keys for your workspace

EXAMPLES
  $ qfg sdk-key list

  $ qfg sdk-key create --environment production --type server

  $ qfg sdk-key revoke <key-id>
```

_See code: [src/commands/sdk-key.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/sdk-key.ts)_

## `qfg sdk-key create`

Create a new SDK key

```
USAGE
  $ qfg sdk-key create [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [-e <value>] [-t
    server|browser]

FLAGS
  -e, --environment=<value>  Environment name (e.g. production, staging)
  -t, --type=<option>        Key type: server (backend) or browser (frontend)
                             <options: server|browser>

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Create a new SDK key

EXAMPLES
  $ qfg sdk-key create --environment production --type server

  $ qfg sdk-key create --environment staging --type browser
```

_See code: [src/commands/sdk-key/create.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/sdk-key/create.ts)_

## `qfg sdk-key list`

List SDK keys for your workspace

```
USAGE
  $ qfg sdk-key list [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [-e <value>]

FLAGS
  -e, --environment=<value>  Filter by environment name

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  List SDK keys for your workspace

EXAMPLES
  $ qfg sdk-key list

  $ qfg sdk-key list --environment production
```

_See code: [src/commands/sdk-key/list.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/sdk-key/list.ts)_

## `qfg sdk-key revoke KEYID`

Revoke an SDK key by its ID

```
USAGE
  $ qfg sdk-key revoke KEYID [--json] [--interactive] [--no-color] [--verbose] [-w <value>]

ARGUMENTS
  KEYID  ID of the SDK key to revoke

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Revoke an SDK key by its ID

EXAMPLES
  $ qfg sdk-key revoke a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

_See code: [src/commands/sdk-key/revoke.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/sdk-key/revoke.ts)_

## `qfg serve`

Serve a local datadir over HTTP to browser/RN SDKs.

```
USAGE
  $ qfg serve [--json] [--interactive] [--no-color] [--verbose] [--datadir <value>] [--environment <value>]
    [--port <value>] [--host <value>] [--frontend-sdk-key <value>] [--cors-origin <value>...] [--watch]
    [--allow-non-loopback]

FLAGS
  --allow-non-loopback        Confirm a LAN-reachable bind. Required when --host is not loopback.
  --cors-origin=<value>...    [default: *] Allowed CORS origin (repeatable). Default is *; required when binding to a
                              non-loopback host.
  --datadir=<value>           Datadir to serve (defaults to ./our-config, then ./.quonfig, then errors). Honors
                              QUONFIG_DIR.
  --environment=<value>       [default: development] Which environment slug to evaluate. Honors QUONFIG_ENVIRONMENT.
  --frontend-sdk-key=<value>  If set, every request must present Authorization: Basic 1:<key>. If unset, the server is
                              open (matches the "datadir is the source of truth" mental model).
  --host=<value>              [default: 127.0.0.1] Bind address. Loopback by default; non-loopback requires
                              --allow-non-loopback.
  --port=<value>              [default: 6580] TCP port to listen on. Errors on collision; pass --port <n> to retry.
  --[no-]watch                Reload the envelope when the datadir changes. --no-watch disables.

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Serve a local datadir over HTTP to browser/RN SDKs.

  Reads configs from a local datadir and exposes them at
  `GET /api/v2/configs/eval-with-context/{base64url(ctx)}`. Point your
  browser SDK at the resulting URL (`http://localhost:6580` by default)
  and the same client code that talks to api-delivery in production will
  work unmodified.

  Telemetry is intentionally not served — qfg serve has no Quonfig backend
  behind it. Disable client-side telemetry with
  `collectEvaluationSummaries: false` (and `contextUploadMode: "none"`),
  or point the SDK's `telemetryUrl` at a real endpoint.

  The server is bound to 127.0.0.1 by default; pass --allow-non-loopback
  to confirm a LAN-reachable bind.

EXAMPLES
  $ qfg serve

  $ qfg serve --datadir ./our-config --environment production

  $ qfg serve --port 6581 --frontend-sdk-key PUBLIC_KEY
```

_See code: [src/commands/serve.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/serve.ts)_

## `qfg set-default [NAME]`

Set the unconditional fallback value for a flag or config in a specific environment.

```
USAGE
  $ qfg set-default [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--confidential]
    [--env-var <value>] [--environment <value>] [--value <value>] [--confirm] [--secret] [--secret-key-name <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --confidential             mark the value as confidential
  --confirm                  confirm without prompt
  --env-var=<value>          environment variable to use as default value
  --environment=<value>      environment to change
  --secret                   encrypt the value of this item
  --secret-key-name=<value>  [default: quonfig.secrets.encryption.key] name of the secret key to use for
                             encryption/decryption
  --value=<value>            new default value

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Set the unconditional fallback value for a flag or config in a specific environment.

  This updates the catch-all rule — the value users receive when NO targeting rule matches.
  Any targeting rules or percentage rollouts you have configured are NOT affected; they
  continue to fire before this fallback is evaluated.

  "Other rules still apply" means: if you have rules targeting specific users, segments,
  or properties, those rules still take priority. This command only changes what everyone
  else sees.

  To set a percentage rollout (gradual rollout / A/B test / canary deploy) instead:
  qfg set-rollout my.flag --environment production --true-percent 20

  To see all current values and rules for a flag:
  qfg info my.flag

ALIASES
  $ qfg toggle

EXAMPLES
  $ qfg set-default my.flag.name                                          # prompts for value and env

  $ qfg set-default my.flag.name --value=true --environment=staging

  $ qfg set-default my.flag.name --value=false --environment=production   # kill-switch: turn off for everyone

  $ qfg set-default my.flag.name --value=true --secret

  $ qfg set-default my.config.name --env-var=MY_ENV_VAR_NAME --environment=production

  # For a percentage rollout, use set-rollout instead:

  $ qfg set-rollout my.flag.name --environment production --true-percent 20

  # For per-user / per-property targeting (e.g. user.email == X), edit JSON directly:

  $ qfg pull && qfg config-schema
```

_See code: [src/commands/set-default.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/set-default.ts)_

## `qfg set-rollout [NAME]`

Configure a percentage rollout (gradual rollout / A/B test / canary deploy) for a flag.

```
USAGE
  $ qfg set-rollout [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--environment <value>]
    [--hash-by <value>] [--true-percent <value>] [--weights <value>] [--confirm]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --confirm               skip the interactive confirmation prompt (useful for scripts and agents)
  --environment=<value>   environment to update (e.g. production, staging)
  --hash-by=<value>       [default: user.key] user property used to assign buckets (default: user.key)
  --true-percent=<value>  percentage of users that receive true (0–100). Remaining users receive false. Boolean flags
                          only.
  --weights=<value>       comma-separated "value:percent" pairs that must sum to 100 (e.g. "true:20,false:80" or
                          "red:33,green:33,blue:34")

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Configure a percentage rollout (gradual rollout / A/B test / canary deploy) for a flag.

  The flag must already exist. Create it first if needed:
  qfg create my.flag --type boolean-flag

  Weights are specified as whole-number percentages (0–100). They must sum to 100.

  For a boolean flag, use --true-percent to set the percentage of users that receive
  true (the remainder automatically receive false):
  qfg set-rollout my.flag --environment production --true-percent 20
  → 20% of users get true, 80% get false

  For multi-value flags or custom splits, use --weights with a comma-separated list:
  qfg set-rollout my.flag --environment production --weights "red:33,green:33,blue:34"

  Hashing: users are bucketed by the value of hashByPropertyName (default: "user.key").
  Use --hash-by to change which property drives the bucket assignment:
  qfg set-rollout my.flag --environment production --true-percent 10 --hash-by user.id

  For scripted / agent use, add --confirm to skip the interactive confirmation prompt.

  To combine a rollout with segment targeting (e.g. beta ON, holdout OFF, everyone else 50/50),
  you need to edit the JSON config file directly:
  qfg config-schema           # operator reference + worked multi-rule example
  qfg pull --dir ./config     # clone workspace to edit

  To revert to a single value for everyone, use:
  qfg set-default my.flag --environment production --value false

  To inspect the current rollout:
  qfg info my.flag

EXAMPLES
  $ qfg set-rollout my.feature.flag --environment production --true-percent 20

  $ qfg set-rollout my.feature.flag --environment staging --true-percent 50

  $ qfg set-rollout my.feature.flag --environment production --true-percent 100  # full rollout

  $ qfg set-rollout my.feature.flag --environment production --true-percent 0    # kill switch (all false)

  $ qfg set-rollout my.variant.flag --environment production --weights "control:50,treatment:50"

  $ qfg set-rollout my.variant.flag --environment production --weights "a:33,b:33,c:34" --hash-by user.id
```

_See code: [src/commands/set-rollout.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/set-rollout.ts)_

## `qfg sync`

Continuously poll for workspace config updates and apply them locally

```
USAGE
  $ qfg sync --watch [--json] [--interactive] [--no-color] [--verbose] [--dir <value>] [--interval <value>]

FLAGS
  --dir=<value>       Local directory to sync (defaults to QUONFIG_DIR env var)
  --interval=<value>  [default: 60] Poll interval in seconds
  --watch             (required) Run as a continuous polling daemon (required)

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Continuously poll for workspace config updates and apply them locally

EXAMPLES
  $ qfg sync --watch

  $ qfg sync --watch --interval 10

  $ qfg sync --watch --dir ./our-config --interval 30
```

_See code: [src/commands/sync.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/sync.ts)_

## `qfg toggle [NAME]`

Set the unconditional fallback value for a flag or config in a specific environment.

```
USAGE
  $ qfg toggle [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--confidential]
    [--env-var <value>] [--environment <value>] [--value <value>] [--confirm] [--secret] [--secret-key-name <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --confidential             mark the value as confidential
  --confirm                  confirm without prompt
  --env-var=<value>          environment variable to use as default value
  --environment=<value>      environment to change
  --secret                   encrypt the value of this item
  --secret-key-name=<value>  [default: quonfig.secrets.encryption.key] name of the secret key to use for
                             encryption/decryption
  --value=<value>            new default value

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Set the unconditional fallback value for a flag or config in a specific environment.

  This updates the catch-all rule — the value users receive when NO targeting rule matches.
  Any targeting rules or percentage rollouts you have configured are NOT affected; they
  continue to fire before this fallback is evaluated.

  "Other rules still apply" means: if you have rules targeting specific users, segments,
  or properties, those rules still take priority. This command only changes what everyone
  else sees.

  To set a percentage rollout (gradual rollout / A/B test / canary deploy) instead:
  qfg set-rollout my.flag --environment production --true-percent 20

  To see all current values and rules for a flag:
  qfg info my.flag

ALIASES
  $ qfg toggle

EXAMPLES
  $ qfg toggle my.flag.name                                          # prompts for value and env

  $ qfg toggle my.flag.name --value=true --environment=staging

  $ qfg toggle my.flag.name --value=false --environment=production   # kill-switch: turn off for everyone

  $ qfg toggle my.flag.name --value=true --secret

  $ qfg toggle my.config.name --env-var=MY_ENV_VAR_NAME --environment=production

  # For a percentage rollout, use set-rollout instead:

  $ qfg set-rollout my.flag.name --environment production --true-percent 20

  # For per-user / per-property targeting (e.g. user.email == X), edit JSON directly:

  $ qfg pull && qfg config-schema
```

## `qfg verify [PATH]`

Validate a Quonfig workspace directory

```
USAGE
  $ qfg verify [PATH] [--json] [--interactive] [--no-color] [--verbose] [--strict]

ARGUMENTS
  PATH  [default: .] Path to workspace directory

FLAGS
  --strict  Treat warnings as errors

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Validate a Quonfig workspace directory

EXAMPLES
  $ qfg verify

  $ qfg verify ./my-workspace

  $ qfg verify --json
```

_See code: [src/commands/verify.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/verify.ts)_

## `qfg whoami`

Display information about the currently logged in user and all org memberships

```
USAGE
  $ qfg whoami [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Display information about the currently logged in user and all org memberships

EXAMPLES
  $ qfg whoami
```

_See code: [src/commands/whoami.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/whoami.ts)_

## `qfg workspace`

Show the active workspace, all org tokens, and every (org, workspace) the user can reach

```
USAGE
  $ qfg workspace [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Show the active workspace, all org tokens, and every (org, workspace) the user can reach

EXAMPLES
  $ qfg workspace
```

_See code: [src/commands/workspace.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/workspace.ts)_

## `qfg workspace bootstrap`

Push a local git repo to Gitea as this workspace's config repository

```
USAGE
  $ qfg workspace bootstrap [--json] [--interactive] [--no-color] [--verbose] [--dir <value>] [--force]
  [--skip-validate]

FLAGS
  --dir=<value>    Local directory to push (defaults to current directory)
  --force          Force push even if remote already has commits
  --skip-validate  Skip config validation before pushing

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Push a local git repo to Gitea as this workspace's config repository

EXAMPLES
  $ qfg workspace bootstrap --dir ./our-config

  $ qfg workspace bootstrap --dir ./launch-migrator/output

  $ qfg workspace bootstrap --dir ./our-config --skip-validate
```

_See code: [src/commands/workspace/bootstrap.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/workspace/bootstrap.ts)_

## `qfg workspace create SLUG`

Create a new workspace. Provisions the Gitea repo and default environments, identical to the app's New Workspace UI.

```
USAGE
  $ qfg workspace create SLUG [--json] [--interactive] [--no-color] [--verbose] [--name <value>] [--org <value>]

ARGUMENTS
  SLUG  Workspace slug (lowercase letters, numbers, hyphens)

FLAGS
  --name=<value>  Human-readable display name (defaults to the slug)
  --org=<value>   Organization UUID or slug. Required when you belong to more than one organization; inferred otherwise.

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Create a new workspace. Provisions the Gitea repo and default environments, identical to the app's New Workspace UI.

EXAMPLES
  $ qfg workspace create my-team

  $ qfg workspace create lt-21-smoke --name "Load Test 21"

  $ qfg workspace create my-team --org 11111111-1111-1111-1111-111111111111
```

_See code: [src/commands/workspace/create.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/workspace/create.ts)_

## `qfg workspace switch [SLUG]`

Switch the saved default profile to a different (org, workspace) pair

```
USAGE
  $ qfg workspace switch [SLUG] [--json] [--interactive] [--no-color] [--verbose]

ARGUMENTS
  SLUG  Workspace pin in `<org-slug>/<workspace-slug>` form. Omit for an interactive picker.

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Switch the saved default profile to a different (org, workspace) pair

EXAMPLES
  $ qfg workspace switch

  $ qfg workspace switch acme/production
```

_See code: [src/commands/workspace/switch.ts](https://github.com/quonfig/cli/blob/v0.0.57/src/commands/workspace/switch.ts)_
<!-- commandsstop -->

## Local Development

```
mise install
git submodule init
git submodule update
yarn install
yarn build
bin/dev.js
fish -c "cd ../../quonfig/cli;bin/dev.js"
```

## Releasing

Publishing is fully automated via CI. To ship a new version:

1. Bump the version in `package.json`
2. Add an entry to `CHANGELOG.md`
3. Commit and push to `main`

The [release workflow](.github/workflows/release.yaml) detects that the version in `package.json` is not yet on npm and publishes automatically using GitHub OIDC (no npm token or OTP needed locally).

## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and
create. Any contributions you make are **greatly appreciated**. For detailed contributing
guidelines, please see [CONTRIBUTING.md](CONTRIBUTING.md)
