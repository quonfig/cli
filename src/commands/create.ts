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
import {EntitySubdir, writeStoredConfigToWorkspace} from '../util/local-config-writer.js'
import {LOG_LEVELS, LOG_LEVEL_KEY_PREFIX, isLogLevel} from '../util/log-levels.js'
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
  duration      An ISO 8601 duration string, e.g. PT30S, PT5M, PT1H30M (SDK returns milliseconds)
  log_level     A dynamic log level (value must be one of ${LOG_LEVELS.join('/')})

This sets the global default value. Override per-environment with:
  qfg set-default my.flag --environment production --value true

For a percentage rollout (gradual rollout / A/B test / canary deploy), use:
  qfg set-rollout my.flag --environment production --true-percent 20

Or edit the JSON config file directly for complex targeting rules:
  qfg config-schema          # full operator reference + examples
  qfg pull --dir ./config    # clone workspace, then edit JSON and git push

Log levels:
  qfg create log-level.my-app --type log_level --value WARN
  # Log-level keys must start with "${LOG_LEVEL_KEY_PREFIX}".
  # For per-logger targeting, create ONE log-level config per service and add
  # rules on the "quonfig-sdk-logging.key" context property (e.g.
  # PROP_STARTS_WITH_ONE_OF MyPackage.) rather than one config per logger.`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.new.flag --type boolean-flag',
    '<%= config.bin %> <%= command.id %> my.new.flag --type boolean-flag --value=true',
    '<%= config.bin %> <%= command.id %> my.new.string --type string --value="hello world"',
    '<%= config.bin %> <%= command.id %> my.new.string --type string --value="hello world" --secret',
    '<%= config.bin %> <%= command.id %> my.new.string --type string --env-var=MY_ENV_VAR_NAME',
    '<%= config.bin %> <%= command.id %> my.new.string --type json --value="{\\"key\\": \\"value\\"}"',
    '<%= config.bin %> <%= command.id %> my.timeout --type duration --value PT90S',
    '<%= config.bin %> <%= command.id %> log-level.my-app --type log_level --value WARN',
    '# After creating a flag, set a 20% rollout in production:',
    '<%= config.bin %> set-rollout my.new.flag --environment production --true-percent 20',
  ]

  static flags = {
    confidential: Flags.boolean({default: false, description: 'mark the value as confidential'}),
    'env-var': Flags.string({description: 'environment variable to get value from'}),
    type: Flags.string({
      options: ['boolean-flag', 'boolean', 'string', 'double', 'int', 'string-list', 'json', 'duration', 'log_level'],
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

    if (flags.type === 'log_level') {
      return this.createLogLevel(args, flags)
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
        defaultValue: mapConfigValueToDto(configValue, valueType),
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

    await this.syncConfigToDisk('configs', key, response)

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
        defaultValue: {
          type: 'bool',
          value: defaultValue,
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

    await this.syncConfigToDisk('feature-flags', key, response)

    return this.ok(`${checkmark} Created boolean flag: ${key}`, {key, ...response})
  }

  private async createLogLevel(
    args: {name: string},
    flags: {
      confidential: boolean
      'env-var'?: string
      interactive?: boolean
      secret: boolean
      'secret-key-name': string
      value?: string
    },
  ): Promise<JsonObj | void> {
    const key = args.name

    if (!key.startsWith(LOG_LEVEL_KEY_PREFIX)) {
      return this.err(
        `Log level key "${key}" must start with "${LOG_LEVEL_KEY_PREFIX}". Try: ${LOG_LEVEL_KEY_PREFIX}${key}`,
        {key, phase: 'validation'},
      )
    }

    const secret = parsedSecretFlags(flags)
    if (secret.selected) {
      return this.err('--secret is not supported for log_level (values are enum, not free-form strings)')
    }

    if (flags['env-var']) {
      return this.err('--env-var is not supported for log_level (values must be one of the enum constants)')
    }

    if (flags.confidential) {
      return this.err('--confidential is not supported for log_level')
    }

    const valueInput = await getValue({
      desiredValue: flags.value,
      flags,
      message: `Default log level (${LOG_LEVELS.join('/')})`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      quonfig: undefined as any,
    })

    if (!valueInput.ok) {
      if (valueInput.error) {
        return this.err(valueInput.message, valueInput.json)
      }

      return
    }

    const rawValue = valueInput.value.toUpperCase()
    if (!isLogLevel(rawValue)) {
      return this.err(`Invalid log level "${valueInput.value}". Must be one of: ${LOG_LEVELS.join(', ')}`, {
        key,
        phase: 'validation',
      })
    }

    // Step 1: create the log-level config. The server always writes INFO as the
    // initial default, so we patch it to the requested value below if needed.
    const createInput = {
      workspaceId: this.workspaceId,
      logLevel: {key},
    }

    this.verboseLog('RPC logLevels/create', createInput)

    const createRequest = await this.apiClient.post('/api/v1/logLevels/create', createInput)

    if (!createRequest.ok) {
      const errMsg =
        createRequest.status === 409
          ? `Failed to create log level: ${key} already exists`
          : `Failed to create log level: ${createRequest.status} | ${JSON.stringify(createRequest.error)}`

      return this.err(errMsg, {key, phase: 'creation', serverError: createRequest.error})
    }

    const createResponse = createRequest.json as {commitSha?: string}

    // Step 2: if the requested value isn't the server's default (INFO), update.
    if (rawValue !== 'INFO') {
      if (!createResponse.commitSha) {
        return this.err('Server did not return commitSha after create; cannot patch default value', {
          key,
          phase: 'update',
        })
      }

      const updateInput = {
        workspaceId: this.workspaceId,
        logLevelKey: key,
        logLevel: {
          default: {
            rules: [
              {
                criteria: [{operator: 'ALWAYS_TRUE'}],
                value: {type: 'log_level', value: rawValue},
              },
            ],
          },
        },
        expectedCommitSha: createResponse.commitSha,
      }

      this.verboseLog('RPC logLevels/update', updateInput)

      const updateRequest = await this.apiClient.post('/api/v1/logLevels/update', updateInput)

      if (!updateRequest.ok) {
        return this.err(
          `Log level created with default INFO, but failed to set value to ${rawValue}: ${updateRequest.status}. Run \`qfg set-default ${key} --value=${rawValue}\` to retry.`,
          {key, phase: 'update', serverError: updateRequest.error},
        )
      }
    }

    return this.ok(`${checkmark} Created log level: ${key} (default: ${rawValue})`, {
      key,
      value: rawValue,
    })
  }

  /**
   * Mirror the server-side create to disk under QUONFIG_DIR so the user can
   * `qfg verify` (or just open the JSON) without a follow-up `qfg pull`.
   * Best-effort — server already created the flag, so we never let local-disk
   * problems fail the command. Closes qfg-d5t.
   */
  private async syncConfigToDisk(subdir: EntitySubdir, key: string, response: JsonObj | undefined): Promise<void> {
    if (!response) return

    try {
      const result = await writeStoredConfigToWorkspace({
        subdir,
        key,
        storedConfig: response as Record<string, unknown>,
      })
      if (result) {
        this.verboseLog('LocalWrite', {
          path: result.filePath,
          committed: result.committed,
          skippedCommitReason: result.skippedCommitReason,
        })
      } else {
        this.verboseLog('LocalWrite', 'skipped: QUONFIG_DIR not set or workspace dir missing')
      }
    } catch (error: unknown) {
      this.verboseLog('LocalWrite', `Failed to sync ${key} to disk: ${String(error)}`)
    }
  }
}
