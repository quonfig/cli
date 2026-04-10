import {Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {JsonObj} from '../result.js'
import getConfirmation from '../ui/get-confirmation.js'
import getEnvironment from '../ui/get-environment.js'
import {checkmark} from '../util/color.js'
import isInteractive from '../util/is-interactive.js'
import nameArg from '../util/name-arg.js'

const WEIGHT_TOTAL = 100_000

export default class SetRollout extends APICommand {
  static args = {...nameArg}

  static description = `Configure a percentage rollout (gradual rollout / A/B test / canary deploy) for a flag.

The flag must already exist. Create it first if needed:
  qfg create my.flag --type boolean-flag

Weights are specified as whole-number percentages (0–100). They must sum to 100.

For a boolean flag, use --true-percent to set the percentage of users that receive
true (the remainder automatically receive false):
  qfg set-rollout my.flag --environment production --true-percent 20
  → 20% of users get true, 80% get false

For multi-value flags or custom splits, use --weights with a comma-separated list:
  qfg set-rollout my.flag --environment production --weights "red:33,green:33,blue:34"

Hashing: users are bucketed by the value of hashByPropertyName (default: "user.key").
Use --hash-by to change which property drives the bucket assignment:
  qfg set-rollout my.flag --environment production --true-percent 10 --hash-by user.id

For scripted / agent use, add --confirm to skip the interactive confirmation prompt.

To combine a rollout with segment targeting (e.g. beta ON, holdout OFF, everyone else 50/50),
you need to edit the JSON config file directly:
  qfg config-schema           # operator reference + worked multi-rule example
  qfg pull --dir ./config     # clone workspace to edit

To revert to a single value for everyone, use:
  qfg set-default my.flag --environment production --value false

To inspect the current rollout:
  qfg info my.flag`

  static examples = [
    '<%= config.bin %> <%= command.id %> my.feature.flag --environment production --true-percent 20',
    '<%= config.bin %> <%= command.id %> my.feature.flag --environment staging --true-percent 50',
    '<%= config.bin %> <%= command.id %> my.feature.flag --environment production --true-percent 100  # full rollout',
    '<%= config.bin %> <%= command.id %> my.feature.flag --environment production --true-percent 0    # kill switch (all false)',
    '<%= config.bin %> <%= command.id %> my.variant.flag --environment production --weights "control:50,treatment:50"',
    '<%= config.bin %> <%= command.id %> my.variant.flag --environment production --weights "a:33,b:33,c:34" --hash-by user.id',
  ]

  static flags = {
    environment: Flags.string({description: 'environment to update (e.g. production, staging)'}),
    'hash-by': Flags.string({
      default: 'user.key',
      description: 'user property used to assign buckets (default: user.key)',
    }),
    'true-percent': Flags.integer({
      description: 'percentage of users that receive true (0–100). Remaining users receive false. Boolean flags only.',
      max: 100,
      min: 0,
    }),
    weights: Flags.string({
      description:
        'comma-separated "value:percent" pairs that must sum to 100 (e.g. "true:20,false:80" or "red:33,green:33,blue:34")',
    }),
    confirm: Flags.boolean({description: 'skip the interactive confirmation prompt (useful for scripts and agents)'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(SetRollout)

    // Validate flag exclusivity
    if (flags['true-percent'] !== undefined && flags.weights) {
      return this.err('Use either --true-percent or --weights, not both.')
    }

    if (flags['true-percent'] === undefined && !flags.weights) {
      return this.err('Either --true-percent or --weights is required.')
    }

    // Validate required args for non-interactive mode
    if (!args.name && !isInteractive(flags)) {
      return this.err("'name' argument is required when interactive mode isn't available.")
    }

    if (!flags.environment && !isInteractive(flags)) {
      return this.err("'environment' is required when interactive mode isn't available.")
    }

    // Fetch config metadata to validate the key exists
    const metadataRequest = await this.apiClient.post('/api/v1/metadata/list', {workspaceId: this.workspaceId})

    if (!metadataRequest.ok) {
      const errorMsg = metadataRequest.error?.error || `Failed to fetch configs: ${metadataRequest.status}`
      return this.err(errorMsg, {serverError: metadataRequest.error})
    }

    interface ConfigMetadata {
      key: string
      type: string
      valueType: string
      version: string
    }

    interface ConfigMetadataResponse {
      configs: ConfigMetadata[]
    }

    const metadataResponse = metadataRequest.json as unknown as ConfigMetadataResponse
    const configs = metadataResponse.configs

    let key = args.name

    if (!key && isInteractive(flags)) {
      const {default: autocomplete} = await import('../util/autocomplete.js')
      const selected = await autocomplete({
        message: 'Which flag would you like to configure a rollout for?',
        source: configs.map((c) => c.key),
      })
      if (selected) key = selected
    }

    if (!key) {
      return this.err("'name' argument is required when interactive mode isn't available.")
    }

    const config = configs.find((c) => c.key === key)
    if (!config) {
      return this.err(`Could not find config named ${key}`)
    }

    // Get environment
    const environment = await getEnvironment({
      command: this,
      flags,
      message: 'Which environment would you like to configure the rollout for?',
      providedEnvironment: flags.environment,
    })

    if (!environment) return

    // Build weighted values
    let weightedValues: Array<{value: {type: string; value: unknown}; weight: number}>

    if (flags['true-percent'] !== undefined) {
      const truePercent = flags['true-percent']
      const falsePercent = 100 - truePercent
      weightedValues = [
        {value: {type: 'bool', value: true}, weight: truePercent * (WEIGHT_TOTAL / 100)},
        {value: {type: 'bool', value: false}, weight: falsePercent * (WEIGHT_TOTAL / 100)},
      ]
    } else {
      // Parse --weights "value1:N,value2:M,..."
      const parsed = this.parseWeights(flags.weights!, config.valueType)
      if (!parsed.ok) {
        return this.err(parsed.error)
      }

      weightedValues = parsed.weights
    }

    const totalWeight = weightedValues.reduce((sum, wv) => sum + wv.weight, 0)
    if (totalWeight !== WEIGHT_TOTAL) {
      return this.err(`Weights must sum to 100. Got: ${weightedValues.map((wv) => `${wv.weight / 1000}%`).join(' + ')} = ${totalWeight / 1000}%`)
    }

    const rolloutValue = {
      type: 'weighted_values',
      value: {
        hashByPropertyName: flags['hash-by'],
        weightedValues,
      },
    }

    const rolloutDescription = weightedValues
      .map((wv) => `${wv.weight / 1000}% → ${JSON.stringify(wv.value.value)}`)
      .join(', ')

    const message = `Confirm: set rollout for ${key} in ${environment.name} to [${rolloutDescription}]? yes/no`

    if (!(await getConfirmation({flags, message}))) {
      return
    }

    // Fetch the current full config to get commitSha and existing environments
    const detailRequest = await this.apiClient.post('/api/v1/metadata/getByKey', {
      workspaceId: this.workspaceId,
      key,
    })

    if (!detailRequest.ok) {
      return this.err(`Failed to fetch config details: ${detailRequest.status}`)
    }

    const currentConfig = detailRequest.json as {
      commitSha: string
      environments: Array<{id: string; rules: unknown[]}>
      default: {rules: unknown[]}
    }

    const newRule = {criteria: [], value: rolloutValue}
    const envKey = environment.name
    const existingEnvs = currentConfig.environments ?? []
    const hasEnv = existingEnvs.some((e) => e.id === envKey)
    const updatedEnvironments = hasEnv
      ? existingEnvs.map((e) => (e.id === envKey ? {...e, rules: [newRule]} : e))
      : [...existingEnvs, {id: envKey, rules: [newRule]}]

    const updateFields = {environments: updatedEnvironments}

    this.verboseLog('Update fields:', JSON.stringify(updateFields, null, 2))

    let request: Awaited<ReturnType<typeof this.apiClient.post>>

    if (config.type === 'feature_flag') {
      request = await this.apiClient.post('/api/v1/flags/update', {
        expectedCommitSha: currentConfig.commitSha,
        flag: updateFields,
        flagKey: key,
        workspaceId: this.workspaceId,
      })
    } else {
      request = await this.apiClient.post('/api/v1/configs/update', {
        config: updateFields,
        configKey: key,
        expectedCommitSha: currentConfig.commitSha,
        workspaceId: this.workspaceId,
      })
    }

    if (request.ok) {
      this.log(`${checkmark} Rollout set: ${key} in ${environment.name} → [${rolloutDescription}]`)
      return {
        environment: {id: environment.id, name: environment.name},
        hashByPropertyName: flags['hash-by'],
        key,
        rollout: rolloutDescription,
        success: true,
        weightedValues,
      }
    }

    this.verboseLog(request.error)

    return this.err(
      `Failed to set rollout: ${request.status} | ${JSON.stringify(request.error)}`,
      {key, serverError: request.error},
    )
  }

  private parseWeights(
    weightsStr: string,
    valueType: string,
  ): {ok: true; weights: Array<{value: {type: string; value: unknown}; weight: number}>} | {ok: false; error: string} {
    const pairs = weightsStr.split(',').map((s) => s.trim())
    const weights: Array<{value: {type: string; value: unknown}; weight: number}> = []
    let totalPercent = 0

    for (const pair of pairs) {
      const colonIdx = pair.lastIndexOf(':')
      if (colonIdx === -1) {
        return {
          error: `Invalid weight entry "${pair}". Expected format "value:percent" (e.g. "true:20").`,
          ok: false,
        }
      }

      const rawValue = pair.slice(0, colonIdx).trim()
      const percentStr = pair.slice(colonIdx + 1).trim()
      const percent = Number(percentStr)

      if (Number.isNaN(percent) || percent < 0 || percent > 100) {
        return {error: `Invalid percent "${percentStr}" in "${pair}". Must be 0–100.`, ok: false}
      }

      const typedValue = this.coerceValue(rawValue, valueType)
      if (!typedValue.ok) {
        return {error: typedValue.error, ok: false}
      }

      weights.push({value: typedValue.typed, weight: percent * (WEIGHT_TOTAL / 100)})
      totalPercent += percent
    }

    if (Math.round(totalPercent) !== 100) {
      return {error: `Weights must sum to 100. Got: ${totalPercent}%.`, ok: false}
    }

    return {ok: true, weights}
  }

  private coerceValue(
    raw: string,
    valueType: string,
  ): {ok: true; typed: {type: string; value: unknown}} | {ok: false; error: string} {
    const type = valueType.toLowerCase()

    switch (type) {
      case 'bool': {
        if (raw !== 'true' && raw !== 'false') {
          return {error: `Invalid boolean value "${raw}". Must be "true" or "false".`, ok: false}
        }

        return {ok: true, typed: {type: 'bool', value: raw === 'true'}}
      }

      case 'int': {
        const n = Number.parseInt(raw, 10)
        if (Number.isNaN(n)) {
          return {error: `Invalid int value "${raw}".`, ok: false}
        }

        return {ok: true, typed: {type: 'int', value: n}}
      }

      case 'double': {
        const n = Number.parseFloat(raw)
        if (Number.isNaN(n)) {
          return {error: `Invalid double value "${raw}".`, ok: false}
        }

        return {ok: true, typed: {type: 'double', value: n}}
      }

      default: {
        // string, json, etc — pass as-is
        return {ok: true, typed: {type, value: raw}}
      }
    }
  }
}
