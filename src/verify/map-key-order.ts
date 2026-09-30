/**
 * Integer map key order warning (qfg-e87r.21).
 *
 * JavaScript objects always put integer keys first, ascending, then every
 * other key in insertion order. The app editor reads a value with JSON.parse
 * and saves it with JSON.stringify, so a hand-written map
 * `{"b": 2, "a": 1, "5": 0}` comes back from an app save as
 * `{"5": 0, "b": 2, "a": 1}`. Nothing is lost, but git gets a one-time
 * key-order diff. This check warns about it up front.
 *
 * Scope: maps only, meaning objects under an `additionalProperties` schema
 * (keys the author chooses). Objects with only schema-fixed `properties` are
 * skipped. A map is checked only if it has at least one integer key, and the
 * file text is scanned for the real key order (JSON.parse already reorders)
 * only if some map has one.
 *
 * Lives inside cli/src/verify/ because the app-gitea hook build only copies
 * this directory (see validate.ts). No dependencies on purpose.
 */

type Segment = number | string
type Schema = Record<string, unknown>

export interface KeyOrderWarning {
  integerKeys: string[]
  path: string
}

/** Largest array index in JavaScript: 2^32 - 2. */
const MAX_INTEGER_KEY = 4_294_967_294

/** True for keys JavaScript moves to the front: "0", "5", "1001"; not "007", "-1", "1.5". */
export function isIntegerKey(key: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(key) && Number(key) <= MAX_INTEGER_KEY
}

const isPlainObject = (node: unknown): node is Record<string, unknown> =>
  typeof node === 'object' && node !== null && !Array.isArray(node)

/**
 * Find maps in `value` (walked with `schema`) whose key order in the file
 * would change on an app save. `readOrderedValue` returns `value` as written
 * in the file (see scanOrderedJson); it is only called when some map has an
 * integer key, so maps without one cost nothing extra.
 */
export function findMapKeyOrderWarnings(
  schema: Schema,
  value: unknown,
  readOrderedValue: () => OrderedNode | undefined,
  basePath: string,
): KeyOrderWarning[] {
  const candidates = new Map<string, Segment[]>()

  const walk = (node: unknown, nodeSchema: unknown, segments: Segment[], depth: number): void => {
    if (depth > 64) return
    const schemas = expandSchema(schema, nodeSchema)
    if (schemas.length === 0) return

    if (Array.isArray(node)) {
      for (const [index, child] of node.entries()) {
        for (const s of schemas) walk(child, itemSchema(s, index), [...segments, index], depth + 1)
      }

      return
    }

    if (!isPlainObject(node)) return

    const keys = Object.keys(node)
    if (schemas.some((s) => isMapSchema(s)) && keys.some((k) => isIntegerKey(k))) {
      candidates.set(formatPath(basePath, segments), segments)
    }

    for (const key of keys) {
      for (const s of schemas) {
        const child = propertySchema(s, key)
        if (child !== undefined) walk(node[key], child, [...segments, key], depth + 1)
      }
    }
  }

  walk(value, schema, [], 0)
  if (candidates.size === 0) return []

  const ordered = readOrderedValue()
  if (!ordered) return []

  const warnings: KeyOrderWarning[] = []
  for (const [path, segments] of candidates) {
    const node = navigate(ordered, segments)
    if (node?.kind !== 'object') continue
    const keys = node.keys
    const integerKeys = keys.filter((k) => isIntegerKey(k))
    const saved = [...integerKeys].sort((a, b) => Number(a) - Number(b))
    saved.push(...keys.filter((k) => !isIntegerKey(k)))
    if (saved.every((k, i) => k === keys[i])) continue
    warnings.push({integerKeys, path})
  }

  return warnings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

// ── Schema navigation ───────────────────────────────────────────────────

function isMapSchema(schema: Schema): boolean {
  return schema.additionalProperties === true || isPlainObject(schema.additionalProperties)
}

/** Resolve local `$ref`s and flatten allOf/anyOf/oneOf into the schemas that apply. */
function expandSchema(root: Schema, schema: unknown, seen = new Set<unknown>()): Schema[] {
  if (!isPlainObject(schema) || seen.has(schema)) return []
  seen.add(schema)
  const out: Schema[] = [schema]
  if (typeof schema.$ref === 'string') out.push(...expandSchema(root, resolveRef(root, schema.$ref), seen))
  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    const branches = schema[keyword]
    if (Array.isArray(branches)) for (const branch of branches) out.push(...expandSchema(root, branch, seen))
  }

  return out
}

function resolveRef(root: Schema, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined
  let node: unknown = root
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const part = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~')
    if (!isPlainObject(node)) return undefined
    node = node[part]
  }

  return node
}

function propertySchema(schema: Schema, key: string): unknown {
  const properties = schema.properties
  if (isPlainObject(properties) && key in properties) return properties[key]
  return isMapSchema(schema) ? schema.additionalProperties : undefined
}

function itemSchema(schema: Schema, index: number): unknown {
  if (Array.isArray(schema.prefixItems) && index < schema.prefixItems.length) return schema.prefixItems[index]
  // draft-07 tuple form
  if (Array.isArray(schema.items)) return index < schema.items.length ? schema.items[index] : schema.additionalItems
  return schema.items
}

function formatPath(base: string, segments: Segment[]): string {
  let out = base
  for (const segment of segments) out += typeof segment === 'number' ? `[${segment}]` : `.${segment}`
  return out
}

// ── Raw key order scanner ───────────────────────────────────────────────

export type OrderedNode =
  | {entries: Map<string, OrderedNode>; keys: string[]; kind: 'object'}
  | {items: OrderedNode[]; kind: 'array'}
  | {kind: 'scalar'}

export function navigate(node: OrderedNode, segments: Segment[]): OrderedNode | undefined {
  let current: OrderedNode | undefined = node
  for (const segment of segments) {
    if (current?.kind === 'object' && typeof segment === 'string') current = current.entries.get(segment)
    else if (current?.kind === 'array' && typeof segment === 'number') current = current.items[segment]
    else return undefined
  }

  return current
}

/**
 * Parse JSON text keeping each object's keys in file order. Duplicate keys
 * keep their first position, as JavaScript does. Returns undefined on text
 * that is not JSON (JSON.parse has already reported it).
 */
export function scanOrderedJson(text: string): OrderedNode | undefined {
  let pos = 0

  const skipWhitespace = (): void => {
    while (pos < text.length && ' \t\n\r'.includes(text[pos])) pos++
  }

  const readString = (): string => {
    const start = pos
    pos++ // opening quote
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === '\\' ? 2 : 1
    if (pos >= text.length) throw new Error('unterminated string')
    pos++ // closing quote
    return JSON.parse(text.slice(start, pos)) as string
  }

  const readValue = (): OrderedNode => {
    skipWhitespace()
    const ch = text[pos]
    if (ch === '{') {
      pos++
      const keys: string[] = []
      const entries = new Map<string, OrderedNode>()
      skipWhitespace()
      if (text[pos] === '}') {
        pos++
        return {entries, keys, kind: 'object'}
      }

      for (;;) {
        skipWhitespace()
        if (text[pos] !== '"') throw new Error('expected key')
        const key = readString()
        skipWhitespace()
        if (text[pos] !== ':') throw new Error('expected colon')
        pos++
        const child = readValue()
        if (!entries.has(key)) keys.push(key)
        entries.set(key, child)
        skipWhitespace()
        if (text[pos] === ',') {
          pos++
          continue
        }

        if (text[pos] === '}') {
          pos++
          return {entries, keys, kind: 'object'}
        }

        throw new Error('expected , or }')
      }
    }

    if (ch === '[') {
      pos++
      const items: OrderedNode[] = []
      skipWhitespace()
      if (text[pos] === ']') {
        pos++
        return {items, kind: 'array'}
      }

      for (;;) {
        items.push(readValue())
        skipWhitespace()
        if (text[pos] === ',') {
          pos++
          continue
        }

        if (text[pos] === ']') {
          pos++
          return {items, kind: 'array'}
        }

        throw new Error('expected , or ]')
      }
    }

    if (ch === '"') {
      readString()
      return {kind: 'scalar'}
    }

    const start = pos
    while (pos < text.length && !',}] \t\n\r'.includes(text[pos])) pos++
    if (pos === start) throw new Error('expected value')
    return {kind: 'scalar'}
  }

  try {
    const node = readValue()
    skipWhitespace()
    return pos === text.length ? node : undefined
  } catch {
    return undefined
  }
}
