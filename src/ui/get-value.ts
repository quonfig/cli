import {Quonfig} from '@quonfig/node'
import type {Value, ConfigResponse} from '@quonfig/node'

import {defaultValueFor} from '../quonfig.js'
import {Result, failure, noop, success} from '../result.js'
import autocomplete from '../util/autocomplete.js'
import validateValue from '../validations/value.js'
import getString from './get-string.js'

// Simplified Environment type for CLI use
interface Environment {
  id: string
  name: string
}

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

  const config = quonfig.rawConfig(key)

  if (!config) {
    return failure(`Could not find config named ${key}`)
  }

  const selectedValue = desiredValue ?? (await promptForValue({allowBlank, config, currentDefault, message}))

  if (selectedValue === undefined || selectedValue === null) {
    return noop()
  }

  if (selectedValue === currentDefault?.value?.toString()) {
    return noop(`The default is already \`${selectedValue}\``)
  }

  return validateValue(quonfig, key, selectedValue)
}

const valueToString = (v: Value | undefined): string => {
  if (!v) return ''
  if (v.value === undefined || v.value === null) return ''
  return String(v.value)
}

const promptForValue = async ({
  allowBlank,
  config,
  currentDefault,
  message,
}: {
  allowBlank: boolean
  config?: ConfigResponse
  currentDefault?: Value | undefined
  message: string
}) => {
  // In the new quonfig format, allowable values aren't stored at the config level.
  // Just prompt for a string input.
  if (!currentDefault) {
    return getString({allowBlank, message})
  }

  const autoCompleteMessage = `The current default is \`${valueToString(currentDefault)}\`. Enter your new default.`

  return getString({allowBlank, message: autoCompleteMessage})
}

export default getValue
