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

export interface MigrationSource {
  fetchChanges(sinceEpochMs: null | number): AsyncIterable<LegacyChange>
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
