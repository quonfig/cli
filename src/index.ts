export {run} from '@oclif/core'
import {Command, Errors, Flags} from '@oclif/core'

import {Client} from '@quonfig/node'
import type {ProjectEnvId} from '@quonfig/node'
import {JsonObj, Result} from './result.js'
import rawGetClient, {unwrapRequest} from './util/get-client.js'

const globalFlags = {
  interactive: Flags.boolean({
    allowNo: true,
    default: true,
    description: 'Force interactive mode',
    helpGroup: 'GLOBAL',
  }),
  'no-color': Flags.boolean({
    default: false,
    description: 'Do not colorize output',
    env: 'NO_COLOR',
    helpGroup: 'GLOBAL',
  }),
  verbose: Flags.boolean({
    default: false,
    description: 'Verbose output',
    helpGroup: 'GLOBAL',
  }),
}

const DEFAULT_EXIT_CODE = 1

/**
 * The exit code oclif actually recorded on a thrown error.
 *
 * `Errors.CLIError` — what `this.error(msg, {exit: N})` throws — stores N on
 * `oclif.exit` and has NO `exitCode` property at all. Reading `err.exitCode`
 * therefore collapsed every non-default code (401 on the auth failures in
 * `resolve-workspace.ts` / `get-client.ts`, for one) down to 1. Exported so the
 * behaviour is unit-testable. See qfg-hzmb.
 */
export function errorExitCode(err: unknown): number {
  const candidate = err as {exitCode?: unknown; oclif?: {exit?: unknown}} | null | undefined
  if (typeof candidate?.oclif?.exit === 'number') return candidate.oclif.exit
  if (typeof candidate?.exitCode === 'number') return candidate.exitCode
  return DEFAULT_EXIT_CODE
}

/**
 * The code to actually terminate the process with.
 *
 * A POSIX exit status is one byte. Several call sites pass an HTTP-flavoured
 * code — `{exit: 401}` for the auth failures in `get-client.ts` and
 * `resolve-workspace.ts` — and `process.exit(401)` truncates to 145, which a
 * shell reads as "killed by signal 17". Anything outside 1-255 therefore
 * terminates with the plain failure code; the caller's real intent is still
 * reported verbatim as `error.exitCode` in the `--json` envelope.
 */
export function processExitCode(err: unknown): number {
  const intended = errorExitCode(err)
  return Number.isInteger(intended) && intended >= 1 && intended <= 255 ? intended : DEFAULT_EXIT_CODE
}

/** Best available human-readable message for anything that can be thrown or passed to `err()`. */
function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error !== 'object' || error === null) return String(error)

  const record = error as {error?: unknown; message?: unknown}
  if (typeof record.message === 'string') return record.message
  if (typeof record.error === 'string') return record.error
  return JSON.stringify(error)
}

export abstract class BaseCommand extends Command {
  static baseFlags = {
    ...globalFlags,
  }

  public static enableJsonFlag = true

  public err = (error: Error | object | string, json?: JsonObj): never => {
    const message = errorMessage(error)

    if (this.jsonEnabled()) {
      // qfg-hzmb: throw a real CLIError instead of a bare object, so the message
      // and the exit code survive to catch() and reach stdout. The caller's
      // structured payload is copied onto it, keeping the older contract that
      // callers (and tests) read fields such as `missingEnvVar` straight off the
      // thrown value.
      const cliError = new Errors.CLIError(message, {code: 'ERR', exit: DEFAULT_EXIT_CODE})
      Object.assign(cliError, json ?? (typeof error === 'object' && error !== null ? error : {}))
      throw cliError
    }

    return this.error(message, {code: 'ERR', exit: DEFAULT_EXIT_CODE})
  }

  public isVerbose!: boolean

  public ok = (message: object | string, json?: JsonObj) => {
    if (typeof message === 'string') {
      this.log(message)
    } else {
      this.log(this.toSuccessJson(message))
    }

    return json ?? {message}
  }

  public resultMessage = (result: Result<unknown>) => {
    if (result.error) {
      return this.err(result.message, result.json)
    }

    if (result.message) {
      this.log(result.message)
      return result.json ?? result.message
    }

    return null
  }

  public verboseLog = (category: string | unknown, message?: unknown): void => {
    if (!this.isVerbose) return

    if (message) {
      this.logToStderr(`[${category}] ${typeof message === 'string' ? message : JSON.stringify(message)}`)
    } else {
      this.logToStderr(typeof category === 'string' ? category : JSON.stringify(category))
    }
  }

  protected async catch(err: {exitCode?: number; code?: string} & Error): Promise<void> {
    // Override oclif's default error handling to suppress stack traces in production
    // but preserve error messages for tests

    // `this.exit(n)` throws an ExitError: a control-flow signal, not a failure to
    // report. `qfg verify --json` and `qfg migrate doctor --json` deliberately
    // print their payload and *then* exit non-zero (qfg-ez47), so reporting the
    // ExitError here would append a second JSON document to stdout. Hand it
    // straight to oclif, which prints nothing and honours `oclif.exit`.
    if (err instanceof Errors.ExitError || err.code === 'EEXIT') {
      throw err
    }

    // qfg-hzmb: `this.log()` is a documented no-op whenever jsonEnabled(), so
    // this override used to print NOTHING for a failing `--json` run — empty
    // stdout was indistinguishable from an empty success. Emit the structured
    // envelope on stdout, exactly as oclif's own catch() does.
    if (this.jsonEnabled()) {
      this.logJson(this.toErrorJson(err))
    }

    // In test environment, just re-throw the error
    if (process.env.NODE_ENV === 'test') {
      throw err
    }

    // In production, log the error message without stack trace
    if (!this.jsonEnabled()) {
      this.log(err.message)
    }

    this.exit(processExitCode(err))
  }

  public async init(): Promise<void> {
    await super.init()

    const {flags} = await this.parse()

    this.isVerbose = flags.verbose
  }

  /**
   * oclif's default is `{error: err}`, but `message`, `code` and `stack` are
   * non-enumerable on an Error, so `JSON.stringify` flattens a thrown Error all
   * the way down to `{}`. Re-attach the useful fields explicitly and keep the
   * caller's payload alongside them. See qfg-hzmb.
   */
  protected toErrorJson(err: unknown): {error: JsonObj} {
    if (typeof err !== 'object' || err === null) {
      return {error: {code: 'ERR', exitCode: errorExitCode(err), message: errorMessage(err)}}
    }

    // An Error's own *enumerable* properties are the structured payload handed
    // to `err()` — keep those. `oclif` is internal bookkeeping (surfaced as
    // `exitCode`), and `stack` is dropped on purpose (oclif.stacktrace=false).
    const payload: JsonObj = {}
    for (const [key, value] of Object.entries(err as Record<string, unknown>)) {
      if (key !== 'oclif' && key !== 'stack') payload[key] = value
    }

    const {code} = err as {code?: unknown}

    return {
      error: {
        ...payload,
        code: typeof code === 'string' ? code : 'ERR',
        exitCode: errorExitCode(err),
        message: errorMessage(err),
      },
    }
  }
}

export abstract class APICommand extends BaseCommand {
  static baseFlags = {
    ...globalFlags,
    workspace: Flags.string({
      char: 'w',
      description: 'Workspace slug to use (overrides QUONFIG_WORKSPACE env var and saved default)',
      helpGroup: 'GLOBAL',
      required: false,
    }),
    profile: Flags.string({
      char: 'p',
      description: 'Deprecated: use --workspace instead',
      helpGroup: 'GLOBAL',
      hidden: true,
      required: false,
    }),
  }

  public currentEnvironment!: ProjectEnvId

  public rawApiClient!: Client

  public workspaceId?: string

  get apiClient() {
    return {
      get: async (path: string) => unwrapRequest(this, this.rawApiClient.get(path)),

      post: async (path: string, payload: unknown) => unwrapRequest(this, this.rawApiClient.post(path, payload)),

      put: async (path: string, payload: unknown) => unwrapRequest(this, this.rawApiClient.put(path, payload)),
    }
  }

  public async init(): Promise<void> {
    await super.init()

    const {flags} = await this.parse()

    this.rawApiClient = await rawGetClient(this, undefined, flags.workspace ?? flags.profile)

    // For JWT-based auth, we'll need to get environment info from the token
    // For now, set a placeholder - this should be enhanced later
    this.currentEnvironment = {id: 'unknown', projectId: 0}
  }
}
