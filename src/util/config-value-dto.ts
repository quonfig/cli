import type {ConfigValue} from '@quonfig/node'
import {ConfigValueType} from '@quonfig/node'

/**
 * Maps a ConfigValue to the DTO format expected by the API.
 * Used by both create and set-default commands.
 * @param configValue - The config value to convert
 * @param valueType - The type of the config value
 * @returns The DTO representation of the config value
 */
export function mapConfigValueToDto(configValue: ConfigValue, valueType: ConfigValueType): Record<string, unknown> {
  const dto: Record<string, unknown> = {
    type: mapValueTypeToString(valueType),
  }

  // Handle provided (env-var) values
  if (configValue.provided) {
    return {
      ...dto,
      provided: {
        source: configValue.provided.source,
        lookup: configValue.provided.lookup,
      },
    }
  }

  // Extract the actual value based on type
  let value: unknown
  if (configValue.bool !== undefined) {
    value = configValue.bool
  } else if (configValue.string !== undefined) {
    value = configValue.string
  } else if (configValue.int !== undefined) {
    value = configValue.int
  } else if (configValue.double !== undefined) {
    value = configValue.double
  } else if (configValue.stringList !== undefined) {
    value = configValue.stringList.values
  } else if (configValue.json !== undefined) {
    // ConfigValue.json is wrapped as {json: "<raw JSON string>"} (see coerceIntoType).
    // The API expects the parsed JSON value, not the wrapper or the raw string —
    // otherwise the server stores the default as {} (see qfg-c0q).
    const rawJson = (configValue.json as {json?: unknown}).json
    if (typeof rawJson === 'string') {
      try {
        value = JSON.parse(rawJson)
      } catch {
        // Fall back to raw string if somehow it isn't valid JSON — coerceIntoType
        // should have already rejected this case, so this is defensive only.
        value = rawJson
      }
    } else {
      value = rawJson ?? configValue.json
    }
  } else if (configValue.duration !== undefined) {
    value = configValue.duration
  } else if (configValue.intRange !== undefined) {
    value = configValue.intRange
  } else if ((configValue as Record<string, unknown>).value !== undefined) {
    // Handle encrypted/confidential values where value is directly set
    value = (configValue as Record<string, unknown>).value
  }

  dto.value = value

  if (configValue.confidential) {
    dto.confidential = true
  }

  if (configValue.decryptWith) {
    dto.decryptWith = configValue.decryptWith
  }

  return dto
}

/**
 * Converts a ConfigValueType enum to its string representation for the API.
 * @param valueType - The config value type enum
 * @returns The string representation of the value type
 */
export function mapValueTypeToString(valueType: ConfigValueType): string {
  const mapping: Partial<Record<ConfigValueType, string>> = {
    [ConfigValueType.Bool]: 'bool',
    [ConfigValueType.String]: 'string',
    [ConfigValueType.Int]: 'int',
    [ConfigValueType.Double]: 'double',
    [ConfigValueType.StringList]: 'string_list',
    [ConfigValueType.Json]: 'json',
    [ConfigValueType.LimitDefinition]: 'limit_definition',
    [ConfigValueType.Duration]: 'duration',
    [ConfigValueType.IntRange]: 'int_range',
    [ConfigValueType.Bytes]: 'bytes',
    [ConfigValueType.LogLevel]: 'log_level',
  }
  return mapping[valueType] || 'string'
}
