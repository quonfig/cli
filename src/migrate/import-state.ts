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
