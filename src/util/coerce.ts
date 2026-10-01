import type {ConfigValue} from '@quonfig/node'
import {ConfigValueType, durationToMilliseconds} from '@quonfig/node'

import {DURATION_FORMAT_HINT, isValidIsoDuration, parseDoubleValue, parseIntValue} from '../verify/value-grammar.js'

const TRUE_VALUES = new Set(['true', '1', 't'])
const BOOLEAN_VALUES = new Set([...TRUE_VALUES, 'false', '0', 'f'])

// The duration and int/double grammars live in verify/value-grammar.ts so the
// standalone pre-receive hook build can use the same definition.
export {DURATION_FORMAT_HINT, isValidIsoDuration, parseDoubleValue, parseIntValue} from '../verify/value-grammar.js'

type ConfigValueWithConfigValueType = [ConfigValue, ConfigValueType]

export const TYPE_MAPPING: Record<string, ConfigValueType> = {
  bool: ConfigValueType.Bool,
  boolean: ConfigValueType.Bool,
  double: ConfigValueType.Double,
  duration: ConfigValueType.Duration,
  int: ConfigValueType.Int,
  string: ConfigValueType.String,
  'string-list': ConfigValueType.StringList,
  stringList: ConfigValueType.StringList,
}

export const coerceIntoType = (type: string, value: string): ConfigValueWithConfigValueType | undefined => {
  switch (type) {
    case 'string': {
      return [{string: value}, TYPE_MAPPING[type]]
    }

    case 'int': {
      const int = parseIntValue(value)
      if (int === undefined) {
        throw new TypeError(`Invalid default value for int: ${value}`)
      }

      return [{int}, TYPE_MAPPING[type]]
    }

    case 'double': {
      const double = parseDoubleValue(value)

      if (double === undefined) {
        throw new TypeError(`Invalid default value for double: ${value}`)
      }

      return [{double}, TYPE_MAPPING[type]]
    }

    case 'bool':
    case 'boolean': {
      return [{bool: coerceBool(value)}, TYPE_MAPPING[type]]
    }

    case 'stringList':
    case 'string-list': {
      return [{stringList: {values: value.split(/\s*,\s*/)}}, TYPE_MAPPING[type]]
    }

    case 'json': {
      try {
        // ensure the value is valid JSON
        JSON.parse(value)
        return [{json: {json: value}}, ConfigValueType.Json]
      } catch {
        throw new TypeError(`Invalid default value for JSON: ${value}`)
      }
    }

    case 'duration': {
      // durationToMilliseconds() returns 0 on no-match instead of throwing, so
      // we anchor-check the format ourselves before delegating.
      if (!isValidIsoDuration(value)) {
        throw new TypeError(`Invalid default value for duration: ${value}. ${DURATION_FORMAT_HINT}`)
      }

      const millis = durationToMilliseconds(value)
      return [{duration: {definition: value, millis}}, ConfigValueType.Duration]
    }

    default: {
      return undefined
    }
  }
}

export const coerceBool = (value: string): boolean => {
  if (!BOOLEAN_VALUES.has(value.toLowerCase())) {
    throw new TypeError(`Invalid default value for boolean: ${value}`)
  }

  return TRUE_VALUES.has(value.toLowerCase())
}
