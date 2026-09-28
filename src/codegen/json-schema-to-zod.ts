import {z} from 'zod'

type JsonSchemaObject = Record<string, unknown>

function isObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toMeta(schema: JsonSchemaObject): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {}

  if (typeof schema.title === 'string') {
    meta.title = schema.title
  }

  if (typeof schema.description === 'string') {
    meta.description = schema.description
  }

  return Object.keys(meta).length > 0 ? meta : undefined
}

function applyMeta(schema: z.ZodTypeAny, meta: Record<string, unknown> | undefined): z.ZodTypeAny {
  return meta ? schema.meta(meta) : schema
}

function literalFromEnum(values: unknown[]): z.ZodTypeAny {
  if (values.length === 0) {
    return z.never()
  }

  if (values.every((value) => typeof value === 'string')) {
    return z.enum(values as [string, ...string[]])
  }

  if (values.length === 1) {
    return z.literal(values[0] as string | number | boolean | null)
  }

  const literals = values.map((value) => z.literal(value as string | number | boolean | null))
  return z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
}

function schemaFromTypeArray(schema: JsonSchemaObject, types: unknown[]): z.ZodTypeAny {
  const nonNullTypes = types.filter((item) => item !== 'null')
  const includesNull = nonNullTypes.length !== types.length

  if (nonNullTypes.length === 0 && includesNull) {
    return z.null()
  }

  if (nonNullTypes.length === 1) {
    const resolved = schemaToZod({...schema, type: nonNullTypes[0]})
    return includesNull ? resolved.nullable() : resolved
  }

  const resolved = z.union(
    nonNullTypes.map((type) => schemaToZod({...schema, type})) as [z.ZodTypeAny, ...z.ZodTypeAny[]],
  )
  return includesNull ? resolved.nullable() : resolved
}

function schemaFromObject(schema: JsonSchemaObject): z.ZodTypeAny {
  const properties = isObject(schema.properties) ? schema.properties : {}
  const required = new Set<string>(
    Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [],
  )
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const [key, value] of Object.entries(properties)) {
    const propertySchema = schemaToZod(value)
    shape[key] = required.has(key) ? propertySchema : propertySchema.optional()
  }

  const base = z.object(shape)

  if (schema.additionalProperties === false) {
    return base.strict()
  }

  if (isObject(schema.additionalProperties) && Object.keys(properties).length === 0) {
    return z.record(z.string(), schemaToZod(schema.additionalProperties))
  }

  return base
}

/**
 * JSON Schema object branch check for tag detection: `type: "object"`, or no type with `properties`.
 */
function isObjectBranch(schema: unknown): schema is JsonSchemaObject {
  if (!isObject(schema)) {
    return false
  }

  if (schema.type === 'object') {
    return true
  }

  return schema.type === undefined && isObject(schema.properties)
}

/**
 * The single value a property schema pins, from `const` or a one-value `enum`.
 */
function pinnedValue(schema: unknown): {value: unknown} | undefined {
  if (!isObject(schema)) {
    return undefined
  }

  if (schema.const !== undefined) {
    return {value: schema.const}
  }

  if (Array.isArray(schema.enum) && schema.enum.length === 1) {
    return {value: schema.enum[0]}
  }

  return undefined
}

/**
 * Finds the tag of a tagged oneOf/anyOf: every branch is an object, and exactly one property name is
 * required and pinned to a single value (`const` or one-value `enum`) in every branch, with a
 * different value in each. Returns undefined when there is no such property, or more than one.
 */
function findUnionTag(branches: unknown[]): string | undefined {
  if (branches.length < 2 || !branches.every((branch) => isObjectBranch(branch))) {
    return undefined
  }

  const objectBranches = branches as JsonSchemaObject[]
  const [first] = objectBranches
  const firstProperties = isObject(first.properties) ? first.properties : {}

  const candidates = Object.keys(firstProperties).filter((key) => {
    const values: unknown[] = []

    for (const branch of objectBranches) {
      const properties = isObject(branch.properties) ? branch.properties : {}
      const required = Array.isArray(branch.required) ? branch.required : []
      const pinned = pinnedValue(properties[key])

      if (!pinned || !required.includes(key)) {
        return false
      }

      values.push(pinned.value)
    }

    return new Set(values.map((value) => JSON.stringify(value))).size === values.length
  })

  return candidates.length === 1 ? candidates[0] : undefined
}

function schemaFromUnion(branches: unknown[]): z.ZodTypeAny {
  if (branches.length === 0) {
    return z.never()
  }

  const options = branches.map((item) => schemaToZod(item))

  if (options.length === 1) {
    return options[0]
  }

  const tag = findUnionTag(branches)

  // discriminatedUnion needs every option to be a plain object schema (no default/other wrapper)
  if (tag && options.every((option) => option instanceof z.ZodObject)) {
    return z.discriminatedUnion(tag, options as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]])
  }

  return z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
}

const STRUCTURAL_KEYWORDS = ['type', 'properties', 'const', 'enum', '$ref', 'items'] as const

/**
 * A branch is structural when it describes a shape (type, properties, const, enum, $ref, items or a
 * schema-valued additionalProperties), as opposed to adding constraints only (required, format,
 * pattern, min/max...) to the sibling `type`.
 */
function isStructuralBranch(branch: unknown): boolean {
  if (!isObject(branch)) {
    return false
  }

  return STRUCTURAL_KEYWORDS.some((key) => branch[key] !== undefined) || isObject(branch.additionalProperties)
}

/**
 * A oneOf/anyOf is only a union when at least one branch is structural. When every branch is
 * constraint-only it can't change the type, so the sibling `type` decides it.
 */
function hasStructuralBranch(branches: unknown[]): boolean {
  return branches.some((branch) => isStructuralBranch(branch))
}

/**
 * oneOf/anyOf, checked before `type` so a union next to `type: "object"` (or no type) isn't lost.
 * Sibling `properties` are kept as an intersection with the union.
 */
function schemaFromCombinator(schema: JsonSchemaObject, branches: unknown[]): z.ZodTypeAny {
  const union = schemaFromUnion(branches)
  // schemaFromObject reads only properties/required/additionalProperties, so the combinator isn't re-entered
  if (isObject(schema.properties) && Object.keys(schema.properties).length > 0) {
    return z.intersection(schemaFromObject(schema), union)
  }

  return union
}

const MAX_TUPLE_MIN_ITEMS = 8

function schemaFromArray(schema: JsonSchemaObject): z.ZodTypeAny {
  if (Array.isArray(schema.prefixItems)) {
    const items = schema.prefixItems.map((item) => schemaToZod(item))
    return z.tuple(items as [z.ZodTypeAny, ...z.ZodTypeAny[]])
  }

  const item = schema.items === undefined ? z.any() : schemaToZod(schema.items)
  const {maxItems, minItems} = schema

  // `minItems: n` with no upper bound is a tuple of n items plus a rest: [T, T, ...T[]].
  // Above MAX_TUPLE_MIN_ITEMS the tuple would be unreadable, so it stays a plain array.
  if (
    typeof minItems === 'number' &&
    Number.isInteger(minItems) &&
    minItems >= 1 &&
    minItems <= MAX_TUPLE_MIN_ITEMS &&
    maxItems === undefined
  ) {
    const fixed = Array.from({length: minItems}, () => item)
    return z.tuple(fixed as [z.ZodTypeAny, ...z.ZodTypeAny[]]).rest(item)
  }

  return z.array(item)
}

function schemaToZod(schema: unknown): z.ZodTypeAny {
  if (!isObject(schema)) {
    return z.any()
  }

  const meta = toMeta(schema)

  let result: z.ZodTypeAny

  if (Array.isArray(schema.enum)) {
    result = literalFromEnum(schema.enum)
  } else if (schema.const !== undefined) {
    result = z.literal(schema.const as string | number | boolean | null)
  } else if (Array.isArray(schema.oneOf) && hasStructuralBranch(schema.oneOf)) {
    result = schemaFromCombinator(schema, schema.oneOf)
  } else if (Array.isArray(schema.anyOf) && hasStructuralBranch(schema.anyOf)) {
    result = schemaFromCombinator(schema, schema.anyOf)
  } else if (Array.isArray(schema.type)) {
    result = schemaFromTypeArray(schema, schema.type)
  } else {
    switch (schema.type) {
      case 'string': {
        result = z.string()
        break
      }

      case 'number': {
        result = z.number()
        break
      }

      case 'integer': {
        result = z.number().int()
        break
      }

      case 'boolean': {
        result = z.boolean()
        break
      }

      case 'null': {
        result = z.null()
        break
      }

      case 'array': {
        result = schemaFromArray(schema)
        break
      }

      case 'object':
      case undefined: {
        if (schema.properties || schema.additionalProperties !== undefined || schema.required) {
          result = schemaFromObject(schema)
        } else {
          result = z.object({})
        }
        break
      }

      default: {
        if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
          result = schemaToZod(schema.allOf[0])
          break
        }

        if (schema.not === false) {
          result = z.never()
          break
        }

        result = z.any()
      }
    }
  }

  if (schema.default !== undefined) {
    result = result.default(schema.default)
  }

  result = applyMeta(result, meta)

  return result
}

export function isLegacySchemaWrapper(schema: unknown): boolean {
  if (!isObject(schema)) {
    return false
  }

  const defaultSection = schema.default
  if (!isObject(defaultSection) || !Array.isArray(defaultSection.rules)) {
    return false
  }

  const firstRule = defaultSection.rules[0]
  if (!isObject(firstRule)) {
    return false
  }

  const value = firstRule.value
  if (!isObject(value) || !isObject(value.schema)) {
    return false
  }

  return typeof value.schema.schema === 'string'
}

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  return schemaToZod(schema)
}
