import type {ConfigValue} from '@quonfig/node'
import {ConfigValueType, durationToMilliseconds} from '@quonfig/node'

const TRUE_VALUES = new Set(['true', '1', 't'])
const BOOLEAN_VALUES = new Set([...TRUE_VALUES, 'false', '0', 'f'])

// Strict ISO 8601 duration: at least one of D/H/M/S must be present (i.e. bare "P"
// or "PT" alone are rejected). Mirrors the lenient pattern in @quonfig/node but
// adds anchors and a non-empty check.
const ISO_DURATION_PATTERN =
  /^P(?:\d+(?:\.\d+)?D)?(?:T(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/

const isValidIsoDuration = (value: string): boolean => {
  if (!ISO_DURATION_PATTERN.test(value)) return false
  // Reject "P", "PT" — pattern allows them but they have no components.
  return value !== 'P' && value !== 'PT'
}

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
      try {
        const bigInt = BigInt(value)
        const int = Number(bigInt)

        return [{int}, TYPE_MAPPING[type]]
      } catch {
        throw new TypeError(`Invalid default value for int: ${value}`)
      }
    }

    case 'double': {
      const double = Number.parseFloat(value)

      if (Number.isNaN(double)) {
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
        throw new TypeError(
          `Invalid default value for duration: ${value}. Expected ISO 8601 duration like PT30S, PT5M, PT1H30M.`,
        )
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
