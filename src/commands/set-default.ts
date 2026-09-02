import {Flags} from '@oclif/core'
import {ProvidedSource, ConfigValueType} from '@quonfig/node'

import {APICommand} from '../index.js'
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
import {
  Rule,
  ScopedDocument,
  catchAllRule,
  countTargetingRules,
  keptTargetingNote,
  replacedTargetingNote,
  seedScopeRules,
  seededFromDefaultNote,
  upsertEnvRules,
  upsertFallbackRule,
} from '../util/rules.js'
import secretFlags, {Secret, parsedSecretFlags} from '../util/secret-flags.js'

type ValueOrEnvVar = {envVar: string; value?: never} | {envVar?: never; value: string}
type StoredDocument = {commitSha: string} & ScopedDocument

export default class SetDefault extends APICommand {
  static aliases = ['toggle']

  static args = {...nameArg}

  static description = `Set the fallback value for a flag or config in one environment.

The fallback is the unconditional rule at the end of the environment's rule
list: what users receive when no targeting rule matches. Targeting rules and
percentage rollouts above it are kept, and the command tells you how many.
If the environment has no rules of its own yet, they are copied from the
flag's default rules first, so inherited targeting is kept too.

To turn a flag on or off for EVERYONE, including users matched by targeting
rules, add --replace-targeting. This deletes the environment's targeting
rules (they stay in git history).

To set a percentage rollout (gradual rollout / A/B test / canary deploy) instead:
  qfg set-rollout my.flag --environment production --true-percent 20

To see all current values and rules for a flag:
  qfg info my.flag`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.flag.name                                          # prompts for value and env',
    '<%= config.bin %> <%= command.id %> my.flag.name --value=true --environment=staging',
    '<%= config.bin %> <%= command.id %> my.flag.name --value=false --environment=production --replace-targeting   # kill-switch: off for everyone',
    '<%= config.bin %> <%= command.id %> my.flag.name --value=true --secret',
    '<%= config.bin %> <%= command.id %> my.config.name --env-var=MY_ENV_VAR_NAME --environment=production',
    '# For a percentage rollout, use set-rollout instead:',
    '<%= config.bin %> set-rollout my.flag.name --environment production --true-percent 20',
    '# For per-user / per-property targeting (e.g. user.email == X), edit JSON directly:',
    '<%= config.bin %> pull && <%= config.bin %> config-schema',
  ]

  static flags = {
    confidential: Flags.boolean({default: false, description: 'mark the value as confidential'}),
    'env-var': Flags.string({description: 'environment variable to use as default value'}),
    environment: Flags.string({description: 'environment to change'}),
    'replace-targeting': Flags.boolean({
      default: false,
      description:
        "set the value for EVERYONE: delete this environment's targeting rules instead of keeping them (they stay in git history)",
    }),
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
      id: string
      key: string
      name: string
      type: string
      valueType: string
      version: string
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

    // Fetch the stored document ONCE. It drives encryption auto-detection,
    // the targeting-rule count in the confirmation prompt, the rules the write
    // is applied to, and the commitSha for optimistic concurrency.
    const detailRequest = await this.apiClient.post('/api/v1/metadata/getByKey', {
      workspaceId: this.workspaceId,
      key,
    })

    if (!detailRequest.ok) {
      return this.err(`Failed to fetch config details: ${detailRequest.status}`)
    }

    const currentConfig = detailRequest.json as unknown as StoredDocument
    this.verboseLog('Config details:', currentConfig)

    // Check if existing config has encrypted values
    if (!secret.selected && currentConfig.default?.rules) {
      for (const rule of currentConfig.default.rules) {
        if ((rule.value as {decryptWith?: string} | undefined)?.decryptWith) {
          this.verboseLog('Auto-detected encryption from existing config')
          secret = {
            keyName: secret.keyName,
            selected: true,
          }
          break
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

    // The scope this write targets: one environment's rule list, or the
    // document's `default` block when the user picked [Default].
    // environment.name is the slug stored in git files (e.g. "production");
    // environment.id is the DB UUID and is never written to git files.
    const envName = environment.id === '' ? undefined : environment.name
    const replaceTargeting = flags['replace-targeting']
    const scope = seedScopeRules(currentConfig, envName)

    // A --replace-targeting write does NOT seed from default: there is nothing
    // in that environment to replace, and the default rules it inherits are
    // not being deleted, so reporting them as "replaced" would be a lie.
    const targetingRuleCount = replaceTargeting && scope.seeded ? 0 : countTargetingRules(scope.rules)

    const keptPhrase =
      targetingRuleCount > 0 ? ` (${targetingRuleCount} targeting rule${targetingRuleCount === 1 ? '' : 's'} kept)` : ''
    const deletePhrase = targetingRuleCount > 0 ? `, deleting ${targetingRuleCount} targeting rule(s)` : ''
    const confirmMessage = (valuePhrase: string): string =>
      replaceTargeting
        ? `Confirm: set ${key} in ${environment.name} to ${valuePhrase} for EVERYONE${deletePhrase}? yes/no`
        : `Confirm: set the fallback for ${key} in ${environment.name} to ${valuePhrase}?${keptPhrase} yes/no`

    const {confidential} = flags

    // Get the value
    if (flags['env-var']) {
      if (!(await getConfirmation({flags, message: confirmMessage(`be provided by \`${flags['env-var']}\``)}))) {
        return
      }

      return this.submitChange({
        confidential,
        config,
        currentConfig,
        envName,
        envVar: flags['env-var'],
        environment,
        key,
        replaceTargeting,
        scope,
        secret,
        targetingRuleCount,
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

    if (!(await getConfirmation({flags, message: confirmMessage(`\`${value}\`${secretMaybe}`)}))) {
      return
    }

    return this.submitChange({
      confidential,
      config,
      currentConfig,
      envName,
      environment,
      key,
      replaceTargeting,
      scope,
      secret,
      targetingRuleCount,
      value,
    })
  }

  private async submitChange({
    confidential,
    config,
    currentConfig,
    envName,
    envVar,
    environment,
    key,
    replaceTargeting,
    scope,
    secret,
    targetingRuleCount,
    value,
  }: {
    confidential: boolean
    config: {type: string; valueType: string; version: string}
    currentConfig: StoredDocument
    envName: string | undefined
    environment: {id: string; name: string}
    key: string
    replaceTargeting: boolean
    scope: {rules: Rule[]; seeded: boolean}
    secret: Secret
    targetingRuleCount: number
  } & ValueOrEnvVar) {
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

    const type = typeMapping[config.valueType.toLowerCase()] || config.valueType

    let configValue: Record<string, unknown>
    // How the new value is named in the prompt and the report — `\`true\``, or
    // "be provided by `MY_ENV_VAR`" — plus any (encrypted)/(confidential) note.
    let valuePhrase: string
    let modifiers = ''

    if (envVar === undefined) {
      valuePhrase = `\`${value}\``

      if (secret.selected) {
        // Handle encrypted values using shared utility
        const encryptedValueResult = await makeConfidentialValue(this, value, secret, environment.name)
        if (!encryptedValueResult.ok) {
          return this.err(encryptedValueResult.message || 'Failed to encrypt value')
        }

        configValue = mapConfigValueToDto(encryptedValueResult.value, ConfigValueType.String)
        modifiers += ' (encrypted)'
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
      // ValueSchema discriminates on `type`; provided values are
      // {type: 'provided', value: {source, lookup}}. See qfg-84df.
      configValue = mapConfigValueToDto(
        {provided: {lookup: envVar, source: ProvidedSource.EnvVar}},
        ConfigValueType.String,
      )
      valuePhrase = `be provided by \`${envVar}\``
    }

    if (confidential && !secret.selected) {
      configValue.confidential = true
      modifiers += ' (confidential)'
    }

    // Surgical by default (qfg-qjdm): the fallback rule's value is replaced
    // in place and every targeting rule around it is kept. --replace-targeting
    // is the explicit opt-in to collapsing the scope to a single unconditional
    // rule — the behavior this command used to have without saying so.
    const newRules = replaceTargeting ? [catchAllRule(configValue)] : upsertFallbackRule(scope.rules, configValue)

    // For [Default] (envName undefined), update default.rules.
    // For a specific environment, upsert the environments array.
    const updateFields: Record<string, unknown> = envName
      ? {environments: upsertEnvRules(currentConfig.environments ?? [], envName, newRules)}
      : {default: {rules: newRules}}

    this.verboseLog('Update fields:', JSON.stringify(updateFields, null, 2))

    // Route to the correct update endpoint based on config type.
    let request: Awaited<ReturnType<typeof this.apiClient.post>>

    if (config.type === 'feature_flag') {
      request = await this.apiClient.post('/api/v1/flags/update', {
        workspaceId: this.workspaceId,
        flagKey: key,
        flag: updateFields,
        expectedCommitSha: currentConfig.commitSha,
      })
    } else if (config.type === 'log_level') {
      request = await this.apiClient.post('/api/v1/logLevels/update', {
        workspaceId: this.workspaceId,
        logLevelKey: key,
        logLevel: updateFields,
        expectedCommitSha: currentConfig.commitSha,
      })
    } else {
      request = await this.apiClient.post('/api/v1/configs/update', {
        workspaceId: this.workspaceId,
        configKey: key,
        config: updateFields,
        expectedCommitSha: currentConfig.commitSha,
      })
    }

    if (request.ok) {
      // Always say what happened to the targeting rules — the whole point of
      // qfg-97z9 was that this command changed them silently.
      const scopeLabel = envName ?? 'the default'
      const sentences = replaceTargeting
        ? [
            `Set ${scopeLabel} to ${valuePhrase}${modifiers} for everyone.`,
            replacedTargetingNote(targetingRuleCount, currentConfig.commitSha),
          ]
        : [
            `Set ${scopeLabel} fallback to ${valuePhrase}${modifiers}.`,
            scope.seeded && envName ? seededFromDefaultNote(envName) : '',
            keptTargetingNote(targetingRuleCount),
          ]

      this.log(`${checkmark} ${sentences.filter(Boolean).join(' ')}`)

      const counts: JsonObj = replaceTargeting
        ? {
            previousCommitSha: currentConfig.commitSha,
            ...(targetingRuleCount > 0 ? {replacedTargetingRuleCount: targetingRuleCount} : {}),
          }
        : targetingRuleCount > 0
          ? {keptTargetingRuleCount: targetingRuleCount}
          : {}

      return {
        environment: {
          id: environment.id,
          name: environment.name,
        },
        key,
        success: true,
        value,
        ...counts,
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
