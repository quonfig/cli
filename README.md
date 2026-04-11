# Quonfig CLI

<!-- toc -->
* [Quonfig CLI](#quonfig-cli)
* [Usage](#usage)
* [Commands](#commands)
<!-- tocstop -->

# Usage

<!-- usage -->
```sh-session
$ npm install -g @quonfig/cli
$ qfg COMMAND
running command...
$ qfg (--version)
@quonfig/cli/0.0.6 darwin-arm64 node-v25.6.1
$ qfg --help [COMMAND]
USAGE
  $ qfg COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`qfg config-schema`](#qfg-config-schema)
* [`qfg create NAME`](#qfg-create-name)
* [`qfg download`](#qfg-download)
* [`qfg generate`](#qfg-generate)
* [`qfg generate-new-hex-key`](#qfg-generate-new-hex-key)
* [`qfg get [NAME]`](#qfg-get-name)
* [`qfg info [NAME]`](#qfg-info-name)
* [`qfg init [DIRECTORY]`](#qfg-init-directory)
* [`qfg interactive`](#qfg-interactive)
* [`qfg list`](#qfg-list)
* [`qfg login`](#qfg-login)
* [`qfg logout`](#qfg-logout)
* [`qfg mcp`](#qfg-mcp)
* [`qfg override [NAME]`](#qfg-override-name)
* [`qfg pull`](#qfg-pull)
* [`qfg schema NAME`](#qfg-schema-name)
* [`qfg serve DATA-FILE`](#qfg-serve-data-file)
* [`qfg set-default [NAME]`](#qfg-set-default-name)
* [`qfg set-rollout [NAME]`](#qfg-set-rollout-name)
* [`qfg sync`](#qfg-sync)
* [`qfg verify [PATH]`](#qfg-verify-path)
* [`qfg whoami`](#qfg-whoami)
* [`qfg workspace`](#qfg-workspace)
* [`qfg workspace bootstrap`](#qfg-workspace-bootstrap)
* [`qfg workspace switch`](#qfg-workspace-switch)

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

_See code: [src/commands/config-schema.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/config-schema.ts)_

## `qfg create NAME`

Create a new feature flag, config value, or other item.

```
USAGE
  $ qfg create NAME --type boolean-flag|boolean|string|double|int|string-list|json [--json] [--interactive]
    [--no-color] [--verbose] [-w <value>] [--confidential] [--env-var <value>] [--value <value>] [--secret]
    [--secret-key-name <value>]

ARGUMENTS
  NAME  name for your new item (e.g. my.new.flag)

FLAGS
  --confidential             mark the value as confidential
  --env-var=<value>          environment variable to get value from
  --secret                   encrypt the value of this item
  --secret-key-name=<value>  [default: quonfig.secrets.encryption.key] name of the secret key to use for
                             encryption/decryption
  --type=<option>            (required)
                             <options: boolean-flag|boolean|string|double|int|string-list|json>
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

  This sets the global default value. Override per-environment with:
  qfg set-default my.flag --environment production --value true

  For a percentage rollout (gradual rollout / A/B test / canary deploy), use:
  qfg set-rollout my.flag --environment production --true-percent 20

  Or edit the JSON config file directly for complex targeting rules:
  qfg config-schema          # full operator reference + examples
  qfg pull --dir ./config    # clone workspace, then edit JSON and git push

EXAMPLES
  $ qfg create my.new.flag --type boolean-flag

  $ qfg create my.new.flag --type boolean-flag --value=true

  $ qfg create my.new.string --type string --value="hello world"

  $ qfg create my.new.string --type string --value="hello world" --secret

  $ qfg create my.new.string --type string --env-var=MY_ENV_VAR_NAME

  $ qfg create my.new.string --type json --value="{\"key\": \"value\"}"

  # After creating a flag, set a 20% rollout in production:

  $ qfg set-rollout my.new.flag --environment production --true-percent 20
```

_See code: [src/commands/create.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/create.ts)_

## `qfg download`

Download a Datafile for a given environment

```
USAGE
  $ qfg download [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--environment <value>]
    [--sdk-key <value>]

FLAGS
  --environment=<value>  environment to download
  --sdk-key=<value>      SDK key for authentication (uses legacy download endpoint)

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Download a Datafile for a given environment

  You can serve a datafile using the `serve` command.

EXAMPLES
  $ qfg download --environment=test

  $ qfg download --environment=test --sdk-key=YOUR_SDK_KEY
```

_See code: [src/commands/download.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/download.ts)_

## `qfg generate`

Generate type definitions for your Quonfig configuration

```
USAGE
  $ qfg generate [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [-o <value>] [--targets
    <value>]

FLAGS
  -o, --output-directory=<value>  Override the output directory for generated files
      --targets=<value>           [default: react-ts] Determines for language/framework to generate code for (node-ts,
                                  react-ts)

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

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

_See code: [src/commands/generate.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/generate.ts)_

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

_See code: [src/commands/generate-new-hex-key.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/generate-new-hex-key.ts)_

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

_See code: [src/commands/get.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/get.ts)_

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

EXAMPLES
  $ qfg info my.config.name

  $ qfg info my.config.name --exclude-evaluations   # skip 24h stats
```

_See code: [src/commands/info.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/info.ts)_

## `qfg init [DIRECTORY]`

Initialize or update a Quonfig workspace

```
USAGE
  $ qfg init [DIRECTORY] [--json] [--interactive] [--no-color] [--verbose] [--dry-run] [--samples]

ARGUMENTS
  DIRECTORY  [default: .] Target directory (default: current directory)

FLAGS
  --dry-run       Show what would be done without writing anything
  --[no-]samples  Include sample configs (default: yes on first init, no on update)

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

_See code: [src/commands/init.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/init.ts)_

## `qfg interactive`

```
USAGE
  $ qfg interactive [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

EXAMPLES
  $ qfg
```

_See code: [src/commands/interactive.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/interactive.ts)_

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

EXAMPLES
  $ qfg list

  $ qfg list --feature-flags
```

_See code: [src/commands/list.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/list.ts)_

## `qfg login`

Log in to Quonfig via WorkOS device authorization

```
USAGE
  $ qfg login [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Log in to Quonfig via WorkOS device authorization

EXAMPLES
  $ qfg login

  $ qfg login --profile myprofile
```

_See code: [src/commands/login.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/login.ts)_

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

_See code: [src/commands/logout.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/logout.ts)_

## `qfg mcp`

Configure Quonfig MCP server for your AI assistant

```
USAGE
  $ qfg mcp [--json] [--interactive] [--no-color] [--verbose] [--editor claude-code|codeium] [--url
    <value>]

FLAGS
  --editor=<option>  Editor to configure (cursor, vscode, claude, windsurf)
                     <options: claude-code|codeium>
  --url=<value>      Internal URL for testing (defaults to https://app.quonfig.com/api/v1/mcp)

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Configure Quonfig MCP server for your AI assistant

EXAMPLES
  $ qfg mcp

  $ qfg mcp --editor cursor

  $ qfg mcp --url http://local-app.quonfig-staging.com:3003/api/v1/mcp
```

_See code: [src/commands/mcp.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/mcp.ts)_

## `qfg override [NAME]`

Override the value of an item for your user/SDK key combo

```
USAGE
  $ qfg override [NAME] [--json] [--interactive] [--no-color] [--verbose] [-w <value>] [--environment <value>]
    [--remove] [--value <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --environment=<value>  environment to override in
  --remove               remove your override (if present)
  --value=<value>        value to use for your override

GLOBAL FLAGS
  -w, --workspace=<value>  Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)
      --[no-]interactive   Force interactive mode
      --json               Format output as json.
      --no-color           Do not colorize output
      --verbose            Verbose output

DESCRIPTION
  Override the value of an item for your user/SDK key combo

EXAMPLES
  $ qfg override # will prompt for name and value

  $ qfg override my.flag.name --value=true

  $ qfg override my.flag.name --remove

  $ qfg override my.double.config --value=3.14159
```

_See code: [src/commands/override.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/override.ts)_

## `qfg pull`

Clone or update a local copy of your workspace config files.

```
USAGE
  $ qfg pull [--json] [--interactive] [--no-color] [--verbose] [--dir <value>] [--workspace <value>]

FLAGS
  --dir=<value>        Local directory to clone/update (defaults to QUONFIG_DIR env var)
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

_See code: [src/commands/pull.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/pull.ts)_

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

_See code: [src/commands/schema.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/schema.ts)_

## `qfg serve DATA-FILE`

Serve a datafile on a local port

```
USAGE
  $ qfg serve DATA-FILE [--json] [--interactive] [--no-color] [--verbose] [--port <value>]

ARGUMENTS
  DATA-FILE  file to read

FLAGS
  --port=<value>  [default: 3099] port to serve on

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Serve a datafile on a local port

  You can download a datafile using the `download` command.

  You'll need to update your JavaScript (or React) client to point to this server.

  e.g. `endpoints: ["http://localhost:3099"],`


EXAMPLES
  $ qfg serve ./quonfig.test.588.config.json --port=3099
```

_See code: [src/commands/serve.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/serve.ts)_

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

EXAMPLES
  $ qfg set-default my.flag.name                                          # prompts for value and env

  $ qfg set-default my.flag.name --value=true --environment=staging

  $ qfg set-default my.flag.name --value=false --environment=production   # kill-switch: turn off for everyone

  $ qfg set-default my.flag.name --value=true --secret

  $ qfg set-default my.config.name --env-var=MY_ENV_VAR_NAME --environment=production

  # For a percentage rollout, use set-rollout instead:

  $ qfg set-rollout my.flag.name --environment production --true-percent 20
```

_See code: [src/commands/set-default.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/set-default.ts)_

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

_See code: [src/commands/set-rollout.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/set-rollout.ts)_

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

_See code: [src/commands/sync.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/sync.ts)_

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

_See code: [src/commands/verify.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/verify.ts)_

## `qfg whoami`

Display information about the currently logged in user

```
USAGE
  $ qfg whoami [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Display information about the currently logged in user

EXAMPLES
  $ qfg whoami
```

_See code: [src/commands/whoami.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/whoami.ts)_

## `qfg workspace`

Show the current workspace

```
USAGE
  $ qfg workspace [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Show the current workspace

EXAMPLES
  $ qfg workspace
```

_See code: [src/commands/workspace.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/workspace.ts)_

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

_See code: [src/commands/workspace/bootstrap.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/workspace/bootstrap.ts)_

## `qfg workspace switch`

Switch to a different workspace

```
USAGE
  $ qfg workspace switch [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Switch to a different workspace

EXAMPLES
  $ qfg workspace switch
```

_See code: [src/commands/workspace/switch.ts](https://github.com/quonfig/cli/blob/v0.0.6/src/commands/workspace/switch.ts)_
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
