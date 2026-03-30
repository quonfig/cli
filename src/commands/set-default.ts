import {Flags} from '@oclif/core'
import {ProvidedSource} from '@quonfig/node'

import {APICommand} from '../index.js'
import {ConfigValueType} from '@quonfig/node'
import {JsonObj} from '../result.js'
import getConfirmation, {confirmFlag} from '../ui/get-confirmation.js'
import getEnvironment from '../ui/get-environment.js'
import getString from '../ui/get-string.js'
import autocomplete from '../util/autocomplete.js'
import {checkmark} from '../util/color.js'
import {mapConfigValueToDto} from '../util/config-value-dto.js'
import {makeConfidentialValue} from '../util/encryption.js'
import isInteractive from '../util/is-interactive.js'
import nameArg from '../util/name-arg.js'
import secretFlags, {Secret, parsedSecretFlags} from '../util/secret-flags.js'

type ValueOrEnvVar = {envVar: string; value?: never} | {envVar?: never; value: string}

export default class SetDefault extends APICommand {
  static args = {...nameArg}

  static description = 'Set/update the default value for an environment (other rules still apply)'

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag.name # will prompt for value and env',
    '<%= config.bin %> <%= command.id %> my.flag.name --value=true --environment=staging',
    '<%= config.bin %> <%= command.id %> my.flag.name --value=true --secret',
    '<%= config.bin %> <%= command.id %> my.config.name --env-var=MY_ENV_VAR_NAME --environment=production',
  ]

  static flags = {
    confidential: Flags.boolean({default: false, description: 'mark the value as confidential'}),
    'env-var': Flags.string({description: 'environment variable to use as default value'}),
    environment: Flags.string({description: 'environment to change'}),
    value: Flags.string({description: 'new default value'}),
    ...confirmFlag,
    ...secretFlags('encrypt the value of this item'),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(SetDefault)

    let secret = parsedSecretFlags(flags)

    if (flags['env-var'] && flags.value) {
      return this.err('cannot specify both --env-var and --value')
    }

    if (flags['env-var'] && secret.selected) {
      return this.err('cannot specify both --env-var and --secret')
    }

    if (flags.confidential && secret.selected) {
      console.warn("Note: --confidential is implied when using --secret, so you don't need to specify both.")
    }

    // Validate required arguments before making API calls
    if (!args.name && !isInteractive(flags)) {
      return this.err("'name' argument is required when interactive mode isn't available.")
    }

    if (!flags.environment && !isInteractive(flags)) {
      return this.err("'environment' is required when interactive mode isn't available.")
    }

    // Fetch all configs from metadata endpoint
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
      valueType: string
      version: number
    }

    interface ConfigMetadataResponse {
      configs: ConfigMetadata[]
    }

    const metadataResponse = metadataRequest.json as unknown as ConfigMetadataResponse
    const configs = metadataResponse.configs

    // Get the key - from args or prompt
    let key = args.name

    if (!key && isInteractive(flags)) {
      const configKeys = configs.map((c) => c.key)
      const selectedKey = await autocomplete({
        message: 'Which item would you like to change the default for?',
        source: configKeys,
      })
      if (selectedKey) {
        key = selectedKey
      }
    }

    if (!key) {
      return this.err("'name' argument is required when interactive mode isn't available.")
    }

    const config = configs.find((c) => c.key === key)

    if (!config) {
      return this.err(`Could not find config named ${key}`)
    }

    this.verboseLog('Selected config:', config)

    // Check if existing config has encrypted values
    if (!secret.selected) {
      const configDetailsRequest = await this.apiClient.post('/api/v1/metadata/getByKey', {workspaceId: this.workspaceId, key})
      if (configDetailsRequest.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const configDetails = configDetailsRequest.json as any
        this.verboseLog('Config details:', configDetails)

        // Check if any existing rules have encrypted values
        if (configDetails.default?.rules) {
          for (const rule of configDetails.default.rules) {
            if (rule.value?.decryptWith) {
              this.verboseLog('Auto-detected encryption from existing config')
              secret = {
                keyName: secret.keyName,
                selected: true,
              }
              break
            }
          }
        }
      }
    }

    // Get the environment
    const environment = await getEnvironment({
      command: this,
      flags,
      message: 'Which environment would you like to change the default for?',
      providedEnvironment: flags.environment,
    })

    this.verboseLog({environment})

    if (!environment) {
      return
    }

    const {confidential} = flags

    // Get the value
    if (flags['env-var']) {
      if (
        !(await getConfirmation({
          flags,
          message: `Confirm: change the default for ${key} in ${environment.name} to be provided by \`${flags['env-var']}\`? yes/no`,
        }))
      ) {
        return
      }

      return this.submitChange({
        confidential,
        config,
        envVar: flags['env-var'],
        environment,
        environmentId: environment.id,
        key,
        secret,
      })
    }

    let value = flags.value

    if (!value && isInteractive(flags)) {
      value = await getString({
        allowBlank: true,
        message: 'Default value',
      })
    }

    if (value === undefined) {
      return this.err('Value is required')
    }

    const secretMaybe = secret.selected ? ' (encrypted)' : ''
    const message = `Confirm: change the default for ${key} in ${environment.name} to \`${value}\`${secretMaybe}? yes/no`

    if (!(await getConfirmation({flags, message}))) {
      return
    }

    return this.submitChange({
      confidential,
      config,
      environment,
      environmentId: environment.id,
      key,
      secret,
      value,
    })
  }

  private async submitChange({
    confidential,
    config,
    envVar,
    environment,
    environmentId,
    key,
    secret,
    value,
  }: {
    confidential: boolean
    config: {valueType: string; version: number}
    environment: {id: string; name: string}
    environmentId: string
    key: string
    secret: Secret
  } & ValueOrEnvVar) {
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

    const type = typeMapping[config.valueType.toLowerCase()] || config.valueType

    let configValue: Record<string, unknown>
    let successMessage: string

    if (envVar === undefined) {
      successMessage = `Successfully changed default to \`${value}\``

      if (secret.selected) {
        // Handle encrypted values using shared utility
        const encryptedValueResult = await makeConfidentialValue(this, value, secret, environmentId)
        if (!encryptedValueResult.ok) {
          return this.err(encryptedValueResult.message || 'Failed to encrypt value')
        }

        configValue = mapConfigValueToDto(encryptedValueResult.value, ConfigValueType.String)
        successMessage += ' (encrypted)'
      } else {
        // Parse the value based on type and build value object
        let variantValue: unknown = value
        let variantType: string = type

        switch (type) {
          case 'stringList': {
            variantValue = value.split(',')
            variantType = 'string_list'

            break
          }
          case 'bool': {
            const lowerValue = value.toLowerCase()
            if (lowerValue !== 'true' && lowerValue !== 'false') {
              return this.err(`'${value}' is not a valid value for ${key}`)
            }
            variantValue = lowerValue === 'true'

            break
          }
          case 'int': {
            variantValue = Number.parseInt(value, 10)
            if (Number.isNaN(variantValue)) {
              return this.err(`Invalid default value for int: ${value}`)
            }

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

        configValue = {
          type: variantType,
          value: variantValue,
        }
      }
    } else {
      configValue = {
        provided: {
          lookup: envVar,
          source: ProvidedSource.EnvVar,
        },
      }
      successMessage = `Successfully changed default to be provided by \`${envVar}\``
    }

    if (confidential && !secret.selected) {
      configValue.confidential = true
      successMessage += ' (confidential)'
    }

    const payload = {
      configKey: key,
      currentVersionId: config.version,
      environmentId: environmentId ? Number.parseInt(environmentId, 10) : 0,
      value: configValue,
    }

    this.verboseLog('Payload:', payload)

    const request = await this.apiClient.post('/internal/ops/v1/set-default', payload)

    if (request.ok) {
      this.log(`${checkmark} ${successMessage}`)

      return {
        environment: {
          id: environmentId,
          name: environment.name,
        },
        key,
        success: true,
        value,
      }
    }

    this.verboseLog(request.error)

    const errMsg =
      request.status === 400
        ? `Failed to change default: ${request.status} -- is ${value || envVar} a valid value?`
        : `Failed to change default: ${request.status}`

    return this.err(errMsg, {key, serverError: request.error})
  }
}
