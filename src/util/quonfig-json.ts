/**
 * Reader/writer for the workspace's `quonfig.json` file.
 *
 * The `workspace` pin is stored as `<org-slug>/<workspace-slug>` (Guard 1 in
 * `project/plans/cli-git-sync.md`, multi-org form in
 * `project/plans/multi-org-cli-auth.md`). `qfg push` uses it to confirm that
 * the local dir belongs to the cloud workspace the user thinks it does.
 *
 * The reader returns `{orgSlug, workspaceSlug}` when the field is present.
 * Missing file or missing field returns `undefined`. A bare slug (no `/`)
 * throws with a migration message — bare slugs are no longer accepted.
 *
 * The writer always emits the `<org>/<ws>` form. It preserves all unknown
 * fields and, when the file already exists, does a format-stable in-place
 * edit so the diff is just the pin line. Missing or unparseable files fall
 * back to canonical 2-space JSON with a trailing newline.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const QUONFIG_JSON = 'quonfig.json'

const BARE_SLUG_MIGRATION_MESSAGE =
  'quonfig.json workspace value must be in org/workspace form (e.g. acme/foo). ' +
  'Update your quonfig.json and run `qfg login` if you have not yet migrated.'

export interface WorkspacePin {
  orgSlug: string
  workspaceSlug: string
}

/**
 * Shape of `quonfig.json`. Everything is optional from the reader's
 * perspective so a partially-written or in-flight file doesn't blow up
 * downstream consumers — `qfg verify` is the source of strict validation.
 */
export interface QuonfigJson {
  // Allow other fields so we never silently drop unknown keys on rewrite.
  [key: string]: unknown
  environments?: string[]
  /** `<org-slug>/<workspace-slug>` pin string. */
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
 * Parse a `<org-slug>/<workspace-slug>` pin string. Throws with the migration
 * message when the value is bare or malformed (empty parts, extra slashes).
 */
function parsePinString(raw: string): WorkspacePin {
  const parsed = tryParseWorkspacePin(raw)
  if (!parsed) throw new Error(BARE_SLUG_MIGRATION_MESSAGE)
  return parsed
}

/**
 * Non-throwing variant of `parsePinString`. Returns `undefined` when `raw`
 * isn't in `<org>/<ws>` form (e.g. a bare slug from a transitional backend
 * response). Callers that want the migration error should use
 * `readWorkspaceSlug` instead.
 */
export function tryParseWorkspacePin(raw: string): WorkspacePin | undefined {
  const parts = raw.split('/')
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) return undefined
  return {orgSlug: parts[0]!, workspaceSlug: parts[1]!}
}

/**
 * Read the workspace pin from `<dir>/quonfig.json`.
 *
 * Returns `undefined` when the file is missing OR when the `workspace`
 * field is absent OR when the field is present but not a string. Throws
 * when the file is malformed JSON, OR when the workspace value is a bare
 * slug (no `/`) — bare slugs are rejected with a migration message.
 */
export async function readWorkspaceSlug(dir: string): Promise<WorkspacePin | undefined> {
  const parsed = await readQuonfigJson(dir)
  if (!parsed) return undefined
  const slug = parsed.workspace
  if (typeof slug !== 'string') return undefined
  return parsePinString(slug)
}

/**
 * Write the workspace pin into `<dir>/quonfig.json`, always in the
 * `<org-slug>/<workspace-slug>` form.
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
 *
 * Throws when either component is empty or contains a `/` — bare slugs
 * are not accepted on the write path.
 */
export async function writeWorkspaceSlug(dir: string, pin: WorkspacePin): Promise<void> {
  const slug = formatPin(pin)
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

function formatPin(pin: WorkspacePin): string {
  if (
    pin.orgSlug.length === 0 ||
    pin.workspaceSlug.length === 0 ||
    pin.orgSlug.includes('/') ||
    pin.workspaceSlug.includes('/')
  ) {
    throw new Error(
      `Invalid workspace pin: orgSlug=${JSON.stringify(pin.orgSlug)}, workspaceSlug=${JSON.stringify(
        pin.workspaceSlug,
      )}. Both parts must be non-empty and must not contain '/'.`,
    )
  }

  return `${pin.orgSlug}/${pin.workspaceSlug}`
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
  const indentMatch = raw.match(/\n([\t ]+)"/)
  const indent = indentMatch ? indentMatch[1] : '  '

  // If the original used a multi-line object (closing brace on its own
  // line), keep that shape. Otherwise the original was a single-line
  // object like `{}` or `{"k":v}` — emit on one line.
  const isMultiline = /\n\s*}\s*$/.test(raw) || /\n/.test(raw.slice(0, closingIdx))

  let insertion: string
  if (isMultiline) {
    insertion = hasOtherKeys ? `,\n${indent}"workspace": ${slugJson}` : `\n${indent}"workspace": ${slugJson}`
  } else {
    insertion = hasOtherKeys ? `, "workspace": ${slugJson}` : `"workspace": ${slugJson}`
  }

  return before + insertion + after
}
