import {Quonfig} from '@quonfig/node'
import type {ConfigResponse, Value, Rule} from '@quonfig/node'

import {CommandLike} from './ui/get-key.js'
import {getDeliveryUrl} from './util/domain-urls.js'

type Flags = {
  ['sdk-key']?: string
}

type FlagsOrDatafile = Flags | string

let quonfig: Quonfig

const DEFAULT_CONTEXT_USER_ID_NAMESPACE = 'prefab-api-key'
const DEFAULT_CONTEXT_USER_ID = 'user-id'

export const initQuonfig = async (_ctx: CommandLike, flagsOrDatafile: FlagsOrDatafile) => {
  let sdkKey = 'NO_API_KEY'
  let datafile

  if (typeof flagsOrDatafile === 'string') {
    datafile = flagsOrDatafile
  } else {
    if (!flagsOrDatafile['sdk-key']) {
      throw new Error(`SDK key is required`)
    }

    sdkKey = flagsOrDatafile['sdk-key']
  }

  const apiUrl = getDeliveryUrl()

  quonfig = new Quonfig({
    sdkKey,
    collectEvaluationSummaries: false,
    collectLoggerCounts: false,
    contextUploadMode: 'none',
    datafile,
    enableSSE: false,
    apiUrl,
  })

  await quonfig.init()

  return quonfig
}

export const getQuonfig = () => quonfig

/**
 * Get the raw ConfigResponse for a key (new quonfig JSON format).
 * The new format uses `default.rules` and `environment.rules` instead of `rows`.
 */
const getRawConfig = (key: string): ConfigResponse | undefined => quonfig.rawConfig?.(key)

/**
 * Find rules in an environment that target a specific user via criteria.
 */
const getEnvironmentRules = (config: ConfigResponse): Rule[] | undefined => config.environment?.rules

export const overrideFor = ({
  currentEnvironmentId: _currentEnvironmentId,
  key,
}: {
  currentEnvironmentId: string
  key: string
}): Value | undefined => {
  const config = getRawConfig(key)

  if (!config) return undefined

  // In the new format, environment-specific rules are in config.environment.rules
  const rules = getEnvironmentRules(config)
  if (!rules) return undefined

  for (const rule of rules) {
    for (const criterion of rule.criteria) {
      if (criterion.propertyName === `${DEFAULT_CONTEXT_USER_ID_NAMESPACE}.${DEFAULT_CONTEXT_USER_ID}`) {
        return rule.value
      }
    }
  }

  return undefined
}

export const defaultValueFor = (_envId: string, key: string): Value | undefined => {
  const config = getRawConfig(key)

  if (!config) return undefined

  // In the new format, the default value is the last rule in environment rules, or default rules
  const envRules = config.environment?.rules
  if (envRules && envRules.length > 0) {
    return envRules.at(-1)?.value
  }

  const defaultRules = config.default?.rules
  if (defaultRules && defaultRules.length > 0) {
    return defaultRules.at(-1)?.value
  }

  return undefined
}
