/**
 * Reader/writer for the workspace's `quonfig.json` file.
 *
 * Today the file is `{ environments: string[] }`. We are adding an optional
 * `workspace: "<slug>"` pin (Guard 1 in `project/plans/cli-git-sync.md`)
 * so commands like `qfg push` can confirm that the local dir belongs to the
 * cloud workspace they think it does.
 *
 * The reader is permissive: missing file or missing field returns `undefined`
 * (no throw). It only throws when the file exists but cannot be parsed.
 *
 * The writer preserves all unknown fields. When updating an existing file
 * it does a format-stable in-place edit: only the `workspace` key's bytes
 * change, so unrelated formatting (single-line arrays, custom indent, etc.)
 * is preserved and the resulting git diff is just the pin line. When the
 * file is missing or unparseable, it falls back to canonical 2-space JSON
 * with a trailing newline — matching how `qfg init` creates the file.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const QUONFIG_JSON = 'quonfig.json'

/**
 * Shape of `quonfig.json`. Everything is optional from the reader's
 * perspective so a partially-written or in-flight file doesn't blow up
 * downstream consumers — `qfg verify` is the source of strict validation.
 */
export interface QuonfigJson {
  // Allow other fields so we never silently drop unknown keys on rewrite.
  [key: string]: unknown
  environments?: string[]
  /** Workspace slug (human-readable, not the UUID). Used as the repo pin. */
  workspace?: string
}

async function readQuonfigJson(dir: string): Promise<QuonfigJson | undefined> {
  const filePath = path.join(dir, QUONFIG_JSON)
  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  // JSON.parse will throw on malformed JSON — that's the documented behavior.
  const parsed = JSON.parse(raw) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${QUONFIG_JSON} must be a JSON object`)
  }

  return parsed as QuonfigJson
}

/**
 * Read the workspace slug pin from `<dir>/quonfig.json`.
 *
 * Returns `undefined` when the file is missing OR when the `workspace`
 * field is absent OR when the field is present but not a string.
 * Throws only when the file exists but contains malformed JSON, since
 * that is a real bug a caller should surface.
 */
export async function readWorkspaceSlug(dir: string): Promise<string | undefined> {
  const parsed = await readQuonfigJson(dir)
  if (!parsed) return undefined
  const slug = parsed.workspace
  return typeof slug === 'string' ? slug : undefined
}

/**
 * Write the workspace slug pin into `<dir>/quonfig.json`.
 *
 * If the file exists and is parseable, the existing bytes are preserved
 * verbatim except for the `workspace` key — either its value is replaced
 * in place, or the new key is inserted just before the closing brace
 * using the file's existing indentation. This keeps the git diff to the
 * single pin line on first backfill (no reflow of `environments` or
 * unrelated formatting).
 *
 * If the file is missing or cannot be parsed, fall back to a canonical
 * 2-space JSON write with a trailing newline.
 */
export async function writeWorkspaceSlug(dir: string, slug: string): Promise<void> {
  const filePath = path.join(dir, QUONFIG_JSON)

  let raw: string | undefined
  try {
    raw = await fs.promises.readFile(filePath, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (raw !== undefined) {
    const updated = upsertWorkspaceKey(raw, slug)
    if (updated !== undefined) {
      await fs.promises.writeFile(filePath, updated, 'utf8')
      return
    }
  }

  // Fallback: file missing, or existing file is unparseable / has a
  // shape we can't safely edit in place. Write canonical JSON.
  const existing = (raw === undefined ? undefined : safeParse(raw)) ?? {}
  const next: QuonfigJson = {...existing, workspace: slug}
  await fs.promises.writeFile(filePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

function safeParse(raw: string): QuonfigJson | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as QuonfigJson
  } catch {
    return undefined
  }
}

/**
 * Format-stable in-place edit of `quonfig.json`.
 *
 * Returns the new file bytes, or `undefined` if the input isn't a shape we
 * can safely edit (malformed JSON, non-object root, or no closing brace
 * found). Caller should fall back to a canonical write in that case.
 *
 * Two cases:
 * 1. `workspace` key already present (with a string value) → replace just
 *    the value bytes via regex. Diff is one token.
 * 2. `workspace` key absent → splice a new key before the closing brace,
 *    using indentation detected from the first existing key (or 2-space
 *    default for an empty object). Other keys are untouched.
 */
export function upsertWorkspaceKey(raw: string, slug: string): string | undefined {
  const parsed = safeParse(raw)
  if (parsed === undefined) return undefined

  const slugJson = JSON.stringify(slug)

  if (typeof parsed.workspace === 'string') {
    // Replace the existing string value. The regex tolerates whitespace
    // around the colon and any escaped chars in the current value.
    const re = /("workspace"\s*:\s*)"(?:[^"\\]|\\.)*"/
    if (!re.test(raw)) return undefined
    return raw.replace(re, `$1${slugJson}`)
  }

  // Insert a new key. Find the closing brace and walk back over trailing
  // whitespace to locate the end of the last value (if any).
  const closingIdx = raw.lastIndexOf('}')
  if (closingIdx === -1) return undefined

  let endOfLastValue = closingIdx - 1
  while (endOfLastValue >= 0 && /\s/.test(raw[endOfLastValue]!)) endOfLastValue--

  const before = raw.slice(0, endOfLastValue + 1)
  const after = raw.slice(endOfLastValue + 1)

  const hasOtherKeys = Object.keys(parsed).length > 0

  // Detect indent from the first nested key. Default to two spaces.
  const indentMatch = raw.match(/\n([ \t]+)"/)
  const indent = indentMatch ? indentMatch[1] : '  '

  // If the original used a multi-line object (closing brace on its own
  // line), keep that shape. Otherwise the original was a single-line
  // object like `{}` or `{"k":v}` — emit on one line.
  const isMultiline = /\n\s*\}\s*$/.test(raw) || /\n/.test(raw.slice(0, closingIdx))

  let insertion: string
  if (isMultiline) {
    insertion = hasOtherKeys ? `,\n${indent}"workspace": ${slugJson}` : `\n${indent}"workspace": ${slugJson}`
  } else {
    insertion = hasOtherKeys ? `, "workspace": ${slugJson}` : `"workspace": ${slugJson}`
  }

  return before + insertion + after
}
