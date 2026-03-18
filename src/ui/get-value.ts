import {Quonfig} from '@quonfig/node'

import type {Environment} from '../quonfig-common/src/api/getEnvironmentsFromApi.js'
import type {Config, ConfigValue} from '../quonfig-common/src/types.js'

import {defaultValueFor} from '../quonfig.js'
import {valueOfToString} from '../quonfig-common/src/valueOf.js'
import {Result, failure, noop, success} from '../result.js'
import autocomplete from '../util/autocomplete.js'
import validateValue from '../validations/value.js'
import getString from './get-string.js'

const getValue = async ({
  allowBlank = true,
  desiredValue,
  environment,
  flags,
  key,
  message,
  quonfig,
}: {
  allowBlank?: boolean
  desiredValue: string | undefined
  environment?: Environment
  flags: {interactive: boolean}
  key?: string
  message: string
  quonfig: Quonfig
}): Promise<Result<string>> => {
  if (desiredValue === undefined && !flags.interactive) {
    return failure(`No value provided for ${key}`)
  }

  if (!key) {
    const value = desiredValue ?? (await promptForValue({allowBlank, message}))

    if (value === undefined || value === null) {
      return noop()
    }

    return success(value)
  }

  const currentDefault = environment ? defaultValueFor(environment.id, key) : undefined

  const config = quonfig.raw(key)

  if (!config) {
    return failure(`Could not find config named ${key}`)
  }

  const selectedValue = desiredValue ?? (await promptForValue({allowBlank, config, currentDefault, message}))

  if (selectedValue === undefined || selectedValue === null) {
    return noop()
  }

  if (selectedValue === currentDefault?.toString()) {
    return noop(`The default is already \`${selectedValue}\``)
  }

  return validateValue(quonfig, key, selectedValue)
}

const promptForValue = async ({
  allowBlank,
  config,
  currentDefault,
  message,
}: {
  allowBlank: boolean
  config?: Config
  currentDefault?: ConfigValue | undefined
  message: string
}) => {
  const choices = (config?.allowableValues ?? []).map((v) => valueOfToString(v))

  if (choices === undefined || choices.length === 0) {
    return getString({allowBlank, message})
  }

  const autoCompleteMessage =
    currentDefault === undefined
      ? `Choose your new default.`
      : `The current default is \`${valueOfToString(currentDefault)}\`. Choose your new default.`

  return autocomplete({
    message: autoCompleteMessage,
    source: choices.filter((v) => v.toString() !== currentDefault?.toString()),
  })
}

export default getValue
