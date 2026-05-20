import type {ConversionNote} from './quonfig-target/report.js'

export interface LegacyChange {
  changedAt?: number
  key?: string
  raw: unknown
  source: string
}

export interface QuonfigFile {
  /** File contents when writing. Ignored when deleted is true. */
  contents?: string
  /** When true, the file at `path` should be removed (tombstone). Default false. */
  deleted?: boolean
  path: string
}

/**
 * One row of the "Environment mapping table" in MIGRATION_REPORT.md. Sources
 * implement `getEnvironmentMap()` to expose the source-name → Quonfig-name
 * pairs they translated; the report renderer just formats the rows.
 */
export interface EnvironmentMapEntry {
  /** The Quonfig-side environment name (slugified key). */
  quonfigName: string
  /** The user-facing source-system name (e.g. LD env display name). */
  sourceName: string
}

export interface DroppedOverrideSummary {
  /** Per-envId → per-output-path count of dropped override sections. */
  byEnv: Record<string, Record<string, number>>
  /** Total override sections dropped across every env + flag. */
  total: number
}

/**
 * qfg-gpnd: Per-config tally of rule values that were coerced from a Launch
 * "no value set yet" sentinel ({type:'string', value:''}) to the typed default
 * because the surrounding config valueType was non-string. Tracking is per
 * envId (or 'default' for the default section) so customers can see which
 * environments were affected.
 */
export interface CoercedSentinelSummary {
  /** Per-envId → per-output-path count of coerced sentinel rule values. */
  byEnv: Record<string, Record<string, number>>
  /** Total rule values coerced across every env + config. */
  total: number
}

export interface SkippedConfigEntry {
  /** Source key (pre-translate) that was skipped. */
  key: string
  /** Human-readable reason (e.g. variant/valueType mismatch). */
  reason: string
}

export interface SkippedConfigSummary {
  /** Individual skip records, in insertion order. */
  entries: SkippedConfigEntry[]
  /** Total configs skipped. */
  total: number
}

export interface DuplicateResolution {
  /** All types that collided for this key (e.g. ['config', 'feature_flag']). */
  collisionTypes: string[]
  /** Paths that were deleted to resolve the collision. */
  deleted: string[]
  /** The path that was kept as the winning type. */
  kept: string
  /** The qfg key that collided across types. */
  key: string
}

export interface DuplicateResolutionSummary {
  entries: DuplicateResolution[]
  total: number
}

/**
 * qfg-wbkj: Per-change commit metadata for --full-summary mode. Sources that
 * carry author + timestamp + summary per change (e.g. Launch's change-history)
 * implement getCommitMeta() so push-to-cloud can author one git commit per
 * change with the original Launch user as author and `changedAt` as
 * GIT_AUTHOR_DATE. Sources without this method are rejected at the command
 * layer when --full-summary is passed.
 */
export interface CommitMeta {
  author: {email: string; name: string}
  /** Author date — any value `new Date(...)` accepts (Date, ISO string, or epoch ms). */
  date: Date | number | string
  /** Non-empty commit message. Empty source-side summaries must be replaced with a fallback by the source. */
  message: string
}

export interface MigrationSource {
  /**
   * Yields the source's change history oldest→newest. `onProgress`, when
   * provided, is called with the running fetched-change count as pagination
   * proceeds, so the CLI can show progress during an otherwise-silent fetch.
   * Sources that fetch in a single request may ignore it.
   */
  fetchChanges(sinceEpochMs: null | number, onProgress?: (fetched: number) => void): AsyncIterable<LegacyChange>
  /**
   * Optional post-translate accumulator. Returns any rule values that translate()
   * coerced from a sentinel like Launch's empty-string "no value set yet" to the
   * typed default. Null when nothing was coerced.
   */
  getCoercedSentinels?(): CoercedSentinelSummary | null
  /**
   * Optional. qfg-wbkj: per-change commit metadata used by --full-summary. Returns
   * null if the change carries no usable author/date/summary (e.g. legacy or
   * synthesized entries) and the caller should fall back to the migrator identity.
   */
  getCommitMeta?(change: LegacyChange): CommitMeta | null
  /**
   * Optional post-translate accumulator. Returns the structured conversion notes
   * collected during translate() — re-bucketed rollouts, dropped prerequisites,
   * lossy individual-target conversions, etc. (the LaunchDarkly converter set).
   * The write paths thread these into MIGRATION_REPORT.md's "Users will be
   * re-bucketed" + "Conversion notes" sections. Null or empty when nothing
   * notable happened during conversion.
   */
  getConversionNotes?(): ConversionNote[] | null
  /**
   * Optional post-translate accumulator. Returns any override sections that were
   * dropped during translate() calls because the env.id was not present in the
   * source's env map (e.g. archived/deleted Reforge envs). Returns null if nothing
   * was dropped. Callers should consume + surface this before writing the migration
   * report so customers can review the loss.
   */
  getDroppedOverrides?(): DroppedOverrideSummary | null
  /**
   * qfg-1t7m: source-name → Quonfig-name pairs for the "Environment mapping table"
   * section of MIGRATION_REPORT.md. Returns the rows the source actually
   * translated this run; callers thread these into report data. Sources that
   * don't expose user-facing env names omit this and the table renders `_(none)_`.
   */
  getEnvironmentMap?(): EnvironmentMapEntry[] | null
  /**
   * qfg-l8uz: maintainerId → email pairs for the report's "Identifier map"
   * section. Sources that fetch a member directory (e.g. LD's /members) expose
   * the lookup here so the report renderer can swap opaque IDs for readable
   * emails and decorate the `dropped-maintainer` rollup. Null when the source
   * couldn't fetch members (auth scope, hidden member data) or has none to
   * surface — the rest of the report still renders.
   */
  getMaintainerMap?(): null | Record<string, string>
  /**
   * Optional post-translate accumulator. Returns any configs that translate() soft-
   * skipped due to invalid source data (e.g. variant/valueType mismatch). Null when
   * nothing was skipped.
   */
  getSkippedConfigs?(): SkippedConfigSummary | null
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
