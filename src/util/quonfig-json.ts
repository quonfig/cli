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
 * The writer preserves all unknown fields, sticks to 2-space indent, and
 * always ends with a trailing newline — matching how `qfg init` and the
 * migrate flow create the file today.
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
 * If the file exists, all other fields are preserved and only `workspace`
 * is set/overwritten. If the file is missing, a minimal `{workspace: slug}`
 * file is created. Format is 2-space indent + trailing newline to match
 * the file shape produced by `qfg init` and `qfg migrate`.
 */
export async function writeWorkspaceSlug(dir: string, slug: string): Promise<void> {
  const existing = (await readQuonfigJson(dir)) ?? {}
  const next: QuonfigJson = {...existing, workspace: slug}
  const filePath = path.join(dir, QUONFIG_JSON)
  await fs.promises.writeFile(filePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
}
