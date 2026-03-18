import {Quonfig} from '@quonfig/node'

import type {ConfigValue} from './quonfig-common/src/types.js'

import {CommandLike} from './ui/get-key.js'

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

  const options: ConstructorParameters<typeof Quonfig>[0] = {
    sdkKey,
    collectEvaluationSummaries: false,
    collectLoggerCounts: false,
    contextUploadMode: 'none',
    datafile,
    enableSSE: false,
  }

  options.sources = process.env.QUONFIG_API_URL ? [process.env.QUONFIG_API_URL] : ['https://api.prefab.cloud']

  quonfig = new Quonfig(options)

  await quonfig.init()

  return quonfig
}

const getUserId = (): string =>
  quonfig.defaultContext()?.get(DEFAULT_CONTEXT_USER_ID_NAMESPACE)?.get(DEFAULT_CONTEXT_USER_ID) as string

const getRowInEnvironment = ({desiredEnvId, key}: {desiredEnvId: string; key: string}) => {
  const envId = desiredEnvId

  const config = quonfig.raw(key)

  if (!config) {
    return
  }

  return config.rows.find((row) => row.projectEnvId?.toString() === envId)
}

export const overrideFor = ({
  currentEnvironmentId,
  key,
}: {
  currentEnvironmentId: string
  key: string
}): ConfigValue | undefined => {
  const userId = getUserId()

  const row = getRowInEnvironment({desiredEnvId: currentEnvironmentId, key})

  if (row) {
    for (const value of row.values) {
      for (const criterion of value.criteria) {
        if (
          criterion.propertyName === `${DEFAULT_CONTEXT_USER_ID_NAMESPACE}.${DEFAULT_CONTEXT_USER_ID}` &&
          criterion.valueToMatch?.stringList?.values.includes(userId)
        ) {
          return value.value
        }
      }
    }
  }

  return undefined
}

export const defaultValueFor = (envId: string, key: string): ConfigValue | undefined => {
  const row = getRowInEnvironment({desiredEnvId: envId, key})

  return row?.values.at(-1)?.value
}
