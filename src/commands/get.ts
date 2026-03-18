import {Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {JsonObj} from '../result.js'
import autocomplete from '../util/autocomplete.js'
import getEnvironment from '../ui/get-environment.js'
import isInteractive from '../util/is-interactive.js'
import nameArg from '../util/name-arg.js'
import {decrypt} from '../util/encryption.js'

interface EvaluationMetadata {
  conditionalValueIndex: number
  configRowIndex: number
  id: number
  type: string
  valueType: string
}

interface Dependency {
  config?: ConfigWithDependencies
  dependencyType: 'decryptWith' | 'providedBy'
  source: string
}

interface ConfigWithDependencies {
  confidential?: boolean
  dependencies?: Dependency[]
  key: string
  metadata: EvaluationMetadata
  type: string
  value: string
}

interface EvaluationResponseV2 {
  config: ConfigWithDependencies
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
    const metadataRequest = await this.apiClient.get('/all-config-types/v1/metadata')

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

    const request = await this.apiClient.get(
      `/evaluation/v2/eval?key=${encodeURIComponent(key)}&envId=${encodeURIComponent(environment.id)}`,
    )

    if (!request.ok) {
      const errorMsg = request.error?.error || `Failed to get config: ${request.status}`
      return this.err(errorMsg, {serverError: request.error})
    }

    const response = request.json as unknown as EvaluationResponseV2
    const config = response.config
    let value = config.value

    // Check if this config has dependencies
    if (config.dependencies && config.dependencies.length > 0) {
      // Check for providedBy dependency (config value from env var)
      const providedByDep = config.dependencies.find((dep) => dep.dependencyType === 'providedBy')

      if (providedByDep) {
        const envVarName = providedByDep.source
        this.log(`This config is provided by env var '${envVarName}'`)

        // Check if the env var is present
        const envValue = process.env[envVarName]

        if (!envValue) {
          return this.err(`Environment variable '${envVarName}' is not set. Cannot resolve config '${key}'.`, {
            [key]: value,
            provided: true,
            missingEnvVar: envVarName,
          })
        }

        value = envValue
        this.log(`Successfully resolved config '${key}' from env var`)
      }

      // Check for decryptWith dependency (encrypted config)
      const decryptWithDep = config.dependencies.find((dep) => dep.dependencyType === 'decryptWith')

      if (decryptWithDep && decryptWithDep.config) {
        const encryptionKeyConfig = decryptWithDep.config

        // Find the providedBy dependency to get the env var name for the encryption key
        const keyProvidedByDep = encryptionKeyConfig.dependencies?.find((dep) => dep.dependencyType === 'providedBy')

        if (keyProvidedByDep) {
          const envVarName = keyProvidedByDep.source
          this.log(
            `This config is encrypted by key '${encryptionKeyConfig.key}' that should be found in env var '${envVarName}'`,
          )

          // Check if the env var is present
          const encryptionKey = process.env[envVarName]

          if (!encryptionKey) {
            return this.err(`Environment variable '${envVarName}' is not set. Cannot decrypt config '${key}'.`, {
              [key]: value,
              encrypted: true,
              missingEnvVar: envVarName,
            })
          }

          // Attempt decryption
          try {
            value = decrypt(value, encryptionKey)
            this.log(`Successfully decrypted config '${key}'`)
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error)
            return this.err(`Failed to decrypt config '${key}': ${errorMessage}`, {
              [key]: value,
              encrypted: true,
              error: errorMessage,
            })
          }
        }
      }
    }

    return this.ok(this.toSuccessJson(value), {[key]: value})
  }
}
