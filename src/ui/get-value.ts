import {Quonfig} from '@quonfig/node'
import type {Value, ConfigResponse} from '@quonfig/node'

import {defaultValueFor} from '../quonfig.js'
import {Result, failure, noop, success} from '../result.js'
import isInteractive from '../util/is-interactive.js'
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
  mask,
  message,
  quonfig,
}: {
  allowBlank?: boolean
  /** mask the prompt input (secret values, qfg-38lp) */
  mask?: boolean
  desiredValue: string | undefined
  environment?: Environment
  flags: {interactive?: boolean}
  key?: string
  message: string
  quonfig: Quonfig
}): Promise<Result<string>> => {
  if (desiredValue === undefined && !isInteractive(flags)) {
    return failure(
      `No value provided for ${key ?? message}. Pass --value=<value>, --value-stdin or --value-from-env=<VAR> (or use --env-var) when running non-interactively.`,
    )
  }

  if (!key) {
    if (desiredValue !== undefined) {
      return success(desiredValue)
    }

    const value = await promptForValue({allowBlank, mask, message})

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

  const selectedValue = desiredValue ?? (await promptForValue({allowBlank, config, currentDefault, mask, message}))

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
  config: _config,
  currentDefault,
  mask,
  message,
}: {
  allowBlank: boolean
  config?: ConfigResponse
  currentDefault?: Value | undefined
  mask?: boolean
  message: string
}) => {
  // In the new quonfig format, allowable values aren't stored at the config level.
  // Just prompt for a string input.
  if (!currentDefault || mask) {
    return getString({allowBlank, mask, message})
  }

  const autoCompleteMessage = `The current default is \`${valueToString(currentDefault)}\`. Enter your new default.`

  return getString({allowBlank, message: autoCompleteMessage})
}

export default getValue
