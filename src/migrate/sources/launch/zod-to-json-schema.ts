/* eslint-disable @typescript-eslint/no-unused-vars, perfectionist/sort-interfaces, unicorn/explicit-length-check, unicorn/no-lonely-if, unicorn/no-array-callback-reference */
// Vendored verbatim from launch-migrator/src/zod-to-json-schema.ts to keep a
// drop-in sync path. Do not reformat — edits here should be mirrored against
// launch-migrator so the two converters stay behaviorally identical.
import * as ts from 'typescript'

export type JsonSchema = boolean | JsonSchemaObject

export interface JsonSchemaObject {
  [key: string]: unknown
}

export interface ZodToJsonSchemaResult {
  schema: JsonSchema
  warnings: string[]
}

interface ConversionResult {
  schema: JsonSchema
  optional: boolean
}

interface ConversionContext {
  warnings: string[]
}

const JSON_SCHEMA_DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression
  }
  return current
}

function parseRegexLiteral(text: string): {pattern: string; flags: string} {
  if (!text.startsWith('/')) {
    throw new Error(`Expected regex literal, got: ${text}`)
  }

  let lastSlash = -1
  for (let index = text.length - 1; index > 0; index -= 1) {
    if (text[index] !== '/') continue

    let backslashCount = 0
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
      backslashCount += 1
    }

    if (backslashCount % 2 === 0) {
      lastSlash = index
      break
    }
  }

  if (lastSlash === -1) {
    throw new Error(`Could not parse regex literal: ${text}`)
  }

  return {
    pattern: text.slice(1, lastSlash),
    flags: text.slice(lastSlash + 1),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function evaluateLiteralExpression(node: ts.Expression): unknown {
  const current = unwrapExpression(node)

  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return current.text
  }

  if (ts.isNumericLiteral(current)) {
    return Number(current.text)
  }

  if (current.kind === ts.SyntaxKind.TrueKeyword) return true
  if (current.kind === ts.SyntaxKind.FalseKeyword) return false
  if (current.kind === ts.SyntaxKind.NullKeyword) return null

  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
    const operand = evaluateLiteralExpression(current.operand as ts.Expression)
    if (typeof operand === 'number') return -operand
  }

  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.map((element) => {
      if (ts.isSpreadElement(element)) {
        throw new Error('Spread elements are not supported in literal arrays')
      }
      return evaluateLiteralExpression(element as ts.Expression)
    })
  }

  if (ts.isObjectLiteralExpression(current)) {
    const result: Record<string, unknown> = {}
    for (const property of current.properties) {
      if (ts.isSpreadAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
        throw new Error('Spread and shorthand properties are not supported in literal objects')
      }

      if (!ts.isPropertyAssignment(property)) {
        throw new Error('Unsupported object literal property')
      }

      const key = getPropertyName(property.name)
      result[key] = evaluateLiteralExpression(property.initializer)
    }
    return result
  }

  if (ts.isRegularExpressionLiteral(current)) {
    return parseRegexLiteral(current.getText())
  }

  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateLiteralExpression(current.left as ts.Expression)
    const right = evaluateLiteralExpression(current.right as ts.Expression)

    if (typeof left === 'string' || typeof right === 'string') {
      return String(left) + String(right)
    }

    if (typeof left === 'number' && typeof right === 'number') {
      return left + right
    }
  }

  if (ts.isIdentifier(current) && current.text === 'undefined') {
    return undefined
  }

  throw new Error(`Unsupported literal expression: ${current.getText()}`)
}

function getPropertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }

  throw new Error(`Unsupported property name: ${name.getText()}`)
}

function schemaKind(schema: JsonSchema): string {
  if (schema === false) return 'never'
  if (!isPlainObject(schema)) return 'unknown'

  if (Array.isArray(schema.anyOf)) return 'union'
  if (schema.const !== undefined) return 'const'
  if (Array.isArray(schema.enum)) return 'enum'

  const type = schema.type
  if (typeof type === 'string') return type

  return 'unknown'
}

function ensureObjectSchema(schema: JsonSchema): JsonSchemaObject {
  if (schema === false || !isPlainObject(schema) || schema.type !== 'object') {
    throw new Error('Expected object schema')
  }
  return schema
}

function makeNullable(schema: JsonSchema): JsonSchema {
  if (!isPlainObject(schema)) {
    return {anyOf: [schema, {type: 'null'}]}
  }
  const existing = schema.type
  if (Array.isArray(existing)) {
    return existing.includes('null') ? schema : {...schema, type: [...existing, 'null']}
  }
  if (typeof existing === 'string') {
    return {...schema, type: [existing, 'null']}
  }
  return {anyOf: [schema, {type: 'null'}]}
}

function withAnnotation(schema: JsonSchema, key: string, value: unknown): JsonSchema {
  if (schema === false) {
    return schema
  }

  const next = {...(schema as Record<string, unknown>)}
  ;(next as Record<string, unknown>)[key] = value
  return next
}

function applyNumericConstraint(
  schema: JsonSchema,
  kind: string,
  method: 'min' | 'max' | 'length',
  value: number,
): JsonSchema {
  if (schema === false) return schema

  const next = {...(schema as Record<string, unknown>)}

  if (kind === 'number' || kind === 'integer') {
    if (method === 'min' || method === 'length') next.minimum = value
    if (method === 'max' || method === 'length') next.maximum = value
    return next
  }

  if (kind === 'string') {
    if (method === 'min' || method === 'length') next.minLength = value
    if (method === 'max' || method === 'length') next.maxLength = value
    return next
  }

  if (kind === 'array') {
    if (method === 'min' || method === 'length') next.minItems = value
    if (method === 'max' || method === 'length') next.maxItems = value
    return next
  }

  throw new Error(`Cannot apply ${method}() to ${kind} schema`)
}

function applyMethod(
  receiver: ConversionResult,
  method: string,
  args: ts.NodeArray<ts.Expression>,
  ctx: ConversionContext,
): ConversionResult {
  const kind = schemaKind(receiver.schema)

  switch (method) {
    case 'optional':
      return {...receiver, optional: true}
    case 'nullable':
      return {schema: makeNullable(receiver.schema), optional: receiver.optional}
    case 'default': {
      if (args.length === 0) throw new Error('default() requires an argument')
      return {
        schema: withAnnotation(receiver.schema, 'default', evaluateLiteralExpression(args[0])),
        optional: true,
      }
    }
    case 'describe': {
      if (args.length === 0) throw new Error('describe() requires an argument')
      return {
        schema: withAnnotation(receiver.schema, 'description', evaluateLiteralExpression(args[0])),
        optional: receiver.optional,
      }
    }
    case 'meta': {
      if (args.length === 0) throw new Error('meta() requires an argument')

      const meta = evaluateLiteralExpression(args[0])
      if (!isPlainObject(meta)) {
        throw new Error('meta() expects an object literal')
      }

      let schema: JsonSchema = receiver.schema
      const supportedKeys = new Set(['description', 'title'])
      for (const [key, value] of Object.entries(meta)) {
        if (supportedKeys.has(key)) {
          schema = withAnnotation(schema, key, value)
        } else {
          ctx.warnings.push(`Ignored unsupported meta field "${key}"`)
        }
      }

      return {schema, optional: receiver.optional}
    }
    case 'url':
      if (kind !== 'string') {
        throw new Error('url() can only be applied to string schemas')
      }
      return {
        schema: withAnnotation(receiver.schema, 'format', 'uri'),
        optional: receiver.optional,
      }
    case 'email':
      if (kind !== 'string') {
        throw new Error('email() can only be applied to string schemas')
      }
      return {
        schema: withAnnotation(receiver.schema, 'format', 'email'),
        optional: receiver.optional,
      }
    case 'uuid':
      if (kind !== 'string') {
        throw new Error('uuid() can only be applied to string schemas')
      }
      return {
        schema: withAnnotation(receiver.schema, 'format', 'uuid'),
        optional: receiver.optional,
      }
    case 'datetime':
      if (kind !== 'string') {
        throw new Error('datetime() can only be applied to string schemas')
      }
      return {
        schema: withAnnotation(receiver.schema, 'format', 'date-time'),
        optional: receiver.optional,
      }
    case 'regex': {
      if (kind !== 'string') {
        throw new Error('regex() can only be applied to string schemas')
      }
      if (args.length === 0) throw new Error('regex() requires an argument')
      const regex = evaluateLiteralExpression(args[0])
      if (!isPlainObject(regex) || typeof regex.pattern !== 'string') {
        throw new Error('regex() expects a regex literal')
      }

      if (typeof regex.flags === 'string' && regex.flags.length > 0) {
        ctx.warnings.push(`Ignored regex flags "${regex.flags}"`)
      }

      return {
        schema: withAnnotation(receiver.schema, 'pattern', regex.pattern),
        optional: receiver.optional,
      }
    }
    case 'min':
      if (args.length === 0) throw new Error('min() requires an argument')
      return {
        schema: applyNumericConstraint(receiver.schema, kind, 'min', Number(evaluateLiteralExpression(args[0]))),
        optional: receiver.optional,
      }
    case 'max':
      if (args.length === 0) throw new Error('max() requires an argument')
      return {
        schema: applyNumericConstraint(receiver.schema, kind, 'max', Number(evaluateLiteralExpression(args[0]))),
        optional: receiver.optional,
      }
    case 'length':
      if (args.length === 0) throw new Error('length() requires an argument')
      return {
        schema: applyNumericConstraint(receiver.schema, kind, 'length', Number(evaluateLiteralExpression(args[0]))),
        optional: receiver.optional,
      }
    case 'int': {
      if (kind !== 'number' && kind !== 'integer') {
        throw new Error('int() can only be applied to number schemas')
      }
      const next = withAnnotation(receiver.schema, 'type', 'integer')
      return {schema: next, optional: receiver.optional}
    }
    case 'positive': {
      if (kind !== 'number' && kind !== 'integer') {
        throw new Error('positive() can only be applied to number schemas')
      }
      const next = withAnnotation(receiver.schema, 'exclusiveMinimum', 0)
      return {schema: next, optional: receiver.optional}
    }
    case 'strict': {
      const objectSchema = ensureObjectSchema(receiver.schema)
      return {
        schema: {...objectSchema, additionalProperties: false},
        optional: receiver.optional,
      }
    }
    case 'partial': {
      // .partial() makes all declared properties optional. For records
      // (open-shape objects) there's nothing to do.
      if (!isPlainObject(receiver.schema)) {
        return {...receiver}
      }
      const {required: _required, ...rest} = receiver.schema as JsonSchemaObject
      return {schema: rest, optional: receiver.optional}
    }
    case 'array':
      return {
        schema: {
          type: 'array',
          items: receiver.schema,
        },
        optional: receiver.optional,
      }
    case 'or': {
      if (args.length === 0) throw new Error('or() requires an argument')
      const other = convertExpression(args[0], ctx)
      return {
        schema: {anyOf: [receiver.schema, other.schema]},
        optional: receiver.optional || other.optional,
      }
    }
    default:
      throw new Error(`Unsupported Zod method: ${method}`)
  }
}

function convertObjectShape(objectLiteral: ts.ObjectLiteralExpression, ctx: ConversionContext): JsonSchemaObject {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []

  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error('Only property assignments are supported in z.object()')
    }

    const key = getPropertyName(property.name)
    const child = convertExpression(property.initializer, ctx)
    properties[key] = child.schema
    if (!child.optional) {
      required.push(key)
    }
  }

  return {
    type: 'object',
    properties,
    required,
  }
}

function convertBaseZodCall(
  method: string,
  args: ts.NodeArray<ts.Expression>,
  ctx: ConversionContext,
): ConversionResult {
  switch (method) {
    case 'string':
      return {schema: {type: 'string'}, optional: false}
    case 'number':
      return {schema: {type: 'number'}, optional: false}
    case 'boolean':
      return {schema: {type: 'boolean'}, optional: false}
    case 'enum': {
      // Canonical form: z.enum(["a", "b"]). Also tolerate the hand-written
      // typo z.enum("a", "b") by treating variadic args as an implicit array.
      let elements: readonly ts.Expression[]
      if (args.length === 1 && ts.isArrayLiteralExpression(args[0])) {
        elements = args[0].elements
      } else if (args.length >= 1) {
        elements = args
      } else {
        throw new Error('enum() expects at least one argument')
      }

      const values = elements.map((element) => evaluateLiteralExpression(element as ts.Expression))
      return {schema: {enum: values}, optional: false}
    }
    case 'literal': {
      if (args.length !== 1) throw new Error('literal() expects a single argument')
      return {schema: {const: evaluateLiteralExpression(args[0])}, optional: false}
    }
    case 'never':
      return {schema: false, optional: false}
    case 'array': {
      if (args.length !== 1) {
        throw new Error('array() expects a single argument')
      }
      const item = convertExpression(args[0], ctx)
      return {
        schema: {
          type: 'array',
          items: item.schema,
        },
        optional: false,
      }
    }
    case 'object': {
      if (args.length === 0) {
        return {schema: {type: 'object'}, optional: false}
      }
      if (args.length !== 1 || !ts.isObjectLiteralExpression(args[0])) {
        throw new Error('object() expects a single object literal argument')
      }

      return {
        schema: convertObjectShape(args[0], ctx),
        optional: false,
      }
    }
    case 'record': {
      if (args.length === 0 || args.length > 2) {
        throw new Error('record() expects one or two arguments')
      }

      let keySchema: ConversionResult | undefined
      let valueIndex = 0

      if (args.length === 2) {
        keySchema = convertExpression(args[0], ctx)
        valueIndex = 1
      }

      const valueSchema = convertExpression(args[valueIndex], ctx)
      const schema: JsonSchemaObject = {
        type: 'object',
        additionalProperties: valueSchema.schema,
      }

      if (keySchema && isPlainObject(keySchema.schema) && Array.isArray(keySchema.schema.enum)) {
        schema.propertyNames = {enum: keySchema.schema.enum}
      }

      return {schema, optional: false}
    }
    case 'union': {
      if (args.length !== 1 || !ts.isArrayLiteralExpression(args[0])) {
        throw new Error('union() expects a single array literal argument')
      }

      const options = args[0].elements.map((element) => convertExpression(element as ts.Expression, ctx).schema)
      return {schema: {anyOf: options}, optional: false}
    }
    case 'tuple': {
      if (args.length !== 1 || !ts.isArrayLiteralExpression(args[0])) {
        throw new Error('tuple() expects a single array literal argument')
      }
      const items = args[0].elements.map((element) => convertExpression(element as ts.Expression, ctx).schema)
      const schema: JsonSchemaObject = {type: 'array', minItems: items.length, maxItems: items.length}
      if (items.length > 0) {
        schema.prefixItems = items
        schema.items = false
      } else {
        schema.items = false
      }
      return {schema, optional: false}
    }
    default:
      throw new Error(`Unsupported base Zod call: ${method}`)
  }
}

function convertCallExpression(call: ts.CallExpression, ctx: ConversionContext): ConversionResult {
  const callee = unwrapExpression(call.expression)

  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text
    const receiverExpr = unwrapExpression(callee.expression as ts.Expression)

    if (ts.isIdentifier(receiverExpr)) {
      const base = receiverExpr.text
      if (base === 'z') {
        return convertBaseZodCall(method, call.arguments, ctx)
      }
    }

    const receiver = convertExpression(receiverExpr, ctx)
    return applyMethod(receiver, method, call.arguments, ctx)
  }

  if (ts.isIdentifier(callee)) {
    if (callee.text === 'z') {
      throw new Error('Unexpected bare z() call')
    }
  }

  throw new Error(`Unsupported call expression: ${call.getText()}`)
}

function convertExpression(node: ts.Expression, ctx: ConversionContext): ConversionResult {
  const expr = unwrapExpression(node)

  if (ts.isCallExpression(expr)) {
    return convertCallExpression(expr, ctx)
  }

  // Tolerate hand-written Zod that omits the parens on .nullable/.optional
  // (a common user typo — property access returns the method function, not a
  // schema, so the intent is always the method call).
  if (ts.isPropertyAccessExpression(expr)) {
    const method = expr.name.text
    if (method === 'nullable' || method === 'optional') {
      const receiver = convertExpression(expr.expression as ts.Expression, ctx)
      return applyMethod(receiver, method, ts.factory.createNodeArray<ts.Expression>([]), ctx)
    }
  }

  if (ts.isIdentifier(expr) && expr.text === 'undefined') {
    return {schema: false, optional: true}
  }

  throw new Error(`Unsupported Zod expression: ${expr.getText()}`)
}

export function zodToJsonSchema(source: string): ZodToJsonSchemaResult {
  const sourceFile = ts.createSourceFile('schema.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const ctx: ConversionContext = {warnings: []}

  const expressionStatement = sourceFile.statements.find(ts.isExpressionStatement)
  if (!expressionStatement) {
    throw new Error('Expected a Zod expression')
  }

  const result = convertExpression(expressionStatement.expression, ctx)

  if (result.schema !== false && isPlainObject(result.schema)) {
    result.schema.$schema = JSON_SCHEMA_DRAFT_2020_12
  }

  return {
    schema: result.schema,
    warnings: ctx.warnings,
  }
}
