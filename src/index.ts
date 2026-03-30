export {run} from '@oclif/core'
import {Command, Flags} from '@oclif/core'

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

export abstract class BaseCommand extends Command {
  static baseFlags = {
    ...globalFlags,
  }

  public static enableJsonFlag = true

  public err = (error: Error | object | string, json?: JsonObj): never => {
    if (this.jsonEnabled()) {
      throw json ?? error
    }

    if (typeof error === 'string') {
      return this.error(error, {code: 'ERR', exit: 1})
    }

    this.error(this.toErrorJson(error), {code: 'ERR', exit: 1})
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

    // In test environment, just re-throw the error
    if (process.env.NODE_ENV === 'test') {
      throw err
    }

    // In production, log the error message without stack trace
    this.log(err.message)
    this.exit(err.exitCode || 1)
  }

  public async init(): Promise<void> {
    await super.init()

    const {flags} = await this.parse()

    this.isVerbose = flags.verbose
  }
}

export abstract class APICommand extends BaseCommand {
  static baseFlags = {
    ...globalFlags,
    profile: Flags.string({
      char: 'p',
      description: 'Profile to use (defaults to ENV var QUONFIG_PROFILE or "default")',
      helpGroup: 'GLOBAL',
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

    this.rawApiClient = await rawGetClient(this, undefined, flags.profile)

    // For JWT-based auth, we'll need to get environment info from the token
    // For now, set a placeholder - this should be enhanced later
    this.currentEnvironment = {id: 'unknown', projectId: 0}
  }
}
