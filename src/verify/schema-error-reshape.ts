/* eslint-disable perfectionist/sort-interfaces, unicorn/prefer-string-replace-all, unicorn/no-array-callback-reference, unicorn/no-lonely-if --
 * Copied from app-quonfig src/lib/domain/schema-error-reshape.ts (qfg-phcv).
 * Only prettier's formatting differs; keep the logic identical to the app's
 * copy rather than restyling it for this repo's lint rules. */
/**
 * Ajv errors -> readable `{ path, message }` violations (qfg-q5f6.1).
 *
 * SELF-CONTAINED ON PURPOSE. This file has no imports: it is copied verbatim
 * into `cli/src/verify/` so `qfg verify`, the app server and the browser
 * (list badge, view page) word every violation the same way. Change it here
 * first and re-copy; do not let the two drift.
 *
 * It works on any error object shaped like Ajv's `ErrorObject` (keyword,
 * instancePath, schemaPath, params, message), from Ajv run with
 * `allErrors: true`.
 *
 * Tagged `oneOf` (plan 2026-09-25-advanced-schema-for-jev.md, W1): Ajv
 * reports every branch's failures, which for a three-way union is mostly
 * noise. When every branch is an object with the same `const` (or one-value
 * `enum`) property, that property is the tag:
 * - the value's tag picks a branch -> only that branch's errors are kept;
 * - the tag is missing or unknown -> ONE error:
 *   "`type` must be one of noul, score, choice".
 * A `oneOf` without a tag is left as Ajv reported it.
 */

/** The subset of Ajv's `ErrorObject` this module reads. */
export interface SchemaErrorLike {
  keyword: string
  instancePath: string
  schemaPath: string
  params: object
  message?: string
  propertyName?: string
}

export interface SchemaViolation {
  /** Dotted path inside the value (`criteria[1]`, `a.b`); "" for the root. */
  path: string
  message: string
}

/** Keyword of the single error that replaces a missing/unknown-tag `oneOf`. */
export const ONE_OF_TAG_KEYWORD = 'oneOfTag'

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function unescapeToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function pointerTokens(pointer: string): string[] {
  const body = pointer.startsWith('#') ? pointer.slice(1) : pointer
  if (!body) return []
  return body.slice(1).split('/').map(unescapeToken)
}

function resolvePointer(root: unknown, pointer: string): unknown {
  let node = root
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(node)) node = node[Number(token)]
    else if (isObject(node)) node = node[token]
    else return undefined
  }
  return node
}

/**
 * Ajv `instancePath` (JSON pointer) -> dotted path:
 * `/questions/tone/criteria/1` -> `questions.tone.criteria[1]`.
 * Walks the value so only real array indexes become `[n]`.
 */
export function instancePathToDotted(instancePath: string, value: unknown): string {
  if (!instancePath) return ''
  let path = ''
  let node: unknown = value
  for (const token of pointerTokens(instancePath)) {
    if (Array.isArray(node)) {
      path += `[${token}]`
      node = node[Number(token)]
    } else {
      path += path ? `.${token}` : token
      node = isObject(node) ? node[token] : undefined
    }
  }
  return path
}

/** Follow local `$ref`s (`#/...`) a few hops; anything else is returned as is. */
function derefLocal(schema: unknown, root: unknown): unknown {
  let node = schema
  for (let hops = 0; hops < 8; hops += 1) {
    if (!isObject(node) || typeof node.$ref !== 'string') return node
    if (!node.$ref.startsWith('#')) return node
    node = resolvePointer(root, node.$ref)
  }
  return node
}

function tagValueOf(property: unknown): {value: unknown} | undefined {
  if (!isObject(property)) return undefined
  if ('const' in property) return {value: property.const}
  if (Array.isArray(property.enum) && property.enum.length === 1) {
    return {value: property.enum[0]}
  }
  return undefined
}

export interface OneOfTag {
  /** The tag property name, e.g. `type`. */
  name: string
  /** Tag value of each branch, in branch order. */
  values: unknown[]
}

/**
 * Find the tag of a `oneOf`: the ONE property that is a `const` (or a
 * one-value `enum`) in every branch, with distinct values. Undefined when
 * there is none, or more than one candidate.
 */
export function findOneOfTag(branches: unknown[], root: unknown): OneOfTag | undefined {
  if (branches.length < 2) return undefined
  const resolved = branches.map((branch) => derefLocal(branch, root))
  const propertiesOf = resolved.map((branch) =>
    isObject(branch) && isObject(branch.properties) ? branch.properties : undefined,
  )
  const first = propertiesOf[0]
  if (!first || propertiesOf.some((props) => !props)) return undefined

  const candidates: OneOfTag[] = []
  for (const name of Object.keys(first)) {
    const values: unknown[] = []
    for (const props of propertiesOf) {
      const tag = tagValueOf(derefLocal(props![name], root))
      if (!tag) break
      values.push(tag.value)
    }
    if (values.length !== branches.length) continue
    const distinct = new Set(values.map((v) => JSON.stringify(v)))
    if (distinct.size !== values.length) continue
    candidates.push({name, values})
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

function formatTagValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isUnderInstance(error: SchemaErrorLike, instancePath: string) {
  return error.instancePath === instancePath || error.instancePath.startsWith(`${instancePath}/`)
}

/** Schema-path prefixes that identify errors raised inside branch `index`. */
function branchPrefixes(oneOfPath: string, branch: unknown, index: number): string[] {
  const prefixes = [`${oneOfPath}/${index}/`]
  // A `{ "$ref": "#/$defs/x" }` branch reports its errors under the ref.
  if (isObject(branch) && typeof branch.$ref === 'string') {
    if (branch.$ref.startsWith('#')) prefixes.push(`${branch.$ref}/`)
  }
  return prefixes
}

/**
 * Collapse tagged `oneOf` noise. Returns a new list in Ajv's order: errors
 * from non-selected branches are dropped, and a missing/unknown tag becomes
 * a single `oneOfTag` error at the union's position.
 */
export function reshapeOneOfErrors<E extends SchemaErrorLike>(
  errors: readonly E[],
  rootSchema: unknown,
  value: unknown,
): (E | SchemaErrorLike)[] {
  const dropped = new Set<number>()
  const replaced = new Map<number, SchemaErrorLike>()

  errors.forEach((error, index) => {
    if (error.keyword !== 'oneOf') return
    // More than one branch passed: that is not a tagging problem.
    const passing = (error.params as {passingSchemas?: unknown}).passingSchemas
    if (passing !== null && passing !== undefined) return

    const branches = resolvePointer(rootSchema, error.schemaPath)
    if (!Array.isArray(branches)) return
    const tag = findOneOfTag(branches, rootSchema)
    if (!tag) return

    const members: {index: number; branch: number}[] = []
    const prefixes = branches.map((branch, i) => branchPrefixes(error.schemaPath, branch, i))
    errors.forEach((other, otherIndex) => {
      if (otherIndex === index) return
      if (!isUnderInstance(other, error.instancePath)) return
      const branch = prefixes.findIndex((list) => list.some((prefix) => other.schemaPath.startsWith(prefix)))
      if (branch >= 0) members.push({index: otherIndex, branch})
    })

    const instance = resolvePointer(value, error.instancePath)
    const selected =
      isObject(instance) && tag.name in instance
        ? tag.values.findIndex((v) => JSON.stringify(v) === JSON.stringify(instance[tag.name]))
        : -1

    if (selected < 0) {
      for (const member of members) dropped.add(member.index)
      const allowed = tag.values.map(formatTagValue).join(', ')
      replaced.set(index, {
        keyword: ONE_OF_TAG_KEYWORD,
        instancePath: error.instancePath,
        schemaPath: error.schemaPath,
        params: {tag: tag.name, allowedValues: tag.values},
        message: isObject(instance) ? `\`${tag.name}\` must be one of ${allowed}` : 'must be object',
      })
      return
    }

    const kept = members.filter((member) => member.branch === selected)
    for (const member of members) {
      if (member.branch !== selected) dropped.add(member.index)
    }
    // Keep Ajv's "must match exactly one schema" only if the selected branch
    // reported nothing we could attribute to it (e.g. a remote `$ref`).
    if (kept.length > 0) dropped.add(index)
  })

  const result: (E | SchemaErrorLike)[] = []
  errors.forEach((error, index) => {
    if (dropped.has(index)) return
    result.push(replaced.get(index) ?? error)
  })
  return result
}

function stringifyAllowed(entry: unknown): string {
  return typeof entry === 'string' ? entry : JSON.stringify(entry)
}

/** One error -> message. Undefined means "skip it, a nested error says why". */
export function describeSchemaError(error: SchemaErrorLike): string | undefined {
  const params = error.params as Record<string, unknown>
  const message = error.message ?? `failed ${error.keyword}`
  switch (error.keyword) {
    case 'additionalProperties':
      return `must NOT have additional property '${String(params.additionalProperty)}'`
    case 'unevaluatedProperties':
      return `must NOT have unevaluated property '${String(params.unevaluatedProperty)}'`
    case 'enum':
      return Array.isArray(params.allowedValues)
        ? `${message}: ${params.allowedValues.map(stringifyAllowed).join(', ')}`
        : message
    case 'propertyNames':
      // The nested keyword error (which carries `propertyName`) says why.
      return undefined
    default:
      break
  }
  if (error.propertyName !== undefined) {
    return `property name '${error.propertyName}': ${message}`
  }
  return message
}

/**
 * Ajv errors for `value` against `rootSchema` -> violations, with tagged
 * `oneOf` noise collapsed. Call it only when validation failed: it never
 * returns an empty list.
 */
export function schemaErrorsToViolations(
  errors: readonly SchemaErrorLike[],
  rootSchema: unknown,
  value: unknown,
): SchemaViolation[] {
  const violations: SchemaViolation[] = []
  for (const error of reshapeOneOfErrors(errors, rootSchema, value)) {
    const message = describeSchemaError(error)
    if (message === undefined) continue
    violations.push({
      path: instancePathToDotted(error.instancePath, value),
      message,
    })
  }
  if (violations.length === 0) {
    violations.push({path: '', message: 'does not match the schema'})
  }
  return violations
}
