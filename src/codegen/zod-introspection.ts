import {z} from 'zod'
import {
  $ZodFunctionArgs,
  $ZodFunctionOut,
  $ZodType,
  $ZodCheckDef,
  $ZodCheckNumberFormatDef,
  util,
  $ZodRecordKey,
} from 'zod/v4/core'

// ============================================================================
// Type Guards
// ============================================================================

export function isString(schema: $ZodType): schema is z.ZodString {
  return schema instanceof z.ZodString
}

export function isNumber(schema: $ZodType): schema is z.ZodNumber {
  return schema instanceof z.ZodNumber
}

export function isBoolean(schema: $ZodType): schema is z.ZodBoolean {
  return schema instanceof z.ZodBoolean
}

export function isNull(schema: $ZodType): schema is z.ZodNull {
  return schema instanceof z.ZodNull
}

export function isUndefined(schema: $ZodType): schema is z.ZodUndefined {
  return schema instanceof z.ZodUndefined
}

export function isUnknown(schema: $ZodType): schema is z.ZodUnknown {
  return schema instanceof z.ZodUnknown
}

export function isAny(schema: $ZodType): schema is z.ZodAny {
  return schema instanceof z.ZodAny
}

export function isArray(schema: $ZodType): schema is z.ZodArray<z.ZodTypeAny> {
  return schema instanceof z.ZodArray
}

export function isObject(schema: $ZodType): schema is z.ZodObject<z.ZodRawShape> {
  return schema instanceof z.ZodObject
}

export function isTuple(schema: $ZodType): schema is z.ZodTuple {
  return schema instanceof z.ZodTuple
}

export function isRecord(schema: $ZodType): schema is z.ZodRecord {
  return schema instanceof z.ZodRecord
}

export function isEnum(schema: $ZodType): schema is z.ZodEnum<util.EnumLike> {
  return schema instanceof z.ZodEnum
}

export function isUnion(schema: $ZodType): schema is z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]> {
  return schema instanceof z.ZodUnion
}

export function isOptional(schema: $ZodType): schema is z.ZodOptional<z.ZodTypeAny> {
  return schema instanceof z.ZodOptional
}

export function isNullable(schema: $ZodType): schema is z.ZodNullable<z.ZodTypeAny> {
  return schema instanceof z.ZodNullable
}

export function isDefault(schema: $ZodType): schema is z.ZodDefault<z.ZodTypeAny> {
  return schema instanceof z.ZodDefault
}

export function isFunction(schema: $ZodType): schema is z.ZodFunction<$ZodFunctionArgs, $ZodFunctionOut> {
  return schema instanceof z.ZodFunction
}

function isCheckNumberFormat(checkDef: $ZodCheckDef): checkDef is $ZodCheckNumberFormatDef {
  return checkDef?.check === 'number_format'
}

// ============================================================================
// Property Extractors
// ============================================================================

/**
 * Gets the element type from an array schema
 */
export function getArrayElement(schema: z.ZodArray<z.ZodTypeAny>): z.ZodTypeAny {
  return schema.def.element
}

/**
 * Gets the shape from an object schema
 */
export function getObjectShape(schema: z.ZodObject<z.ZodRawShape>): z.ZodRawShape {
  return schema.def.shape
}

/**
 * Gets the items from a tuple schema
 */
export function getTupleItems(schema: z.ZodTuple): readonly $ZodType[] {
  return schema.def.items
}

/**
 * Gets the key and value types from a record schema
 */
export function getRecordTypes(schema: z.ZodRecord): {
  keyType: $ZodRecordKey
  valueType: $ZodType
} {
  return {
    keyType: schema.def.keyType,
    valueType: schema.def.valueType,
  }
}

/**
 * Gets the enum values from an enum schema
 */
export function getEnumValues(schema: z.ZodEnum<util.EnumLike>): util.EnumValue[] {
  // In v4, enum entries is an object like { "a": "a", "b": "b", "c": "c" }
  const entries = schema.def.entries
  if (entries && typeof entries === 'object') {
    return Object.values(entries)
  }

  return []
}

/**
 * Gets the options from a union schema
 */
export function getUnionOptions(schema: z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>): z.ZodTypeAny[] {
  return schema.def.options || []
}

/**
 * Unwraps an optional schema to get its inner type
 */
export function unwrapOptional(schema: z.ZodOptional<z.ZodTypeAny>): z.ZodTypeAny {
  return schema.def.innerType
}

/**
 * Unwraps a nullable schema to get its inner type
 */
export function unwrapNullable(schema: z.ZodNullable<z.ZodTypeAny>): z.ZodTypeAny {
  return schema.def.innerType
}

/**
 * Unwraps a default schema to get its inner type and default value
 */
export function unwrapDefault(schema: z.ZodDefault<z.ZodTypeAny>): {
  defaultValue: unknown
  innerType: z.ZodTypeAny
} {
  return {
    defaultValue: schema.def.defaultValue,
    innerType: schema.def.innerType,
  }
}

/**
 * Gets function arguments and return type from a function schema
 */
export function getFunctionSignature(schema: z.ZodFunction<$ZodFunctionArgs, $ZodFunctionOut>): {
  args: $ZodFunctionArgs
  returns: $ZodFunctionOut
} {
  // In v4, function uses input/output properties
  return {
    args: schema.def.input,
    returns: schema.def.output,
  }
}

/**
 * Checks if a number schema has integer constraint
 */
export function isNumberInteger(schema: z.ZodNumber): boolean {
  const checks = schema.def.checks || []

  // Look for number_format check with integer formats
  return checks.some((check) => {
    const checkDef = check._zod?.def
    if (isCheckNumberFormat(checkDef)) {
      const format = checkDef.format
      return format === 'int32' || format === 'uint32' || format === 'safeint'
    }
    return false
  })
}

/**
 * Gets metadata from a schema if it has been set with .meta()
 */
export function getMeta(schema: $ZodType): Record<string, unknown> | undefined {
  if (!schema) {
    return undefined
  }
  // Call .meta() without arguments to retrieve metadata
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (schema as any).meta === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (schema as any).meta() as Record<string, unknown> | undefined
  }
  return undefined
}

/**
 * Gets a comment string from metadata.
 * If meta only contains a description key, returns the description string.
 * Otherwise, returns a JSON representation of the entire meta object.
 */
export function getMetaDescription(schema: $ZodType): string | undefined {
  const meta = getMeta(schema)
  if (!meta || Object.keys(meta).length === 0) {
    return undefined
  }

  // If meta only has a description key, return just the description
  const keys = Object.keys(meta)
  if (keys.length === 1 && keys[0] === 'description' && typeof meta.description === 'string') {
    return meta.description
  }

  // Otherwise, return JSON representation of the entire meta object
  try {
    return JSON.stringify(meta, null, 2)
  } catch {
    // If JSON serialization fails, return undefined
    return undefined
  }
}
