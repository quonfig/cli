/**
 * Shared verb: provider variation value → typed Quonfig `{type, value}`.
 *
 * Part of the `quonfig-target/` verb library (plan §3.1, D1). Quonfig values
 * are a discriminated union on `type`; this verb infers the type from the raw
 * JSON a provider hands us and the flag's declared value type.
 */

/** A Quonfig value type — mirrors `ValueTypeSchema` in app-quonfig's config-schemas.ts. */
export type QuonfigValueType = 'bool' | 'double' | 'int' | 'json' | 'string' | 'string_list'

/** A typed Quonfig value object as it appears in stored config JSON. */
export interface QuonfigValue {
  type: QuonfigValueType
  value: unknown
}

/**
 * Infer the Quonfig value type for a single raw value.
 *  - boolean → bool
 *  - integer number → int; non-integer number → double
 *  - string → string
 *  - object / array → json
 */
export function inferValueType(raw: unknown): QuonfigValueType {
  if (typeof raw === 'boolean') return 'bool'
  if (typeof raw === 'number') return Number.isInteger(raw) ? 'int' : 'double'
  if (typeof raw === 'string') return 'string'
  // null, objects, and arrays all serialize as Quonfig `json`.
  return 'json'
}

/**
 * Infer the value type for a whole flag from its variation values.
 *
 * LaunchDarkly boolean flags are unambiguously `bool`. For multivariate flags
 * the variations are homogeneous in practice; we widen `int` → `double` if any
 * variation is fractional so a flag with `[0, 1, 2.5]` lands on `double`
 * rather than silently truncating.
 */
export function inferFlagValueType(kind: string, variationValues: unknown[]): QuonfigValueType {
  if (kind === 'boolean') return 'bool'
  if (variationValues.length === 0) return 'string'

  const types = variationValues.map((v) => inferValueType(v))
  if (types.every((t) => t === 'bool')) return 'bool'
  if (types.every((t) => t === 'int' || t === 'double')) {
    return types.includes('double') ? 'double' : 'int'
  }

  if (types.every((t) => t === 'string')) return 'string'
  // Mixed or object/array variations → json (json can hold any of them).
  return 'json'
}

/**
 * Coerce a raw provider value into a typed Quonfig value object under the
 * flag's declared value type. The declared type wins — a `double` flag whose
 * variation happens to be `2` still serializes as `{type: 'double', value: 2}`
 * so the stored config is internally consistent.
 */
export function toQuonfigValue(raw: unknown, valueType: QuonfigValueType): QuonfigValue {
  switch (valueType) {
    case 'bool': {
      return {type: 'bool', value: Boolean(raw)}
    }

    case 'double':
    case 'int': {
      return {type: valueType, value: typeof raw === 'number' ? raw : Number(raw)}
    }

    case 'json': {
      return {type: 'json', value: raw}
    }

    case 'string_list': {
      return {type: 'string_list', value: Array.isArray(raw) ? raw.map(String) : []}
    }

    case 'string': {
      return {type: 'string', value: typeof raw === 'string' ? raw : String(raw)}
    }

    default: {
      return {type: 'string', value: String(raw)}
    }
  }
}
