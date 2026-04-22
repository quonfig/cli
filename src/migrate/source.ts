export interface LegacyChange {
  changedAt?: number
  key?: string
  raw: unknown
  source: string
}

export interface QuonfigFile {
  contents: string
  path: string
}

export interface DroppedOverrideSummary {
  /** Per-envId → per-output-path count of dropped override sections. */
  byEnv: Record<string, Record<string, number>>
  /** Total override sections dropped across every env + flag. */
  total: number
}

export interface MigrationSource {
  fetchChanges(sinceEpochMs: null | number): AsyncIterable<LegacyChange>
  /**
   * Optional post-translate accumulator. Returns any override sections that were
   * dropped during translate() calls because the env.id was not present in the
   * source's env map (e.g. archived/deleted Reforge envs). Returns null if nothing
   * was dropped. Callers should consume + surface this before writing the migration
   * report so customers can review the loss.
   */
  getDroppedOverrides?(): DroppedOverrideSummary | null
  listEnvironments(): Promise<string[]>
  name: string
  translate(change: LegacyChange): QuonfigFile[]
  validateAuth(apiKey: string): Promise<void>
}

export class NotYetImplementedError extends Error {
  public readonly issueUrl: string
  public readonly sourceName: string

  constructor(sourceName: string, operation: string) {
    const issueUrl = `https://github.com/quonfig/cli/issues/new?title=qfg+migrate+--from+${encodeURIComponent(sourceName)}`
    super(
      `qfg migrate --from ${sourceName} is not yet implemented (${operation}). ` +
        `File a bead to prioritize this source: ${issueUrl}`,
    )
    this.name = 'NotYetImplementedError'
    this.sourceName = sourceName
    this.issueUrl = issueUrl
  }
}
