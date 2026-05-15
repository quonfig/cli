import * as fs from 'node:fs'
import * as path from 'node:path'

import {type ImportState, removeQfFromGitignore, writeImportState} from './import-state.js'
import {type MigrationReportData, writeMigrationReport} from './migration-report.js'
import {detectDuplicateKeys} from './sources/launch/translate.js'
import {type CommitSpec, MIGRATOR_IDENTITY, type PushIdentity, stackCommits} from '../util/clone-and-stack-push.js'
import {runGit, spawnGit} from '../util/git-ops.js'
import type {
  CoercedSentinelSummary,
  DroppedOverrideSummary,
  DuplicateResolution,
  DuplicateResolutionSummary,
  LegacyChange,
  MigrationSource,
  SkippedConfigSummary,
} from './source.js'

export interface ApplyLocalMigrationOptions {
  /** Commit author. Defaults to the migrator identity. */
  author?: PushIdentity
  /** Initial branch name when initializing a fresh repo. Defaults to `main`. */
  branch?: string
  changes: LegacyChange[]
  /** Environments discovered from the source (slugified). Written to `quonfig.json` if missing. */
  environments: string[]
  /**
   * qfg-wbkj: when true, produce one git commit per change (audit-log mode) +
   * one final state-file commit on top. Requires `source.getCommitMeta` to be
   * defined. See pushMigrationToCloud's matching option.
   */
  fullHistory?: boolean
  importState: ImportState
  localDir: string
  /**
   * Base report data. The migrator overrides `counts` after writing files,
   * since counts must reflect what was actually written to disk (qfg-7eig).
   */
  reportData: MigrationReportData
  source: MigrationSource
}

export interface ApplyLocalMigrationResult {
  /** `'initialized'` if we had to `git init` the target, `'reused'` if it was already a repo. */
  action: 'initialized' | 'reused'
  /** Sentinel rule values coerced to typed defaults during translate. Null if none. */
  coercedSentinels: CoercedSentinelSummary | null
  commitSha: string | null
  /** `false` if translate produced no net changes — nothing was committed. */
  committed: boolean
  /** Override sections dropped during translate because env.id was unknown. Null if none. */
  droppedOverrides: DroppedOverrideSummary | null
  /** Cross-type key collisions resolved by preferring the config side. Null if none. */
  duplicateResolutions: DuplicateResolutionSummary | null
  /** Configs soft-skipped during translate due to invalid source data. Null if none. */
  skippedConfigs: SkippedConfigSummary | null
}

/**
 * True only when `dir` is itself the root of a git repo. `rev-parse --git-dir`
 * walks UP the filesystem, so a plain `rev-parse` check returns true for any
 * subdir of any ancestor repo — and the migrator then commits into that
 * ancestor instead of `git init`-ing a fresh repo at `dir`. Match
 * `--show-toplevel` against `dir` to scope the check, comparing canonical
 * (realpath-resolved) paths so a symlinked `dir` (e.g. macOS `/var/folders` →
 * `/private/var/folders`) still matches git's canonicalized toplevel
 * (qfg-wu85).
 */
const isGitRepo = async (dir: string): Promise<boolean> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'rev-parse', '--show-toplevel'])
    return fs.realpathSync(stdout.trim()) === fs.realpathSync(dir)
  } catch {
    return false
  }
}

const hasStagedChanges = async (dir: string): Promise<boolean> => {
  const {stdout} = await runGit(['-C', dir, 'status', '--porcelain'])
  return stdout.trim().length > 0
}

const ensureQuonfigJson = (dir: string, environments: string[]): void => {
  const filePath = path.join(dir, 'quonfig.json')
  if (fs.existsSync(filePath)) return
  const sorted = [...new Set(environments)].sort()
  fs.writeFileSync(filePath, JSON.stringify({environments: sorted}, null, 2) + '\n', 'utf8')
}

const ensureLocalRepo = async (localDir: string, branch: string): Promise<'initialized' | 'reused'> => {
  fs.mkdirSync(localDir, {recursive: true})
  if (await isGitRepo(localDir)) return 'reused'
  await runGit(['init', `--initial-branch=${branch}`, localDir])
  return 'initialized'
}

export class MigratorKeyCollisionError extends Error {
  constructor(
    public readonly destPath: string,
    public readonly firstSourceKey: string,
    public readonly secondSourceKey: string,
  ) {
    super(
      `Two source keys collide on destination ${destPath} after key normalization: ` +
        `"${firstSourceKey}" and "${secondSourceKey}". Quonfig keys must be globally unique within a type tree. ` +
        `Rename one in the source system and re-run.`,
    )
    this.name = 'MigratorKeyCollisionError'
  }
}

const ensureNoNestedPath = (relativePath: string): void => {
  // qfg-qhk1: every output must be exactly `<type-dir>/<flat-key>.json` —
  // never nested. If we ever emit a nested path, refuse to write so we surface
  // it loudly rather than silently producing dirs that lose the flat-file
  // contract (and break tombstone cleanup on subsequent runs).
  const parts = relativePath.split('/')
  if (parts.length !== 2) {
    throw new Error(
      `Migrator refusing to write nested path "${relativePath}" — outputs must be flat <type-dir>/<key>.json. ` +
        `This is a bug in the source's translate() — it should normalize key separators before computing the path.`,
    )
  }
}

const rmdirIfEmpty = (dir: string): void => {
  try {
    fs.rmdirSync(dir)
  } catch (error) {
    const e = error as NodeJS.ErrnoException
    // ENOTEMPTY: still has contents (expected, leave alone). ENOENT: already gone.
    if (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') throw error
  }
}

export const writeQuonfigFiles = (
  dir: string,
  changes: LegacyChange[],
  source: MigrationSource,
): WriteQuonfigFilesResult => {
  const livePaths = new Map<string, true>()
  // qfg-qhk1: track which source key wrote each destination path. If a second,
  // different source key tries to write to the same destination, that is a
  // post-normalization collision (e.g. source had keys `foo/bar` and `foo.bar`,
  // both normalize to `foo.bar`). Throw with a clear message.
  const pathOwners = new Map<string, string>()
  for (const change of changes) {
    const files = source.translate(change)
    const sourceKey = change.key ?? '(unknown)'
    for (const file of files) {
      ensureNoNestedPath(file.path)
      const full = path.join(dir, file.path)
      if (file.deleted) {
        try {
          fs.unlinkSync(full)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }

        livePaths.delete(file.path)
        pathOwners.delete(file.path)
        // qfg-qhk1: clean up any empty parent dirs left over from prior runs
        // that wrote under a nested layout. (New runs never create nested
        // dirs because of normalizeKey + ensureNoNestedPath, but stale dirs
        // from older versions on disk would otherwise persist.)
        rmdirIfEmpty(path.dirname(full))
      } else {
        if (file.contents === undefined) {
          throw new Error(`translate() emitted a write op for ${file.path} without contents`)
        }

        const existingOwner = pathOwners.get(file.path)
        if (existingOwner !== undefined && existingOwner !== sourceKey) {
          throw new MigratorKeyCollisionError(file.path, existingOwner, sourceKey)
        }

        fs.mkdirSync(path.dirname(full), {recursive: true})
        fs.writeFileSync(full, file.contents)
        livePaths.set(file.path, true)
        pathOwners.set(file.path, sourceKey)
      }
    }
  }

  const resolutions = detectDuplicateKeys([...livePaths.keys()].map((p) => ({path: p})))
  for (const resolution of resolutions) {
    for (const toDelete of resolution.deleted) {
      try {
        fs.unlinkSync(path.join(dir, toDelete))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }

      livePaths.delete(toDelete)
    }
  }

  return {livePaths: [...livePaths.keys()], resolutions}
}

interface WriteQuonfigFilesResult {
  livePaths: string[]
  resolutions: DuplicateResolution[]
}

const countsFromLivePaths = (
  livePaths: string[],
): {
  configsMigrated: number
  flagsMigrated: number
  logLevelsMigrated: number
  schemasMigrated: number
  segmentsMigrated: number
} => {
  let flagsMigrated = 0
  let configsMigrated = 0
  let segmentsMigrated = 0
  let schemasMigrated = 0
  let logLevelsMigrated = 0
  for (const p of livePaths) {
    if (p.startsWith('feature-flags/')) flagsMigrated++
    else if (p.startsWith('configs/')) configsMigrated++
    else if (p.startsWith('segments/')) segmentsMigrated++
    else if (p.startsWith('schemas/')) schemasMigrated++
    else if (p.startsWith('log-levels/')) logLevelsMigrated++
  }

  return {configsMigrated, flagsMigrated, logLevelsMigrated, schemasMigrated, segmentsMigrated}
}

export const buildMigrationCounts = (
  livePaths: string[],
  environmentsMapped: number,
  itemsSkipped: number,
): import('./migration-report.js').MigrationReportCounts => ({
  ...countsFromLivePaths(livePaths),
  environmentsMapped,
  itemsSkipped,
})

export const buildMigrationCommitMessage = (
  source: string,
  counts: import('./migration-report.js').MigrationReportCounts,
): string => {
  const parts: string[] = []
  if (counts.flagsMigrated > 0) parts.push(`${counts.flagsMigrated} flag(s)`)
  if (counts.configsMigrated > 0) parts.push(`${counts.configsMigrated} config(s)`)
  if (counts.segmentsMigrated > 0) parts.push(`${counts.segmentsMigrated} segment(s)`)
  if (counts.schemasMigrated > 0) parts.push(`${counts.schemasMigrated} schema(s)`)
  if (counts.logLevelsMigrated > 0) parts.push(`${counts.logLevelsMigrated} log-level(s)`)
  const summary = parts.length === 0 ? 'no objects' : parts.join(', ')
  return `migrator: imported ${summary} from ${source}`
}

export const applyLocalMigration = async (opts: ApplyLocalMigrationOptions): Promise<ApplyLocalMigrationResult> => {
  const branch = opts.branch ?? 'main'
  const author = opts.author ?? MIGRATOR_IDENTITY

  if (opts.fullHistory && !opts.source.getCommitMeta) {
    throw new Error(
      `--full-summary requires the source to provide per-change author + date + summary, but \`${opts.source.name}\` does not. ` +
        `Drop --full-summary or use a source (e.g. launch) that supports it.`,
    )
  }

  const action = await ensureLocalRepo(opts.localDir, branch)

  await runGit(['-C', opts.localDir, 'config', 'user.name', author.name])
  await runGit(['-C', opts.localDir, 'config', 'user.email', author.email])

  if (opts.fullHistory) {
    return runFullHistoryLocal(opts, action)
  }

  ensureQuonfigJson(opts.localDir, opts.environments)
  const {livePaths, resolutions: resolutionEntries} = writeQuonfigFiles(opts.localDir, opts.changes, opts.source)
  removeQfFromGitignore(opts.localDir)
  writeImportState(opts.localDir, opts.importState)

  const droppedOverrides = opts.source.getDroppedOverrides?.() ?? null
  const skippedConfigs = opts.source.getSkippedConfigs?.() ?? null
  const coercedSentinels = opts.source.getCoercedSentinels?.() ?? null
  const conversionNotes = opts.source.getConversionNotes?.() ?? null
  const duplicateResolutions: DuplicateResolutionSummary | null =
    resolutionEntries.length > 0 ? {entries: resolutionEntries, total: resolutionEntries.length} : null
  const skippedTotal = (skippedConfigs?.total ?? 0) + resolutionEntries.reduce((sum, r) => sum + r.deleted.length, 0)
  const counts = buildMigrationCounts(livePaths, opts.environments.length, skippedTotal)
  const reportData: MigrationReportData = {
    ...opts.reportData,
    counts,
    ...(coercedSentinels ? {coercedSentinels} : {}),
    ...(conversionNotes && conversionNotes.length > 0 ? {conversionNotes} : {}),
    ...(droppedOverrides ? {droppedOverrides} : {}),
    ...(duplicateResolutions ? {duplicateResolutions} : {}),
    ...(skippedConfigs ? {skippedConfigs} : {}),
  }
  writeMigrationReport(opts.localDir, reportData)

  await runGit(['-C', opts.localDir, 'add', '--all'])

  if (!(await hasStagedChanges(opts.localDir))) {
    return {
      action,
      coercedSentinels,
      committed: false,
      commitSha: null,
      droppedOverrides,
      duplicateResolutions,
      skippedConfigs,
    }
  }

  const commitMessage = buildMigrationCommitMessage(opts.source.name, counts)
  await spawnGit(['-C', opts.localDir, 'commit', '-F', '-'], {
    stdin: commitMessage,
    env: {
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
    },
  })

  const {stdout: sha} = await runGit(['-C', opts.localDir, 'rev-parse', 'HEAD'])
  return {
    action,
    coercedSentinels,
    commitSha: sha.trim(),
    committed: true,
    droppedOverrides,
    duplicateResolutions,
    skippedConfigs,
  }
}

const runFullHistoryLocal = async (
  opts: ApplyLocalMigrationOptions,
  action: 'initialized' | 'reused',
): Promise<ApplyLocalMigrationResult> => {
  ensureQuonfigJson(opts.localDir, opts.environments)

  const acc: AuditAccumulator = {
    coercedSentinels: null,
    droppedOverrides: null,
    duplicateResolutions: null,
    skippedConfigs: null,
  }

  const commits: CommitSpec[] = [
    ...buildAuditPerChangeCommits(opts.changes, opts.source),
    buildAuditFinalCommit({
      changes: opts.changes,
      environments: opts.environments,
      importState: opts.importState,
      onAccumulatorUpdate: (a) => Object.assign(acc, a),
      reportData: opts.reportData,
      source: opts.source,
    }),
  ]

  const {commitShas} = await stackCommits(opts.localDir, commits)

  return {
    action,
    coercedSentinels: acc.coercedSentinels,
    commitSha: commitShas.at(-1) ?? null,
    committed: commitShas.length > 0,
    droppedOverrides: acc.droppedOverrides,
    duplicateResolutions: acc.duplicateResolutions,
    skippedConfigs: acc.skippedConfigs,
  }
}

/**
 * qfg-wbkj: accumulator for source-level summaries that the final state-file
 * commit collects from the source after all per-change commits have run.
 * Used by both push-to-cloud and local-write to surface back to callers.
 */
export interface AuditAccumulator {
  coercedSentinels: CoercedSentinelSummary | null
  droppedOverrides: DroppedOverrideSummary | null
  duplicateResolutions: DuplicateResolutionSummary | null
  skippedConfigs: SkippedConfigSummary | null
}

/**
 * qfg-wbkj: build one CommitSpec per change, each carrying the original
 * source-side author/date/message when `getCommitMeta` returns metadata. Used
 * by `--full-summary` from both the local-write and push-to-cloud paths.
 */
export const buildAuditPerChangeCommits = (changes: LegacyChange[], source: MigrationSource): CommitSpec[] =>
  changes.map((change, index) => {
    const meta = source.getCommitMeta?.(change) ?? null
    const apply = async (dir: string): Promise<void> => {
      writeQuonfigFiles(dir, [change], source)
    }

    if (!meta) {
      return {
        apply,
        author: MIGRATOR_IDENTITY,
        message: `migrator: imported change ${index + 1} of ${changes.length} from ${source.name}`,
      }
    }

    return {apply, author: meta.author, authorDate: meta.date, message: meta.message}
  })

export interface BuildAuditFinalCommitOptions {
  changes: LegacyChange[]
  environments: string[]
  importState: ImportState
  /** Receives the accumulated summaries once the commit's apply() has run. */
  onAccumulatorUpdate?: (acc: AuditAccumulator) => void
  /**
   * Optional hook to run AFTER writeImportState + writeMigrationReport but before
   * the commit lands. Push-to-cloud uses this to run validateWorkspace (and to
   * merge source-side environments into the existing quonfig.json). Throwing here
   * aborts the commit cleanly.
   */
  postWrite?: (dir: string) => Promise<void> | void
  /**
   * Optional hook to run BEFORE bookkeeping (state file + report). Push-to-cloud
   * uses this to merge source-side environments into the cloned quonfig.json.
   */
  preWrite?: (dir: string) => Promise<void> | void
  reportData: MigrationReportData
  source: MigrationSource
}

/**
 * qfg-wbkj: build the final state-file commit for audit-log mode. Writes
 * `.qf/import-state.json` + `MIGRATION_REPORT.md` with cumulative counts read
 * from disk, and surfaces the source's accumulated dropped/skipped/coerced
 * summaries via `onAccumulatorUpdate`. The `preWrite` / `postWrite` hooks let
 * push-to-cloud merge environments and run server-side-equivalent validation
 * without local-write needing to know about either.
 */
export const buildAuditFinalCommit = (opts: BuildAuditFinalCommitOptions): CommitSpec => ({
  async apply(dir) {
    if (opts.preWrite) await opts.preWrite(dir)

    // qfg-wbkj follow-up: in audit-log mode, writeQuonfigFiles runs per-change
    // and cannot detect cross-change duplicate keys (e.g. the same key existing
    // as both a config and a feature_flag in source history). Resolve here over
    // the cumulative on-disk tree — same kept/deleted semantics as the
    // collapsed path — so validateWorkspace doesn't reject the push. The
    // deletion lands in this final state-file commit under migrator identity,
    // not in any audit commit.
    const initialPaths = collectLivePathsOnDisk(dir)
    const resolutionEntries = detectDuplicateKeys(initialPaths.map((p) => ({path: p})))
    for (const resolution of resolutionEntries) {
      for (const toDelete of resolution.deleted) {
        try {
          fs.unlinkSync(path.join(dir, toDelete))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }

    const livePaths = collectLivePathsOnDisk(dir)
    const droppedOverrides = opts.source.getDroppedOverrides?.() ?? null
    const skippedConfigs = opts.source.getSkippedConfigs?.() ?? null
    const coercedSentinels = opts.source.getCoercedSentinels?.() ?? null
    const conversionNotes = opts.source.getConversionNotes?.() ?? null
    const duplicateResolutions: DuplicateResolutionSummary | null =
      resolutionEntries.length > 0 ? {entries: resolutionEntries, total: resolutionEntries.length} : null

    removeQfFromGitignore(dir)
    writeImportState(dir, opts.importState)

    const skippedTotal = (skippedConfigs?.total ?? 0) + resolutionEntries.reduce((sum, r) => sum + r.deleted.length, 0)
    const counts = buildMigrationCounts(livePaths, opts.environments.length, skippedTotal)
    const reportData: MigrationReportData = {
      ...opts.reportData,
      counts,
      ...(coercedSentinels ? {coercedSentinels} : {}),
      ...(conversionNotes && conversionNotes.length > 0 ? {conversionNotes} : {}),
      ...(droppedOverrides ? {droppedOverrides} : {}),
      ...(duplicateResolutions ? {duplicateResolutions} : {}),
      ...(skippedConfigs ? {skippedConfigs} : {}),
    }
    writeMigrationReport(dir, reportData)

    opts.onAccumulatorUpdate?.({coercedSentinels, droppedOverrides, duplicateResolutions, skippedConfigs})

    if (opts.postWrite) await opts.postWrite(dir)
  },
  author: MIGRATOR_IDENTITY,
  message: `migrator: imported ${opts.changes.length} change(s) from ${opts.source.name} (audit log)`,
})

/**
 * Walk the type-dir top-levels we care about, returning all `<type-dir>/*.json`
 * paths on disk. Used to recompute cumulative counts in audit-log mode where
 * `writeQuonfigFiles` runs per-change and its in-memory `livePaths` reflects
 * only the last slice.
 */
export const collectLivePathsOnDisk = (dir: string): string[] => {
  const prefixes = ['feature-flags', 'configs', 'segments', 'schemas', 'log-levels']
  const out: string[] = []
  for (const prefix of prefixes) {
    const typeDir = path.join(dir, prefix)
    if (!fs.existsSync(typeDir)) continue
    for (const entry of fs.readdirSync(typeDir)) {
      if (entry.endsWith('.json')) out.push(`${prefix}/${entry}`)
    }
  }

  return out
}
