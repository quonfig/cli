import {Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {JsonObj} from '../result.js'
import getEnvironment from '../ui/get-environment.js'
import getString from '../ui/get-string.js'
import autocomplete from '../util/autocomplete.js'
import {checkmark} from '../util/color.js'
import isInteractive from '../util/is-interactive.js'
import nameArg from '../util/name-arg.js'

interface ConfigMetadata {
  description: string
  id: number
  key: string
  name: string
  type: string
  valueType: string
  version: number
}

interface ConfigMetadataResponse {
  configs: ConfigMetadata[]
}

export default class Override extends APICommand {
  static args = {...nameArg}

  static description = 'Override the value of an item for your user/SDK key combo'

  static examples = [
    '<%= config.bin %> <%= command.id %> # will prompt for name and value',
    '<%= config.bin %> <%= command.id %> my.flag.name --value=true',
    '<%= config.bin %> <%= command.id %> my.flag.name --remove',
    '<%= config.bin %> <%= command.id %> my.double.config --value=3.14159',
  ]

  static flags = {
    environment: Flags.string({description: 'environment to override in'}),
    remove: Flags.boolean({default: false, description: 'remove your override (if present)'}),
    value: Flags.string({description: 'value to use for your override'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(Override)

    if (flags.remove && flags.value) {
      this.err('remove and value flags are mutually exclusive')
    }

    // Fetch all configs from metadata endpoint
    const metadataRequest = await this.apiClient.get('/all-config-types/v1/metadata')

    if (!metadataRequest.ok) {
      const errorMsg = metadataRequest.error?.error || `Failed to fetch configs: ${metadataRequest.status}`
      return this.err(errorMsg, {serverError: metadataRequest.error})
    }

    const metadataResponse = metadataRequest.json as unknown as ConfigMetadataResponse
    const configs = metadataResponse.configs

    // Get the environment
    const environment = await getEnvironment({
      command: this,
      flags,
      message: 'Which environment would you like to override in?',
      providedEnvironment: flags.environment,
    })

    if (!environment) {
      return
    }

    // Get the key - from args or prompt
    let key = args.name

    if (!key && isInteractive(flags)) {
      const configKeys = configs.map((c) => c.key)
      const selectedKey = await autocomplete({
        message: 'Which item would you like to override?',
        source: configKeys,
      })
      if (selectedKey) {
        key = selectedKey
      }
    }

    if (!key) {
      return this.err('Key is required')
    }

    const config = configs.find((c) => c.key === key)

    if (!config) {
      return this.err(`Could not find config named ${key}`)
    }

    this.verboseLog('Selected config:', config)

    if (flags.remove) {
      return this.removeOverride(key, environment.id, config.version)
    }

    // Get the value
    let value = flags.value

    if (!value && isInteractive(flags)) {
      value = await getString({
        allowBlank: false,
        message: 'Override value',
      })
    }

    if (!value) {
      return this.err('Value is required')
    }

    return this.setOverride(config, value, environment.id)
  }

  private async removeOverride(key: string, environmentId: string, currentVersionId: number): Promise<void> {
    const request = await this.apiClient.post('/internal/ops/v1/remove-variant', {
      configKey: key,
      currentVersionId,
      environmentId,
    })

    if (request.ok) {
      this.log(`${checkmark} Override removed`)
      return
    }

    // Handle 404 case - no override exists to remove
    if (request.status === 404) {
      this.log(`No override found for ${key}`)
      return
    }

    this.err(`Failed to remove override: ${request.status}`, {key, serverError: request.error})
  }

  private async setOverride(config: ConfigMetadata, value: string, environmentId: string): Promise<JsonObj | void> {
    const {key, valueType, version} = config

    // Map the valueType to the format expected by the API
    /* eslint-disable camelcase */
    const typeMapping: Record<string, string> = {
      bool: 'bool',
      string: 'string',
      int: 'int',
      double: 'double',
      string_list: 'stringList',
      json: 'json',
      limit_definition: 'limitDefinition',
      duration: 'duration',
      int_range: 'intRange',
    }
    /* eslint-enable camelcase */

    const type = typeMapping[valueType.toLowerCase()] || valueType

    // Parse the value based on type and build variant object
    let variantValue: unknown = value
    let variantType: string = type

    switch (type) {
      case 'stringList': {
        variantValue = value.split(',')
        variantType = 'string_list'

        break
      }
      case 'bool': {
        variantValue = value.toLowerCase() === 'true'

        break
      }
      case 'int': {
        variantValue = Number.parseInt(value, 10)

        break
      }
      case 'double': {
        variantValue = Number.parseFloat(value)

        break
      }
      case 'json': {
        try {
          variantValue = JSON.parse(value)
        } catch {
          return this.err(`Invalid JSON value: ${value}`)
        }

        break
      }
      case 'string': {
        variantValue = value

        break
      }
      // No default
    }

    const request = await this.apiClient.post('/internal/ops/v1/assign-variant', {
      configKey: key,
      currentVersionId: version,
      environmentId,
      variant: {
        type: variantType,
        value: variantValue,
      },
    })

    if (request.ok) {
      this.log(`${checkmark} Override set`)

      return {key, success: true}
    }

    const errMsg =
      request.status === 400
        ? `Failed to override value: ${request.status} -- is ${value} a valid ${type}?`
        : `Failed to override value: ${request.status}`

    this.err(errMsg, {key, serverError: request.error})
  }
}
