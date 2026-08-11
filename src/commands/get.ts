import {Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {JsonObj} from '../result.js'
import autocomplete from '../util/autocomplete.js'
import getEnvironment from '../ui/get-environment.js'
import isInteractive from '../util/is-interactive.js'
import nameArg from '../util/name-arg.js'
import {decrypt} from '../util/encryption.js'

// Mirrors sdk-node's RawConfigWithDependencies. The /evaluations/evaluate
// endpoint returns an array of these (qfg-c7d.2) — raw stored values plus
// dependency pointers for providedBy / decryptWith chains. ENV_VAR resolution
// and decryption happen locally on the CLI host, never on the server.
interface EvaluationMetadata {
  conditionalValueIndex: number
  configRowIndex: number
  id: string
  type: string
  valueType: string
  weightedValueIndex?: number
}

interface Dependency {
  config?: RawConfigWithDependencies
  dependencyType: 'decryptWith' | 'providedBy'
  source: string
}

interface RawConfigWithDependencies {
  confidential?: boolean
  dependencies?: Dependency[]
  key: string
  metadata: EvaluationMetadata
  type: string
  value: unknown
}

export default class Get extends APICommand {
  static args = {...nameArg}

  static description = 'Get the value of a config/feature-flag/etc.'

  static examples = [
    '<%= config.bin %> <%= command.id %> my.config.name',
    '<%= config.bin %> <%= command.id %> my.config.name --environment=production',
  ]

  static flags = {
    environment: Flags.string({description: 'environment to evaluate in'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(Get)

    // Fetch metadata first for validation and autocomplete
    const metadataRequest = await this.apiClient.post('/api/v1/metadata/list', {workspaceId: this.workspaceId})

    if (!metadataRequest.ok) {
      const errorMsg = metadataRequest.error?.error || `Failed to fetch configs: ${metadataRequest.status}`
      return this.err(errorMsg, {serverError: metadataRequest.error})
    }

    interface ConfigMetadata {
      description: string
      id: number
      key: string
      name: string
      type: string
      version: number
    }

    interface ConfigMetadataResponse {
      configs: ConfigMetadata[]
    }

    const metadataResponse = metadataRequest.json as unknown as ConfigMetadataResponse
    const configKeys = metadataResponse.configs.map((c) => c.key)

    // Get the key with autocomplete
    let key = args.name

    if (!key && isInteractive(flags)) {
      const selectedKey = await autocomplete({
        message: 'Config key',
        source: configKeys,
      })

      if (selectedKey) {
        key = selectedKey
      }
    }

    if (!key) {
      return this.err('Key is required')
    }

    // Validate key exists
    const configExists = metadataResponse.configs.some((config) => config.key === key)

    if (!configExists) {
      return this.err(`${key} does not exist`)
    }

    // Get the environment
    const environment = await getEnvironment({
      command: this,
      flags,
      message: 'Which environment would you like to evaluate in?',
      providedEnvironment: flags.environment,
    })

    if (!environment) {
      return
    }

    const request = await this.apiClient.post('/api/v1/evaluations/evaluate', {
      workspaceId: this.workspaceId,
      environmentName: environment.name,
      context: {},
    })

    if (!request.ok) {
      const errorMsg = request.error?.error || `Failed to get config: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    const results = (Array.isArray(request.json) ? request.json : []) as RawConfigWithDependencies[]

    const config = results.find((r) => r.key === key)
    if (!config) {
      return this.err(`${key} could not be evaluated in this environment`)
    }

    let value: unknown = config.value

    const providedByDep = config.dependencies?.find((dep) => dep.dependencyType === 'providedBy')

    if (providedByDep) {
      const envVarName = providedByDep.source
      // qfg-zvef: diagnostics go to stderr so stdout stays a bare value —
      // `qfg get` is commonly used in `$(...)` substitutions.
      this.logToStderr(`This config is provided by env var '${envVarName}'`)

      const envValue = process.env[envVarName]

      if (envValue === undefined) {
        return this.err(`Environment variable '${envVarName}' is not set. Cannot resolve config '${key}'.`, {
          [key]: null,
          provided: true,
          missingEnvVar: envVarName,
        })
      }

      value = envValue
      this.logToStderr(`Successfully resolved config '${key}' from env var`)
    }

    const decryptWithDep = config.dependencies?.find((dep) => dep.dependencyType === 'decryptWith')

    if (decryptWithDep && decryptWithDep.config) {
      const encryptionKeyConfig = decryptWithDep.config
      const keyProvidedByDep = encryptionKeyConfig.dependencies?.find((dep) => dep.dependencyType === 'providedBy')

      if (keyProvidedByDep) {
        const envVarName = keyProvidedByDep.source
        this.logToStderr(
          `This config is encrypted by key '${encryptionKeyConfig.key}' that should be found in env var '${envVarName}'`,
        )

        const encryptionKey = process.env[envVarName]

        if (encryptionKey === undefined) {
          return this.err(`Environment variable '${envVarName}' is not set. Cannot decrypt config '${key}'.`, {
            [key]: null,
            encrypted: true,
            missingEnvVar: envVarName,
          })
        }

        if (typeof value !== 'string') {
          return this.err(`Config '${key}' is marked decryptWith but its value is not a string.`, {
            [key]: null,
            encrypted: true,
          })
        }

        try {
          value = decrypt(value, encryptionKey)
          this.logToStderr(`Successfully decrypted config '${key}'`)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error)
          return this.err(`Failed to decrypt config '${key}': ${errorMessage}`, {
            [key]: null,
            encrypted: true,
            error: errorMessage,
          })
        }
      }
    }

    return this.ok(this.toSuccessJson(value), {[key]: value as JsonObj[string]})
  }
}
