import {Quonfig} from '@quonfig/node'

import {Result, failure, success} from '../result.js'

const validateValue = (quonfig: Quonfig, key: string, value: string): Result<string> => {
  const config = quonfig.rawConfig(key)

  if (!config) {
    return failure(`Could not find config named ${key}`)
  }

  // In the new quonfig format, allowableValues are not yet supported at the config level.
  // This validation is a placeholder — the server enforces schema constraints.
  return success(value)
}

export default validateValue
