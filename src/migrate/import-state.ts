import fs from 'node:fs'
import path from 'node:path'

export interface ImportState {
  lastProcessedAt?: number | string
  source: string
  sourceWorkspaceId?: string
}

export class CrossSourceError extends Error {
  readonly requestedSource: string
  readonly storedSource: string

  constructor(storedSource: string, requestedSource: string) {
    super(
      `This directory was migrated from ${storedSource}. ` +
        `Pass --from ${storedSource} or use --reset to reimport from scratch ` +
        `(requested --from ${requestedSource}).`,
    )
    this.name = 'CrossSourceError'
    this.storedSource = storedSource
    this.requestedSource = requestedSource
  }
}

function importStatePath(outputDir: string): string {
  return path.join(outputDir, '.qf', 'import-state.json')
}

export function writeImportState(outputDir: string, state: ImportState): void {
  const filePath = importStatePath(outputDir)
  fs.mkdirSync(path.dirname(filePath), {recursive: true})

  const serialized: ImportState = {source: state.source}
  if (state.lastProcessedAt !== undefined) serialized.lastProcessedAt = state.lastProcessedAt
  if (state.sourceWorkspaceId !== undefined) serialized.sourceWorkspaceId = state.sourceWorkspaceId

  fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2) + '\n', 'utf8')
}

export function readImportState(outputDir: string): ImportState | null {
  const filePath = importStatePath(outputDir)
  if (!fs.existsSync(filePath)) return null
  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<ImportState>
  if (typeof parsed.source !== 'string' || parsed.source.length === 0) return null
  return parsed as ImportState
}

/**
 * `.qf/key-plan.json` — the COMPLETE source->final key mapping (unchanged keys
 * included) for every key any previous run has planned. Unlike
 * `.qf/key-map.json` (the customer-facing, rewrites-only report artifact for
 * ONE run), this file is migrator bookkeeping: a delta run replans over only
 * the subset of changes it fetched, so without the full-run plan a key that
 * resolved to `my-flag-2` (because `my-flag` also existed) would replan to
 * `my-flag` and silently overwrite a different flag's file. Persisting the
 * complete map makes full and delta runs resolve identically — and freezes
 * mappings across future sanitizer-rule changes. Lives next to
 * import-state.json under `.qf/` (committed to the workspace repo, excluded
 * from `qfg push`'s allow-listed mirror like the rest of the dotdir).
 */
interface KeyPlanFile {
  keys: Record<string, string>
  version: 1
}

function keyPlanPath(outputDir: string): string {
  return path.join(outputDir, '.qf', 'key-plan.json')
}

export function writeKeyPlan(outputDir: string, keys: Record<string, string>): void {
  const filePath = keyPlanPath(outputDir)
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  const sorted: Record<string, string> = {}
  for (const source of Object.keys(keys).sort()) sorted[source] = keys[source]
  const serialized: KeyPlanFile = {keys: sorted, version: 1}
  fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2) + '\n', 'utf8')
}

/** The persisted plan, or null when absent/unreadable (treat as first run). */
export function readKeyPlan(outputDir: string): null | Record<string, string> {
  const filePath = keyPlanPath(outputDir)
  if (!fs.existsSync(filePath)) return null
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<KeyPlanFile>
    if (typeof parsed?.keys !== 'object' || parsed.keys === null || Array.isArray(parsed.keys)) return null
    const out: Record<string, string> = {}
    for (const [source, final] of Object.entries(parsed.keys)) {
      if (typeof final === 'string') out[source] = final
    }

    return out
  } catch {
    return null
  }
}

export function assertSourceMatches(outputDir: string, requestedSource: string): void {
  const state = readImportState(outputDir)
  if (!state) return
  if (state.source === requestedSource) return
  throw new CrossSourceError(state.source, requestedSource)
}

export function removeQfFromGitignore(outputDir: string): void {
  const gitignorePath = path.join(outputDir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) return

  const original = fs.readFileSync(gitignorePath, 'utf8')
  const trailingNewline = original.endsWith('\n')
  const filtered = original
    .split('\n')
    .filter((line) => line.trim() !== '.qf' && line.trim() !== '.qf/')
    .join('\n')

  const next = trailingNewline && !filtered.endsWith('\n') && filtered.length > 0 ? filtered + '\n' : filtered
  if (next === original) return

  fs.writeFileSync(gitignorePath, next, 'utf8')
}
