import {Args, Flags} from '@oclif/core'
import {ProvidedSource, ConfigValueType} from '@quonfig/node'

import {
  type ProposeOptions,
  failWithProposeHint,
  parseProposeFlags,
  proposeFlags,
  submitProposal,
} from '../change-requests/propose.js'
import {APICommand} from '../index.js'
import type {ConfigValue} from '@quonfig/node'
import {JsonObj} from '../result.js'
import {
  SECRET_KEY_NAME_ERROR,
  SecretCommandError,
  VALUE_ARGV_WARNING,
  defaultCreateAccess,
  firstSecretNotice,
  jsonValue,
  knownSecretFailure,
  openCommandSnapshot,
  pushPlan,
  readabilityNote,
} from '../secrets/secret-command.js'
import {planSecretCreate} from '../secrets/secret-write-flow.js'
import getKeyset from '../ui/get-keyset.js'
import getValue from '../ui/get-value.js'
import {TYPE_MAPPING, coerceBool, coerceIntoType} from '../util/coerce.js'
import {checkmark} from '../util/color.js'
import {mapConfigValueToDto, mapValueTypeToString} from '../util/config-value-dto.js'
import {redactToken} from '../util/git-ops.js'
import isInteractive from '../util/is-interactive.js'
import {EntitySubdir, writeStoredConfigToWorkspace} from '../util/local-config-writer.js'
import {LOG_LEVELS, LOG_LEVEL_KEY_PREFIX, isLogLevel} from '../util/log-levels.js'
import {policyAKeyError} from '../util/policy-a-key.js'
import {RedactedSummary, redactedDisplay, redactedSummary, scrubConfidentialValues} from '../util/redact.js'
import {notice} from '../util/stderr-notice.js'
import secretFlags, {parsedSecretFlags} from '../util/secret-flags.js'
import {resolveValueSource, valueSourceFlags} from '../util/value-source.js'

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

Secrets (--secret) are encrypted on this machine to one of the workspace's
keysets (quonfig.json secrets.keysets) and stored in secrets/<key>.json. Writing
needs no private key. With several keysets, pick one with --keyset (or at the
prompt). Secrets are STRING-ONLY: --secret implies --type string, so you can
leave --type off. To store a JSON secret, store the JSON as a string secret and
JSON.parse it in your app. The CLI never prints a secret's plaintext: it shows
the keyset, its key fingerprint and a redacted summary like
[encrypted *****3fa9c, 51 chars, ends …a1b2].

Keep the value out of argv / shell history / agent transcripts with:
  --value-stdin             read the value from stdin
  --value-from-env=VAR      read the value from a local env var, now
These are different from --env-var, which stores NO value: it tells the SDK to
read the value from that env var at runtime.

This sets the global default value. Override per-environment with:
  qfg set-default my.flag --environment production --value true

For a percentage rollout (gradual rollout / A/B test / canary deploy), use:
  qfg set-rollout my.flag --environment production --true-percent 20

Or edit the JSON config file directly for complex targeting rules:
  qfg config-schema          # full operator reference + examples
  qfg pull --dir ./config    # clone workspace, then edit JSON, commit, and qfg push

Log levels:
  qfg create log-level.my-app --type log_level --value WARN
  # Log-level keys must start with "${LOG_LEVEL_KEY_PREFIX}".
  # For per-logger targeting, create ONE log-level config per service and add
  # rules on the "quonfig-sdk-logging.key" context property (e.g.
  # PROP_STARTS_WITH_ONE_OF MyPackage.) rather than one config per logger.

To PROPOSE the new item instead of creating it (a change request: NOT LIVE
until someone with rights merges it), add --propose (or --cr <n> to add it to
your open request #n). A proposed create stores a plain value, so --secret,
--confidential and --env-var cannot be proposed this way yet.

When this flag has done its job, mark readyForCleanup: true in the UI and run \`qfg cleanup list\` to retire it.`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.new.flag --type boolean-flag',
    '<%= config.bin %> <%= command.id %> my.new.flag --type boolean-flag --value=true',
    '<%= config.bin %> <%= command.id %> my.new.string --type string --value="hello world"',
    '# Create a secret without the value ever appearing in argv (--secret implies --type string):',
    'pbpaste | <%= config.bin %> <%= command.id %> stripe.api-key --secret --value-stdin',
    '<%= config.bin %> <%= command.id %> stripe.api-key --secret --value-from-env STRIPE_API_KEY',
    '<%= config.bin %> <%= command.id %> stripe.api-key --secret --keyset QUONFIG_KEYSET_PROD --value-stdin < key.txt',
    '# A JSON secret is a string secret holding JSON (JSON.parse it in your app):',
    '<%= config.bin %> <%= command.id %> gcp.service-account --secret --value-stdin < sa.json',
    '<%= config.bin %> <%= command.id %> my.new.string --type string --env-var=MY_ENV_VAR_NAME',
    '<%= config.bin %> <%= command.id %> my.new.string --type json --value="{\\"key\\": \\"value\\"}"',
    '<%= config.bin %> <%= command.id %> my.timeout --type duration --value PT90S',
    '<%= config.bin %> <%= command.id %> log-level.my-app --type log_level --value WARN',
    '# After creating a flag, set a 20% rollout in production:',
    '<%= config.bin %> set-rollout my.new.flag --environment production --true-percent 20',
  ]

  static flags = {
    confidential: Flags.boolean({default: false, description: 'mark the value as confidential'}),
    'env-var': Flags.string({
      description:
        'store no value: the SDK reads it from this env var at RUNTIME. To read a value from a local env var NOW, use --value-from-env',
    }),
    type: Flags.string({
      description: 'kind of item to create (required, except with --secret, which implies string)',
      options: ['boolean-flag', 'boolean', 'string', 'double', 'int', 'string-list', 'json', 'duration', 'log_level'],
    }),
    value: Flags.string({
      description: 'default value for your new item (for secrets prefer --value-stdin / --value-from-env)',
      required: false,
    }),
    ...valueSourceFlags,
    ...secretFlags('encrypt the value of this item (string-only; the CLI never prints the plaintext)'),
    ...proposeFlags,
  }

  static writesHostedWorkspace = true

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(Create)

    // qfg-6na9.2: hard-enforce Policy A client-side before any network/prompt,
    // so a bad key fails fast here instead of a 4xx from the server (which
    // hard-enforces the same rule at create via PolicyAKeySchema, qfg-6na9.1).
    // Covers all three creation paths below (config / boolean-flag / log-level).
    const keyError = policyAKeyError(args.name)
    if (keyError) {
      return this.err(`Invalid key "${args.name}": ${keyError}`, {key: args.name, phase: 'validation'})
    }

    const secret = parsedSecretFlags(flags)

    // qfg-5bjew.37: --propose / --cr <n>. A proposed create goes through the
    // server's create planner (create_flag / create_config / set_log_level),
    // which stores a plain value: it cannot carry ciphertext, a confidential
    // marker or an env-var reference, so those are refused up front rather
    // than proposing a plaintext secret.
    const propose = parseProposeFlags(flags)
    if (!propose.ok) return this.err(propose.error, {key: args.name, phase: 'validation'})
    const proposeOptions = propose.options
    if (proposeOptions && (secret.selected || flags.confidential || flags['env-var'])) {
      return this.err(
        'qfg create --propose cannot carry --secret, --confidential or --env-var yet: a proposed create stores a plain value. Ask someone who can create items to create it, then propose the value with qfg set-default --propose.',
        {key: args.name, phase: 'validation'},
      )
    }

    // Plan Q4: --secret-key-name named an old-format key config; a qf1 secret
    // is encrypted to a keyset instead, so it is an error, not silently ignored.
    if (secret.selected && secret.keyNameGiven) {
      return this.err(SECRET_KEY_NAME_ERROR, {key: args.name, phase: 'validation'})
    }

    if (secret.keyset !== undefined && !secret.selected) {
      return this.err('--keyset applies only to secrets: add --secret', {key: args.name, phase: 'validation'})
    }

    // qfg-38lp: secrets are string-only, so --secret implies --type string.
    const type = flags.type ?? (secret.selected ? 'string' : undefined)
    if (type === undefined) {
      return this.err(
        'Missing required flag --type (e.g. --type string, --type boolean-flag). --secret implies --type string.',
        {key: args.name, phase: 'validation'},
      )
    }

    // Refuse --secret / --confidential on types that cannot carry them BEFORE
    // any value is parsed, so a coercion error can never echo the value.
    if (secret.selected && type !== 'string' && type !== 'log_level') {
      return this.err(
        `--secret flag only works with string type: secrets are string-only (got --type ${type}). ` +
          'To store JSON (or any structured value) as a secret, use --type string and JSON.parse it in your app.',
        {key: args.name, phase: 'validation'},
      )
    }

    if (flags.confidential && type === 'boolean-flag') {
      return this.err('--confidential is not supported for boolean-flag', {key: args.name, phase: 'validation'})
    }

    if (flags['env-var'] && flags.value && type !== 'log_level') {
      return this.err('cannot specify both --env-var and --value')
    }

    // qfg-38lp: --value / --value-stdin / --value-from-env all resolve here.
    // (log_level rejects --env-var itself, with a more specific message.)
    const valueSource = await resolveValueSource({
      ...flags,
      'env-var': type === 'log_level' ? undefined : flags['env-var'],
    })
    if (!valueSource.ok) {
      return this.err(valueSource.error ? valueSource.message : 'No value provided', {key: args.name, phase: 'input'})
    }

    const providedValue = valueSource.value
    // Plan Q3: --value still works with --secret, with a warning.
    if (secret.selected && flags.value !== undefined) notice(VALUE_ARGV_WARNING)

    if (type === 'boolean-flag') {
      return this.createBooleanFlag(args, providedValue, proposeOptions)
    }

    if (type === 'log_level') {
      return this.createLogLevel(args, {...flags, value: providedValue}, proposeOptions)
    }

    const key = args.name

    if (flags['env-var'] && secret.selected) {
      return this.err('cannot specify both --env-var and --secret')
    }

    if (flags.confidential && secret.selected) {
      console.warn("Note: --confidential is implied when using --secret, so you don't need to specify both.")
    }

    let configValue: ConfigValue = {}
    let valueType: ConfigValueType = TYPE_MAPPING[type]
    // Set whenever the value must not be printed (secret or confidential).
    let redacted: RedactedSummary | undefined

    if (flags['env-var']) {
      configValue = {
        provided: {
          lookup: flags['env-var'],
          source: ProvidedSource.EnvVar,
        },
      }
    } else {
      const valueInput = await getValue({
        desiredValue: providedValue,
        flags,
        mask: secret.selected || flags.confidential,
        message: secret.selected ? 'Secret value (input is masked)' : 'Default value',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        quonfig: undefined as any,
      })

      if (valueInput.ok) {
        const rawValue = valueInput.value
        let parsedConfigValue: ReturnType<typeof coerceIntoType>
        try {
          parsedConfigValue = coerceIntoType(type, rawValue)
        } catch (error) {
          // qfg-38lp: coercion errors quote the value; hide it when it is confidential.
          const message = error instanceof Error ? error.message : String(error)
          if (!flags.confidential && !secret.selected) throw error
          return this.err(message.split(rawValue).join(redactedDisplay(redactedSummary({plaintext: rawValue}))), {
            key,
            phase: 'coercion',
          })
        }

        if (!parsedConfigValue) {
          return this.err(`Failed to coerce value into type: ${type}`, {key, phase: 'coercion'})
        }

        configValue = parsedConfigValue[0]
        valueType = parsedConfigValue[1]

        // A secret is a qf1 document in secrets/, written through the
        // workspace push route; never configs/create, never decryptWith.
        if (secret.selected) return this.createSecret(key, rawValue, {...flags, keyset: secret.keyset})

        if (flags.confidential) {
          redacted = redactedSummary({plaintext: rawValue})
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

    if (proposeOptions) {
      return submitProposal(this, {
        changes: [
          {
            op: 'create_config',
            key,
            valueType: mapValueTypeToString(valueType),
            value: mapConfigValueToDto(configValue, valueType).value,
          },
        ],
        key,
        options: proposeOptions,
      })
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
      // qfg-5bjew.37 (rule 2.11): a refused create can be proposed instead.
      if (request.status === 403) {
        const message = `Failed to create config: 403${request.serverMessage ? `: ${request.serverMessage}` : ''}`
        // create --propose refuses --secret, --confidential and --env-var, so
        // such a create gets no --propose suggestion that would only fail.
        if (secret.selected || flags.confidential || flags['env-var']) {
          return this.err(message, {key, phase: 'creation', serverError: request.error})
        }

        return failWithProposeHint(this, message, {key, phase: 'creation', serverError: request.error})
      }

      const errMsg =
        request.status === 409
          ? `Failed to create config: ${key} already exists`
          : `Failed to create config: ${request.status} | ${JSON.stringify(request.error)}`

      return this.err(errMsg, {key, phase: 'creation', serverError: request.error})
    }

    const response = request.json

    const confidentialMaybe = flags.confidential ? '(confidential) ' : ''

    await this.syncConfigToDisk('configs', key, response)

    if (redacted) {
      // qfg-38lp: never echo the plaintext — not on the success line, not in
      // --json (the server response carries confidential values verbatim).
      return this.ok(
        `${checkmark} Created ${confidentialMaybe}config: ${key} ${redactedDisplay(redacted)}${this.targetSuffix()}`,
        {
          key,
          ...scrubConfidentialValues(response),
          value: redacted,
        },
      )
    }

    return this.ok(`${checkmark} Created ${confidentialMaybe}config: ${key}${this.targetSuffix()}`, {key, ...response})
  }

  private async createBooleanFlag(
    args: {name: string},
    rawDefault: string | undefined,
    proposeOptions?: ProposeOptions,
  ): Promise<JsonObj | void> {
    const key = args.name

    const defaultValue = coerceBool(rawDefault ?? 'false')

    if (proposeOptions) {
      // A proposed bool flag is created off (the public create's rule); "on"
      // is a second entry in the same request.
      return submitProposal(this, {
        changes: [
          {op: 'create_flag', key, type: 'bool'},
          ...(defaultValue ? [{op: 'set_flag', key, environment: 'default', enabled: true}] : []),
        ],
        key,
        options: proposeOptions,
      })
    }

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
      if (request.status === 403) {
        return failWithProposeHint(
          this,
          `Failed to create boolean flag: 403${request.serverMessage ? `: ${request.serverMessage}` : ''}`,
          {key, phase: 'creation', serverError: request.error},
        )
      }

      const errMsg =
        request.status === 409
          ? `Failed to create boolean flag: ${key} already exists`
          : `Failed to create boolean flag: ${request.status} | ${JSON.stringify(request.error)}`

      return this.err(errMsg, {key, phase: 'creation', serverError: request.error})
    }

    const response = request.json

    await this.syncConfigToDisk('feature-flags', key, response)

    return this.ok(`${checkmark} Created boolean flag: ${key}${this.targetSuffix()}`, {key, ...response})
  }

  private async createLogLevel(
    args: {name: string},
    flags: {
      confidential: boolean
      'env-var'?: string
      interactive?: boolean
      secret: boolean
      keyset?: string
      'secret-key-name'?: string
      value?: string
      'value-from-env'?: string
      'value-stdin'?: boolean
    },
    proposeOptions?: ProposeOptions,
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

    if (proposeOptions) {
      // set_log_level is an upsert, so refuse an existing key here the way
      // the live create does.
      const existing = await this.apiClient.post('/api/v1/metadata/getByKey', {workspaceId: this.workspaceId, key})
      if (existing.ok) {
        return this.err(`Failed to create log level: ${key} already exists`, {key, phase: 'creation'})
      }

      if (existing.status !== 404) {
        return this.err(`Failed to check whether ${key} exists: ${existing.status}`, {
          key,
          serverError: existing.error,
        })
      }

      return submitProposal(this, {
        changes: [{op: 'set_log_level', key, level: rawValue}],
        key,
        options: proposeOptions,
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
      if (createRequest.status === 403) {
        return failWithProposeHint(
          this,
          `Failed to create log level: 403${createRequest.serverMessage ? `: ${createRequest.serverMessage}` : ''}`,
          {key, phase: 'creation', serverError: createRequest.error},
        )
      }

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

    return this.ok(`${checkmark} Created log level: ${key} (default: ${rawValue})${this.targetSuffix()}`, {
      key,
      value: rawValue,
    })
  }

  /**
   * `qfg create <key> --secret` (plan 3.1): a new `secrets/<key>.json`, the
   * value encrypted to the chosen keyset's first public key, at the
   * workspace's default access tier, in one commit locked to a fresh
   * snapshot. Nothing about the plaintext but the redacted summary is shown.
   */
  private async createSecret(
    key: string,
    plaintext: string,
    flags: {interactive?: boolean; keyset?: string; profile?: string; workspace?: string},
  ): Promise<JsonObj | void> {
    const fail = (message: string) => this.err(`Failed to create secret: ${message}`, {key, phase: 'creation'})
    let outcome: {error: string} | {json: JsonObj; notices: string[]; line: string}
    let access: string
    try {
      access = await defaultCreateAccess(this)
    } catch (error) {
      return fail(secretFailure(error))
    }

    let target: Awaited<ReturnType<typeof openCommandSnapshot>>
    try {
      target = await openCommandSnapshot(this, flags.workspace ?? flags.profile)
    } catch (error) {
      const why =
        error instanceof SecretCommandError
          ? error.message
          : redactToken(error instanceof Error ? error.message : String(error))
      return fail(`could not read the workspace to write the secret: ${why}`)
    }

    try {
      const plan = await planSecretCreate({
        access,
        env: process.env,
        flagKeyset: flags.keyset,
        interactive: isInteractive(flags),
        key,
        plaintext,
        prompt: (options) => getKeyset(options),
        snapshot: target.snapshot,
      })
      const commitSha = await pushPlan(plan, target)
      await this.syncConfigToDisk('secrets', key, JSON.parse((plan.files[0] as {afterJson: string}).afterJson))
      const label = this.workspaceLabel ?? 'this workspace'
      const notices = [
        plan.firstSecret ? firstSecretNotice(label) : '',
        readabilityNote(plan.choice, process.env) ?? '',
      ]
      outcome = {
        json: {
          commitSha,
          ...(plan.firstSecret ? {firstSecretInWorkspace: true} : {}),
          key,
          keysetSource: plan.choice.source,
          path: plan.path,
          scope: 'default',
          value: jsonValue(plan),
        },
        line: `${checkmark} Created secret: ${key} on ${plan.choice.keyset} (key ${plan.choice.fingerprint}) ${redactedDisplay(plan.redacted)}${this.targetSuffix()}`,
        notices: notices.filter(Boolean),
      }
    } catch (error) {
      outcome = {error: secretFailure(error)}
    } finally {
      await target.snapshot.cleanup()
    }

    if ('error' in outcome) return fail(outcome.error)
    this.log(outcome.line)
    for (const text of outcome.notices) notice(text)
    return outcome.json
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

  /** ` in <org>/<ws>` so a success line always says which hosted workspace changed. */
  private targetSuffix(): string {
    return this.workspaceLabel ? ` in ${this.workspaceLabel}` : ''
  }
}

/** The text for a known secret-write failure; anything else is rethrown. */
function secretFailure(error: unknown): string {
  const known = knownSecretFailure(error)
  if (known === undefined) throw error
  return known
}
