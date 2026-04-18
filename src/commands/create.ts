import {Args, Flags} from '@oclif/core'
import {ProvidedSource, ConfigValueType} from '@quonfig/node'

import {APICommand} from '../index.js'
import type {ConfigValue} from '@quonfig/node'
import {JsonObj} from '../result.js'
import getValue from '../ui/get-value.js'
import {TYPE_MAPPING, coerceBool, coerceIntoType} from '../util/coerce.js'
import {checkmark} from '../util/color.js'
import {mapConfigValueToDto, mapValueTypeToString} from '../util/config-value-dto.js'
import {makeConfidentialValue} from '../util/encryption.js'
import secretFlags, {parsedSecretFlags} from '../util/secret-flags.js'

export default class Create extends APICommand {
  static args = {
    name: Args.string({description: 'name for your new item (e.g. my.new.flag)', required: true}),
  }

  static description = `Create a new feature flag, config value, or other item.

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
  qfg pull --dir ./config    # clone workspace, then edit JSON and git push`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.new.flag --type boolean-flag',
    '<%= config.bin %> <%= command.id %> my.new.flag --type boolean-flag --value=true',
    '<%= config.bin %> <%= command.id %> my.new.string --type string --value="hello world"',
    '<%= config.bin %> <%= command.id %> my.new.string --type string --value="hello world" --secret',
    '<%= config.bin %> <%= command.id %> my.new.string --type string --env-var=MY_ENV_VAR_NAME',
    '<%= config.bin %> <%= command.id %> my.new.string --type json --value="{\\"key\\": \\"value\\"}"',
    '# After creating a flag, set a 20% rollout in production:',
    '<%= config.bin %> set-rollout my.new.flag --environment production --true-percent 20',
  ]

  static flags = {
    confidential: Flags.boolean({default: false, description: 'mark the value as confidential'}),
    'env-var': Flags.string({description: 'environment variable to get value from'}),
    type: Flags.string({
      options: ['boolean-flag', 'boolean', 'string', 'double', 'int', 'string-list', 'json'],
      required: true,
    }),
    value: Flags.string({description: 'default value for your new item', required: false}),
    ...secretFlags('encrypt the value of this item'),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(Create)

    if (flags.type === 'boolean-flag') {
      return this.createBooleanFlag(args, flags.value)
    }

    const key = args.name

    const secret = parsedSecretFlags(flags)

    if (flags['env-var'] && flags.value) {
      return this.err('cannot specify both --env-var and --value')
    }

    if (flags['env-var'] && secret.selected) {
      return this.err('cannot specify both --env-var and --secret')
    }

    if (flags.confidential && secret.selected) {
      console.warn("Note: --confidential is implied when using --secret, so you don't need to specify both.")
    }

    if (secret.selected && flags.type !== 'string') {
      return this.err('--secret flag only works with string type')
    }

    let configValue: ConfigValue = {}
    let valueType: ConfigValueType = TYPE_MAPPING[flags.type]

    if (flags['env-var']) {
      configValue = {
        provided: {
          lookup: flags['env-var'],
          source: ProvidedSource.EnvVar,
        },
      }
    } else {
      const valueInput = await getValue({
        desiredValue: flags.value,
        flags,
        message: 'Default value',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        quonfig: undefined as any,
      })

      if (valueInput.ok) {
        const rawValue = valueInput.value
        const parsedConfigValue = coerceIntoType(flags.type, rawValue)

        if (!parsedConfigValue) {
          return this.err(`Failed to coerce value into type: ${flags.type}`, {key, phase: 'coercion'})
        }

        configValue = parsedConfigValue[0]
        valueType = parsedConfigValue[1]

        if (secret.selected) {
          const confidentialValueResult = await makeConfidentialValue(this, rawValue, secret, '')

          if (!confidentialValueResult.ok) {
            this.resultMessage(confidentialValueResult)
            return
          }

          configValue = confidentialValueResult.value
        }
      } else if (valueInput.error) {
        return this.err(valueInput.message, valueInput.json)
      } else {
        return
      }
    }

    if (flags.confidential) {
      configValue.confidential = true
    }

    // Build oRPC input for configs/create
    const createInput = {
      workspaceId: this.workspaceId,
      config: {
        key: args.name,
        valueType: mapValueTypeToString(valueType),
        sendToClientSdk: false,
        default: {
          rules: [
            {
              criteria: [],
              value: mapConfigValueToDto(configValue, valueType),
            },
          ],
        },
      },
    }

    this.verboseLog('RPC configs/create', createInput)

    const request = await this.apiClient.post('/api/v1/configs/create', createInput)

    if (!request.ok) {
      const errMsg =
        request.status === 409
          ? `Failed to create config: ${key} already exists`
          : `Failed to create config: ${request.status} | ${JSON.stringify(request.error)}`

      return this.err(errMsg, {key, phase: 'creation', serverError: request.error})
    }

    const response = request.json

    const confidentialMaybe = flags.confidential ? '(confidential) ' : ''

    return this.ok(`${checkmark} Created ${confidentialMaybe}config: ${key}`, {key, ...response})
  }

  private async createBooleanFlag(args: {name: string}, rawDefault: string | undefined): Promise<JsonObj | void> {
    const key = args.name

    const defaultValue = coerceBool(rawDefault ?? 'false')

    // Build oRPC input for flags/create
    const createInput = {
      workspaceId: this.workspaceId,
      flag: {
        key,
        valueType: 'bool',
        sendToClientSdk: true,
        variants: [
          {
            value: {
              type: 'bool',
              value: true,
            },
            name: 'True',
            description: 'Enabled',
          },
          {
            value: {
              type: 'bool',
              value: false,
            },
            name: 'False',
            description: 'Disabled',
          },
        ],
        default: {
          rules: [
            {
              criteria: [],
              value: {
                type: 'bool',
                value: defaultValue,
              },
            },
          ],
        },
      },
    }

    this.verboseLog('RPC flags/create', createInput)

    const request = await this.apiClient.post('/api/v1/flags/create', createInput)

    if (!request.ok) {
      const errMsg =
        request.status === 409
          ? `Failed to create boolean flag: ${key} already exists`
          : `Failed to create boolean flag: ${request.status} | ${JSON.stringify(request.error)}`

      return this.err(errMsg, {key, phase: 'creation', serverError: request.error})
    }

    const response = request.json

    return this.ok(`${checkmark} Created boolean flag: ${key}`, {key, ...response})
  }
}
