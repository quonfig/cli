import {ConfigValue, ConfigValueType} from '../quonfig-common/src/types.js'

const TRUE_VALUES = new Set(['true', '1', 't'])
const BOOLEAN_VALUES = new Set([...TRUE_VALUES, 'false', '0', 'f'])

type ConfigValueWithConfigValueType = [ConfigValue, ConfigValueType]

export const TYPE_MAPPING: Record<string, ConfigValueType> = {
  bool: ConfigValueType.Bool,
  boolean: ConfigValueType.Bool,
  double: ConfigValueType.Double,
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
        const int = BigInt(value)

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
