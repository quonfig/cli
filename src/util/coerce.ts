import type {ConfigValue} from '@quonfig/node'
import {ConfigValueType, durationToMilliseconds} from '@quonfig/node'

const TRUE_VALUES = new Set(['true', '1', 't'])
const BOOLEAN_VALUES = new Set([...TRUE_VALUES, 'false', '0', 'f'])

// The ONE duration grammar (qfg-2agi.29), shared by qfg create, set-default,
// override and verify. Fixture of record: integration-test-data
// tests/duration/grammar.yaml (test/util/duration-grammar.test.ts holds this
// function to it).
//
//   ^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$
//
// plus: at least one component, no dangling T, a fraction only on S with at
// most 9 digits, total magnitude <= P36500D. [0-9] (not \d) and the whole
// string anchored so ports to other regex engines stay strict.
// JS \d is already ASCII-only; [0-9] is kept so a copy into Python/.NET is safe.
/* eslint-disable unicorn/better-regex */
const ISO_DURATION_PATTERN =
  /^P(?:(?<d>[0-9]+)D)?(?:T(?:(?<h>[0-9]+)H)?(?:(?<m>[0-9]+)M)?(?:(?<s>[0-9]+)(?:\.(?<f>[0-9]{1,9}))?S)?)?$/
/* eslint-enable unicorn/better-regex */

export const DURATION_FORMAT_HINT =
  'Expected an ISO 8601 duration such as PT30S, PT5M, PT1H30M or P1DT6H (days, hours, minutes, seconds; a fraction only on seconds; at most P36500D).'

const NANOS_PER_SECOND = 1_000_000_000n
const MAX_DURATION_NANOS = 36_500n * 86_400n * NANOS_PER_SECOND

export const isValidIsoDuration = (value: string): boolean => {
  const match = ISO_DURATION_PATTERN.exec(value)
  if (!match?.groups) return false
  const {d, f, h, m, s} = match.groups
  // At least one component; a T must be followed by at least one of H/M/S.
  if (d === undefined && h === undefined && m === undefined && s === undefined) return false
  if (value.includes('T') && h === undefined && m === undefined && s === undefined) return false
  // Exact integer arithmetic: huge digit strings cannot overflow past the cap.
  const nanos =
    (BigInt(d ?? 0) * 86_400n + BigInt(h ?? 0) * 3600n + BigInt(m ?? 0) * 60n + BigInt(s ?? 0)) * NANOS_PER_SECOND +
    BigInt((f ?? '').padEnd(9, '0'))
  return nanos <= MAX_DURATION_NANOS
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
