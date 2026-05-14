import {Args, Flags} from '@oclif/core'
import {Quonfig} from '@quonfig/node'
import {spawn} from 'node:child_process'
import {readFileSync} from 'node:fs'

import {APICommand} from '../index.js'
import {decrypt} from '../util/encryption.js'
import {getDeliveryUrl} from '../util/domain-urls.js'
import getClient from '../util/get-client.js'
import {parseEnvFileContents, parseInlineEnvSpec, type RunEnvSpec} from '../util/parse-run-env-spec.js'
import {resolveRunEnvironmentMode} from '../util/resolve-run-environment.js'

interface Dependency {
  config?: RawConfigWithDependencies
  dependencyType: 'decryptWith' | 'providedBy'
  source: string
}

interface RawConfigWithDependencies {
  confidential?: boolean
  dependencies?: Dependency[]
  key: string
  type: string
  value: unknown
}

/**
 * `qfg run` — resolve Quonfig configs into env vars and exec a child process.
 *
 * Use this for tools that read env vars at module import (drizzle-kit migrate,
 * next-auth's AUTH_SECRET, build steps, one-shot scripts) where going through
 * `instrumentation.ts` / SDK init isn't possible.
 *
 * The flag separator `--` is REQUIRED between `qfg run` flags and the child
 * command. Flags that look like child flags (e.g. `--silent`) without `--`
 * would otherwise be eaten by oclif.
 *
 * Auth/env mode is binary — see resolve-run-environment.ts for the full rule.
 */
export default class Run extends APICommand {
  // Hidden positional that holds the child command and its args. The user
  // is expected to put `--` before it; oclif moves everything after `--`
  // into argv. We document the `--` requirement in the description.
  static args = {
    command: Args.string({description: "child command (after '--')", required: false}),
  }

  static description = `Run a child process with Quonfig configs injected as env vars.

Resolves --env VAR=key.path mappings (and --env-file lines) against your
workspace, merges them into the parent env, and exec's the child command.
Exits with the child's exit code. Missing keys → fail before spawning.

Auth / environment is BINARY:
  Mode A — QUONFIG_BACKEND_SDK_KEY set: env is encoded in the key.
           Setting --environment OR QUONFIG_ENVIRONMENT alongside is an error.
  Mode B — no SDK key: pass exactly one of --environment or QUONFIG_ENVIRONMENT.

The flag separator '--' is REQUIRED between qfg flags and the child command.`

  static examples = [
    '<%= config.bin %> <%= command.id %> --env DATABASE_URL=db.url --environment=staging -- env',
    '<%= config.bin %> <%= command.id %> --env-file=.qfg.env --environment=staging -- npm run migrate',
    '<%= config.bin %> <%= command.id %> --env DATABASE_URL=db.url -- ./bin/migrate.js   # Mode A: relies on QUONFIG_BACKEND_SDK_KEY',
    '<%= config.bin %> <%= command.id %> --env DATABASE_URL=db.url --preserve-env --environment=staging -- npm test',
  ]

  static flags = {
    env: Flags.string({
      default: [],
      description: 'Inline env mapping in VAR=key.path form. Repeatable.',
      multiple: true,
    }),
    'env-file': Flags.string({
      description: 'Path to a file with one VAR=key.path per line (# comments and blank lines OK).',
      required: false,
    }),
    environment: Flags.string({
      description: 'Quonfig environment to evaluate in (Mode B). Mutually exclusive with QUONFIG_ENVIRONMENT.',
      required: false,
    }),
    'preserve-env': Flags.boolean({
      default: false,
      description: 'Skip vars that are already set in the parent env. Default: override.',
    }),
  }

  // We collect everything after `--` ourselves; oclif then leaves us alone.
  static strict = false

  /**
   * Override APICommand.init() — that base eagerly calls getClient(), which
   * walks the OAuth path and fails before we've even validated the mode rule.
   * For `qfg run` in Mode A (SDK key), we never need a JWT at all; for Mode B
   * we'll mint the client on demand from run().
   */
  public async init(): Promise<void> {
    // Skip APICommand.init — call BaseCommand.init via the prototype chain.
    // Object.getPrototypeOf(APICommand.prototype) is BaseCommand.prototype.
    const baseInit = Object.getPrototypeOf(APICommand.prototype).init
    await baseInit.call(this)
  }

  public async run(): Promise<void> {
    const {argv, flags} = await this.parse(Run)

    // 1. Resolve mode (binary: Mode A SDK key, or Mode B user auth).
    const sdkKey = process.env.QUONFIG_BACKEND_SDK_KEY
    const envEnv = process.env.QUONFIG_ENVIRONMENT
    const mode = resolveRunEnvironmentMode({
      sdkKey,
      envFlag: flags.environment,
      envFromEnvironment: envEnv,
    })

    if (mode.mode === 'error') {
      this.error(mode.message, {exit: 1})
    }

    // 2. Collect VAR=key.path mappings from --env (inline) and --env-file.
    const specs: RunEnvSpec[] = []
    for (const inline of flags.env ?? []) {
      try {
        specs.push(parseInlineEnvSpec(inline))
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error), {exit: 1})
      }
    }

    if (flags['env-file']) {
      let contents: string
      try {
        contents = readFileSync(flags['env-file'], 'utf8')
      } catch (error) {
        this.error(
          `Failed to read --env-file ${flags['env-file']}: ${error instanceof Error ? error.message : String(error)}`,
          {exit: 1},
        )
      }

      try {
        specs.push(...parseEnvFileContents(contents))
      } catch (error) {
        this.error(`In ${flags['env-file']}: ${error instanceof Error ? error.message : String(error)}`, {exit: 1})
      }
    }

    // Detect duplicate VARs early. Last-write-wins would silently swallow
    // typos; we'd rather fail loud.
    const seen = new Map<string, string>()
    for (const s of specs) {
      const prev = seen.get(s.varName)
      if (prev !== undefined && prev !== s.configKey) {
        this.error(`Duplicate --env entry for ${s.varName} (${prev} vs ${s.configKey}). Pick one.`, {exit: 1})
      }

      seen.set(s.varName, s.configKey)
    }

    // 3. Locate the child command. argv after `--` is what we want; the
    // oclif parser already strips the `--` token itself. If argv is empty
    // after parsing flags, the user forgot to specify a child.
    const childArgs = [...(argv as string[])]
    if (childArgs.length === 0) {
      this.error('No child command specified. Usage: qfg run [flags] -- <cmd> [args...]', {exit: 1})
    }

    const [childCmd, ...childRest] = childArgs

    // 4. Resolve config values from Quonfig. Fail-fast on any miss.
    const resolved = await this.resolveValues(specs, mode, flags.workspace)

    // 5. Build the child env. Default: override. --preserve-env: skip set.
    const childEnv: NodeJS.ProcessEnv = {...process.env}
    for (const [varName, value] of Object.entries(resolved)) {
      if (flags['preserve-env'] && childEnv[varName] !== undefined && childEnv[varName] !== '') {
        this.verboseLog('preserve-env: keeping parent env', {varName})
        continue
      }

      childEnv[varName] = value
    }

    // 6. Spawn. stdio:inherit so the child gets the real TTY where applicable.
    await this.execChild(childCmd, childRest, childEnv)
  }

  private async execChild(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    this.verboseLog('qfg run: spawning child', {cmd, args, varCount: Object.keys(env).length})

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(cmd, args, {env, stdio: 'inherit'})

      child.on('error', (error) => {
        // ENOENT etc. — fires before 'exit'. 127 is the conventional shell
        // exit code for "command not found".
        const msg = error instanceof Error ? error.message : String(error)
        process.stderr.write(`qfg run: failed to spawn '${cmd}': ${msg}\n`)
        resolve(127)
      })

      child.on('exit', (code, signal) => {
        if (signal) {
          // Mirror the shell convention: signal-killed → 128 + signal number.
          const signalNumbers: Record<string, number> = {SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9}
          resolve(128 + (signalNumbers[signal] ?? 0))
          return
        }

        resolve(code ?? 0)
      })
    })

    // process.exit so the child's exit code becomes our exit code, even if
    // oclif's outer catch handler would otherwise mask non-zero codes.
    // In NODE_ENV=test we throw a typed error instead so the test runner
    // can inspect it without process.exit killing the harness.
    if (process.env.NODE_ENV === 'test') {
      const err = new Error(`__test_child_exit__:${exitCode}`) as {childExitCode?: number} & Error
      err.childExitCode = exitCode
      throw err
    }

    // qfg run: propagating the child's exit code is the whole feature; we
    // can't `throw` here because oclif's outer catch handler masks the
    // numeric code with 1.
    // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
    process.exit(exitCode)
  }

  /**
   * Resolve a single RawConfigWithDependencies into a stringified env value.
   * Mirrors the providedBy / decryptWith handling in commands/get.ts so the
   * two paths agree on what "the value of this key on the CLI host" means.
   */
  private resolveOne(key: string, config: RawConfigWithDependencies): string | undefined {
    let value: unknown = config.value

    const providedBy = config.dependencies?.find((d) => d.dependencyType === 'providedBy')
    if (providedBy) {
      const envVarName = providedBy.source
      const envValue = process.env[envVarName]
      if (envValue === undefined) {
        throw new Error(`provided by env var '${envVarName}' which is not set`)
      }

      value = envValue
    }

    const decryptWith = config.dependencies?.find((d) => d.dependencyType === 'decryptWith')
    if (decryptWith?.config) {
      const encKeyConfig = decryptWith.config
      const keyProvided = encKeyConfig.dependencies?.find((d) => d.dependencyType === 'providedBy')
      if (keyProvided) {
        const envVarName = keyProvided.source
        const encryptionKey = process.env[envVarName]
        if (encryptionKey === undefined) {
          throw new Error(
            `decryptWith key '${encKeyConfig.key}' is provided by env var '${envVarName}' which is not set`,
          )
        }

        if (typeof value !== 'string') {
          throw new TypeError(`marked decryptWith but value is not a string`)
        }

        value = decrypt(value, encryptionKey)
      }
    }

    if (value === null || value === undefined) return undefined
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    return JSON.stringify(value)
  }

  private async resolveValues(
    specs: RunEnvSpec[],
    mode: {mode: 'sdk-key'; sdkKey: string} | {mode: 'user'; environmentName: string},
    workspaceFlag: string | undefined,
  ): Promise<Record<string, string>> {
    if (specs.length === 0) {
      this.warn('qfg run: no --env or --env-file mappings provided. The child will run with the parent env unchanged.')
      return {}
    }

    if (mode.mode === 'sdk-key') {
      return this.resolveViaSdkKey(specs, mode.sdkKey)
    }

    return this.resolveViaUserAuth(specs, mode.environmentName, workspaceFlag)
  }

  private async resolveViaSdkKey(specs: RunEnvSpec[], sdkKey: string): Promise<Record<string, string>> {
    // Mode A — talk to api-delivery via the @quonfig/node Quonfig SDK so we
    // get the same evaluation path production apps use.
    const quonfig = new Quonfig({
      sdkKey,
      collectEvaluationSummaries: false,
      collectLoggerCounts: false,
      contextUploadMode: 'none',
      enableSSE: false,
      apiUrls: [getDeliveryUrl()],
    })

    try {
      await quonfig.init()
    } catch (error) {
      this.error(
        `qfg run: failed to initialize Quonfig with QUONFIG_BACKEND_SDK_KEY: ${error instanceof Error ? error.message : String(error)}`,
        {exit: 1},
      )
    }

    const resolved: Record<string, string> = {}
    const missing: string[] = []

    for (const spec of specs) {
      const value = quonfig.get(spec.configKey)
      if (value === undefined || value === null) {
        missing.push(spec.configKey)
        continue
      }

      resolved[spec.varName] = String(value)
    }

    if (missing.length > 0) {
      this.error(
        `qfg run: missing config key(s) in workspace (mode=sdk-key): ${missing.join(', ')}. Child not spawned.`,
        {exit: 1},
      )
    }

    return resolved
  }

  private async resolveViaUserAuth(
    specs: RunEnvSpec[],
    environmentName: string,
    workspaceFlag: string | undefined,
  ): Promise<Record<string, string>> {
    // Mode B — same path as `qfg get`: POST /api/v1/evaluations/evaluate
    // with workspaceId + environmentName, then resolve providedBy /
    // decryptWith chains locally on the CLI host (qfg-c7d).
    this.rawApiClient = await getClient(this, undefined, workspaceFlag)

    const metadataRequest = await this.apiClient.post('/api/v1/metadata/list', {workspaceId: this.workspaceId})
    if (!metadataRequest.ok) {
      const detail = (metadataRequest.error as {error?: string} | undefined)?.error ?? `HTTP ${metadataRequest.status}`
      this.error(`qfg run: failed to fetch configs: ${detail}`, {exit: 1})
    }

    interface ConfigMetadata {
      key: string
    }

    const metaJson = metadataRequest.json as unknown as {configs?: ConfigMetadata[]}
    const allKeys = new Set((metaJson.configs ?? []).map((c) => c.key))

    const missingMeta = specs.filter((s) => !allKeys.has(s.configKey)).map((s) => s.configKey)
    if (missingMeta.length > 0) {
      this.error(`qfg run: missing config key(s) in workspace: ${missingMeta.join(', ')}. Child not spawned.`, {
        exit: 1,
      })
    }

    const evalRequest = await this.apiClient.post('/api/v1/evaluations/evaluate', {
      workspaceId: this.workspaceId,
      environmentName,
      context: {},
    })

    if (!evalRequest.ok) {
      const detail = (evalRequest.error as {error?: string} | undefined)?.error ?? `HTTP ${evalRequest.status}`
      this.error(`qfg run: failed to evaluate configs: ${detail}`, {exit: 1})
    }

    const results = (Array.isArray(evalRequest.json) ? evalRequest.json : []) as RawConfigWithDependencies[]
    const byKey = new Map(results.map((r) => [r.key, r]))

    const resolved: Record<string, string> = {}
    const errors: string[] = []

    for (const spec of specs) {
      const config = byKey.get(spec.configKey)
      if (!config) {
        errors.push(`${spec.configKey}: not evaluable in environment "${environmentName}"`)
        continue
      }

      try {
        const value = this.resolveOne(spec.configKey, config)
        if (value === undefined) {
          errors.push(`${spec.configKey}: produced no value`)
          continue
        }

        resolved[spec.varName] = value
      } catch (error) {
        errors.push(`${spec.configKey}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (errors.length > 0) {
      this.error(
        `qfg run: failed to resolve ${errors.length} config(s). Child not spawned.\n  - ${errors.join('\n  - ')}`,
        {exit: 1},
      )
    }

    return resolved
  }
}
