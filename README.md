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
@quonfig/cli/0.0.14 darwin-arm64 node-v24.6.0
$ qfg --help [COMMAND]
USAGE
  $ qfg COMMAND
...
```
<!-- usagestop -->

# Commands

<!-- commands -->
* [`qfg create NAME`](#qfg-create-name)
* [`qfg download`](#qfg-download)
* [`qfg generate`](#qfg-generate)
* [`qfg generate-new-hex-key`](#qfg-generate-new-hex-key)
* [`qfg get [NAME]`](#qfg-get-name)
* [`qfg info [NAME]`](#qfg-info-name)
* [`qfg interactive`](#qfg-interactive)
* [`qfg list`](#qfg-list)
* [`qfg login`](#qfg-login)
* [`qfg logout`](#qfg-logout)
* [`qfg mcp`](#qfg-mcp)
* [`qfg override [NAME]`](#qfg-override-name)
* [`qfg profile`](#qfg-profile)
* [`qfg schema NAME`](#qfg-schema-name)
* [`qfg serve DATA-FILE`](#qfg-serve-data-file)
* [`qfg set-default [NAME]`](#qfg-set-default-name)
* [`qfg whoami`](#qfg-whoami)
* [`qfg workspace`](#qfg-workspace)

## `qfg create NAME`

Create a new item in Quonfig

```
USAGE
  $ qfg create NAME --type boolean-flag|boolean|string|double|int|string-list|json [--json]
    [--interactive] [--no-color] [--verbose] [-p <value>] [--confidential] [--env-var <value>] [--value <value>]
    [--secret] [--secret-key-name <value>]

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
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
      --[no-]interactive  Force interactive mode
      --json              Format output as json.
      --no-color          Do not colorize output
      --verbose           Verbose output

DESCRIPTION
  Create a new item in Quonfig

EXAMPLES
  $ qfg create my.new.flag --type boolean-flag

  $ qfg create my.new.flag --type boolean-flag --value=true

  $ qfg create my.new.string --type string --value="hello world"

  $ qfg create my.new.string --type string --value="hello world" --secret

  $ qfg create my.new.string --type string --env-var=MY_ENV_VAR_NAME

  $ qfg create my.new.string --type json --value="{\"key\": \"value\"}"
```

_See code: [src/commands/create.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/create.ts)_

## `qfg download`

Download a Datafile for a given environment

```
USAGE
  $ qfg download [--json] [--interactive] [--no-color] [--verbose] [-p <value>] [--environment <value>]
    [--sdk-key <value>]

FLAGS
  --environment=<value>  environment to download
  --sdk-key=<value>      SDK key for authentication (uses legacy download endpoint)

GLOBAL FLAGS
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
      --[no-]interactive  Force interactive mode
      --json              Format output as json.
      --no-color          Do not colorize output
      --verbose           Verbose output

DESCRIPTION
  Download a Datafile for a given environment

  You can serve a datafile using the `serve` command.

EXAMPLES
  $ qfg download --environment=test

  $ qfg download --environment=test --sdk-key=YOUR_SDK_KEY
```

_See code: [src/commands/download.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/download.ts)_

## `qfg generate`

Generate type definitions for your Quonfig configuration

```
USAGE
  $ qfg generate [--json] [--interactive] [--no-color] [--verbose] [-p <value>] [-o <value>] [--targets
    <value>]

FLAGS
  -o, --output-directory=<value>  Override the output directory for generated files
      --targets=<value>           [default: react-ts] Determines for language/framework to generate code for (node-ts,
                                  react-ts)

GLOBAL FLAGS
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
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

_See code: [src/commands/generate.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/generate.ts)_

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

_See code: [src/commands/generate-new-hex-key.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/generate-new-hex-key.ts)_

## `qfg get [NAME]`

Get the value of a config/feature-flag/etc.

```
USAGE
  $ qfg get [NAME] [--json] [--interactive] [--no-color] [--verbose] [-p <value>] [--environment
    <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --environment=<value>  environment to evaluate in

GLOBAL FLAGS
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
      --[no-]interactive  Force interactive mode
      --json              Format output as json.
      --no-color          Do not colorize output
      --verbose           Verbose output

DESCRIPTION
  Get the value of a config/feature-flag/etc.

EXAMPLES
  $ qfg get my.config.name

  $ qfg get my.config.name --environment=production
```

_See code: [src/commands/get.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/get.ts)_

## `qfg info [NAME]`

Show details about the provided config/feature-flag/etc.

```
USAGE
  $ qfg info [NAME] [--json] [--interactive] [--no-color] [--verbose] [-p <value>]
    [--exclude-evaluations]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --exclude-evaluations  Exclude evaluation data

GLOBAL FLAGS
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
      --[no-]interactive  Force interactive mode
      --json              Format output as json.
      --no-color          Do not colorize output
      --verbose           Verbose output

DESCRIPTION
  Show details about the provided config/feature-flag/etc.

EXAMPLES
  $ qfg info my.config.name
```

_See code: [src/commands/info.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/info.ts)_

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

_See code: [src/commands/interactive.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/interactive.ts)_

## `qfg list`

Show keys for your config/feature flags/etc.

```
USAGE
  $ qfg list [--json] [--interactive] [--no-color] [--verbose] [-p <value>] [--configs]
    [--feature-flags] [--log-levels] [--schemas] [--segments]

FLAGS
  --configs        include configs
  --feature-flags  include flags
  --log-levels     include log levels
  --schemas        include schemas
  --segments       include segments

GLOBAL FLAGS
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
      --[no-]interactive  Force interactive mode
      --json              Format output as json.
      --no-color          Do not colorize output
      --verbose           Verbose output

DESCRIPTION
  Show keys for your config/feature flags/etc.

  All types are returned by default. If you pass one or more type flags (e.g. --configs), only those types will be
  returned

EXAMPLES
  $ qfg list

  $ qfg list --feature-flags
```

_See code: [src/commands/list.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/list.ts)_

## `qfg login`

Log in to Quonfig using OAuth

```
USAGE
  $ qfg login [--json] [--interactive] [--no-color] [--verbose] [-p <value>]

FLAGS
  -p, --profile=<value>  Profile name to create or update (defaults to "default")

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Log in to Quonfig using OAuth

EXAMPLES
  $ qfg login

  $ qfg login --profile myprofile
```

_See code: [src/commands/login.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/login.ts)_

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

_See code: [src/commands/logout.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/logout.ts)_

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

  $ qfg mcp --url http://local-launch.goatsofquonfig.com:3003/api/v1/mcp
```

_See code: [src/commands/mcp.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/mcp.ts)_

## `qfg override [NAME]`

Override the value of an item for your user/SDK key combo

```
USAGE
  $ qfg override [NAME] [--json] [--interactive] [--no-color] [--verbose] [-p <value>] [--environment
    <value>] [--remove] [--value <value>]

ARGUMENTS
  NAME  config/feature-flag/etc. name

FLAGS
  --environment=<value>  environment to override in
  --remove               remove your override (if present)
  --value=<value>        value to use for your override

GLOBAL FLAGS
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
      --[no-]interactive  Force interactive mode
      --json              Format output as json.
      --no-color          Do not colorize output
      --verbose           Verbose output

DESCRIPTION
  Override the value of an item for your user/SDK key combo

EXAMPLES
  $ qfg override # will prompt for name and value

  $ qfg override my.flag.name --value=true

  $ qfg override my.flag.name --remove

  $ qfg override my.double.config --value=3.14159
```

_See code: [src/commands/override.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/override.ts)_

## `qfg profile`

Manage profiles and set default profile

```
USAGE
  $ qfg profile [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Manage profiles and set default profile

EXAMPLES
  $ qfg profile
```

_See code: [src/commands/profile.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/profile.ts)_

## `qfg schema NAME`

Manage schemas for Quonfig configs

```
USAGE
  $ qfg schema NAME [--json] [--interactive] [--no-color] [--verbose] [-p <value>] [--get] [--set-zod
    <value>]

ARGUMENTS
  NAME  name of the schema

FLAGS
  --get              get the schema definition
  --set-zod=<value>  set a Zod schema definition

GLOBAL FLAGS
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
      --[no-]interactive  Force interactive mode
      --json              Format output as json.
      --no-color          Do not colorize output
      --verbose           Verbose output

DESCRIPTION
  Manage schemas for Quonfig configs

EXAMPLES
  $ qfg schema my-schema --set-zod="z.object({url: z.string()})"

  $ qfg schema my-schema --get
```

_See code: [src/commands/schema.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/schema.ts)_

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

_See code: [src/commands/serve.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/serve.ts)_

## `qfg set-default [NAME]`

Set/update the default value for an environment (other rules still apply)

```
USAGE
  $ qfg set-default [NAME] [--json] [--interactive] [--no-color] [--verbose] [-p <value>] [--confidential]
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
  -p, --profile=<value>   Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")
      --[no-]interactive  Force interactive mode
      --json              Format output as json.
      --no-color          Do not colorize output
      --verbose           Verbose output

DESCRIPTION
  Set/update the default value for an environment (other rules still apply)

EXAMPLES
  $ qfg set-default my.flag.name # will prompt for value and env

  $ qfg set-default my.flag.name --value=true --environment=staging

  $ qfg set-default my.flag.name --value=true --secret

  $ qfg set-default my.config.name --env-var=MY_ENV_VAR_NAME --environment=production
```

_See code: [src/commands/set-default.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/set-default.ts)_

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

_See code: [src/commands/whoami.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/whoami.ts)_

## `qfg workspace`

Switch active workspace or display current workspace

```
USAGE
  $ qfg workspace [--json] [--interactive] [--no-color] [--verbose]

GLOBAL FLAGS
  --[no-]interactive  Force interactive mode
  --json              Format output as json.
  --no-color          Do not colorize output
  --verbose           Verbose output

DESCRIPTION
  Switch active workspace or display current workspace

EXAMPLES
  $ qfg workspace
```

_See code: [src/commands/workspace.ts](https://github.com/quonfig/cli/blob/v0.0.14/src/commands/workspace.ts)_
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

```
yarn version
npm publish --access public
```

## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and
create. Any contributions you make are **greatly appreciated**. For detailed contributing
guidelines, please see [CONTRIBUTING.md](CONTRIBUTING.md)
