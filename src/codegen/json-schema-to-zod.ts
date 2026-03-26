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

  const resolved = z.union(nonNullTypes.map((type) => schemaToZod({...schema, type})) as [z.ZodTypeAny, ...z.ZodTypeAny[]])
  return includesNull ? resolved.nullable() : resolved
}

function schemaFromObject(schema: JsonSchemaObject): z.ZodTypeAny {
  const properties = isObject(schema.properties) ? schema.properties : {}
  const required = new Set<string>(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [])
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

function schemaToZod(schema: unknown): z.ZodTypeAny {
  if (!isObject(schema)) {
    return z.any()
  }

  const meta = toMeta(schema)

  let result: z.ZodTypeAny

  if (Array.isArray(schema.enum)) {
    result = literalFromEnum(schema.enum)
  }
  else if (schema.const !== undefined) {
    result = z.literal(schema.const as string | number | boolean | null)
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
        if (Array.isArray(schema.prefixItems)) {
          const items = schema.prefixItems.map((item) => schemaToZod(item))
          result = z.tuple(items as [z.ZodTypeAny, ...z.ZodTypeAny[]])
        } else if (schema.items !== undefined) {
          result = z.array(schemaToZod(schema.items))
        } else {
          result = z.array(z.any())
        }
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
        if (Array.isArray(schema.oneOf)) {
          const options = schema.oneOf.map((item) => schemaToZod(item))
          result = options.length === 1 ? options[0] : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
          break
        }

        if (Array.isArray(schema.anyOf)) {
          const options = schema.anyOf.map((item) => schemaToZod(item))
          result = options.length === 1 ? options[0] : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
          break
        }

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
