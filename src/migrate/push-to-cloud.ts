import * as fs from 'node:fs'
import * as path from 'node:path'

import {type ImportState, removeQfFromGitignore, writeImportState} from './import-state.js'
import {buildMigrationCommitMessage, buildMigrationCounts, writeQuonfigFiles} from './local-write.js'
import {type MigrationReportData, writeMigrationReport} from './migration-report.js'
import {
  type CloneAndStackPushOptions,
  type CloneAndStackPushResult,
  type CommitSpec,
  MIGRATOR_IDENTITY,
  cloneAndStackPush,
} from '../util/clone-and-stack-push.js'
import {type ValidationResult, formatResult, validateWorkspace} from '../verify/validate.js'
import type {
  CoercedSentinelSummary,
  DroppedOverrideSummary,
  DuplicateResolutionSummary,
  LegacyChange,
  MigrationSource,
  SkippedConfigSummary,
} from './source.js'

/**
 * Thrown when the migrator's freshly-written workspace fails the same checks
 * that the Gitea pre-receive `qfg-verify` hook will run server-side. We raise
 * this client-side after `applyDelta` writes files but before commit + push,
 * so the customer sees the failure locally rather than after a full push
 * round-trip is rejected (qfg-52qg).
 */
export class MigratorVerifyError extends Error {
  public readonly result: ValidationResult

  constructor(result: ValidationResult) {
    const errorCount = result.issues.filter((i) => i.severity === 'error').length
    super(
      `Migrator output failed qfg verify: ${errorCount} error(s) in ${result.filesChecked} file(s). ` +
        `Refusing to push — the same errors would be rejected by the server pre-receive hook.\n\n` +
        formatResult(result),
    )
    this.name = 'MigratorVerifyError'
    this.result = result
  }
}

export interface PushMigrationToCloudOptions {
  branch?: string
  changes: LegacyChange[]
  /**
   * Source-side environments (slugified). Additively merged into the target
   * workspace's quonfig.json so flag files that reference these envs verify
   * cleanly. Existing target-only envs are preserved.
   */
  environments?: string[]
  /**
   * qfg-wbkj: when true, produce one git commit per change (audit-log mode) —
   * each commit authored as the original Launch user with their `changedAt` as
   * GIT_AUTHOR_DATE and `summary` as the message. One final state-file commit
   * (migrator identity, now) lands on top carrying .qf/import-state.json +
   * MIGRATION_REPORT.md so the audit-log commits aren't polluted by bookkeeping
   * churn. Requires that `source.getCommitMeta` be defined.
   */
  fullHistory?: boolean
  importState: ImportState
  localDir: string
  remoteUrl: string
  /**
   * Base report data. The migrator overrides `counts` after writing files,
   * since counts must reflect what was actually written to disk (qfg-7eig).
   */
  reportData: MigrationReportData
  source: MigrationSource
}

export interface PushMigrationToCloudResult extends CloneAndStackPushResult {
  coercedSentinels: CoercedSentinelSummary | null
  droppedOverrides: DroppedOverrideSummary | null
  duplicateResolutions: DuplicateResolutionSummary | null
  skippedConfigs: SkippedConfigSummary | null
}

const QUONFIG_JSON_FILENAME = 'quonfig.json'

const mergeEnvironmentsIntoQuonfigJson = (dir: string, sourceEnvs: string[]): void => {
  const quonfigPath = path.join(dir, QUONFIG_JSON_FILENAME)
  let existing: {environments?: unknown; [k: string]: unknown} = {}
  if (fs.existsSync(quonfigPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(quonfigPath, 'utf8')) as typeof existing
    } catch {
      existing = {}
    }
  }

  const existingEnvs = Array.isArray(existing.environments) ? (existing.environments as string[]) : []
  const merged = [...new Set([...existingEnvs, ...sourceEnvs])].sort()
  if (existingEnvs.length === merged.length && existingEnvs.every((e, i) => e === merged[i])) {
    return
  }

  fs.writeFileSync(quonfigPath, JSON.stringify({...existing, environments: merged}, null, 2) + '\n', 'utf8')
}

export const pushMigrationToCloud = async (opts: PushMigrationToCloudOptions): Promise<PushMigrationToCloudResult> => {
  if (opts.fullHistory && !opts.source.getCommitMeta) {
    throw new Error(
      `--full-summary requires the source to provide per-change author + date + summary, but \`${opts.source.name}\` does not. ` +
        `Drop --full-summary or use a source (e.g. launch) that supports it.`,
    )
  }

  let coercedSentinels: CoercedSentinelSummary | null = null
  let droppedOverrides: DroppedOverrideSummary | null = null
  let duplicateResolutions: DuplicateResolutionSummary | null = null
  let skippedConfigs: SkippedConfigSummary | null = null
  let computedCommitMessage: string = `migrator: imported 0 objects from ${opts.source.name}`

  const commits: CommitSpec[] = opts.fullHistory
    ? buildAuditLogCommits(opts, {
        onAccumulatorUpdate(acc) {
          coercedSentinels = acc.coercedSentinels
          droppedOverrides = acc.droppedOverrides
          duplicateResolutions = acc.duplicateResolutions
          skippedConfigs = acc.skippedConfigs
        },
      })
    : [
        {
          message: () => computedCommitMessage,
          async apply(dir) {
            if (opts.environments && opts.environments.length > 0) {
              mergeEnvironmentsIntoQuonfigJson(dir, opts.environments)
            }

            const {livePaths, resolutions: resolutionEntries} = writeQuonfigFiles(dir, opts.changes, opts.source)
            removeQfFromGitignore(dir)
            writeImportState(dir, opts.importState)

            droppedOverrides = opts.source.getDroppedOverrides?.() ?? null
            skippedConfigs = opts.source.getSkippedConfigs?.() ?? null
            coercedSentinels = opts.source.getCoercedSentinels?.() ?? null
            duplicateResolutions =
              resolutionEntries.length > 0 ? {entries: resolutionEntries, total: resolutionEntries.length} : null
            const skippedTotal =
              (skippedConfigs?.total ?? 0) + resolutionEntries.reduce((sum, r) => sum + r.deleted.length, 0)
            const environmentsCount = opts.environments?.length ?? 0
            const counts = buildMigrationCounts(livePaths, environmentsCount, skippedTotal)
            computedCommitMessage = buildMigrationCommitMessage(opts.source.name, counts)
            const reportData: MigrationReportData = {
              ...opts.reportData,
              counts,
              ...(coercedSentinels ? {coercedSentinels} : {}),
              ...(droppedOverrides ? {droppedOverrides} : {}),
              ...(duplicateResolutions ? {duplicateResolutions} : {}),
              ...(skippedConfigs ? {skippedConfigs} : {}),
            }
            writeMigrationReport(dir, reportData)

            const verifyResult = validateWorkspace(dir)
            if (!verifyResult.valid) throw new MigratorVerifyError(verifyResult)
          },
        },
      ]

  const cloneOpts: CloneAndStackPushOptions = {
    commits,
    localDir: opts.localDir,
    remoteUrl: opts.remoteUrl,
  }
  if (opts.branch !== undefined) cloneOpts.branch = opts.branch

  const result = await cloneAndStackPush(cloneOpts)
  return {...result, coercedSentinels, droppedOverrides, duplicateResolutions, skippedConfigs}
}

interface AuditAccumulator {
  coercedSentinels: CoercedSentinelSummary | null
  droppedOverrides: DroppedOverrideSummary | null
  duplicateResolutions: DuplicateResolutionSummary | null
  skippedConfigs: SkippedConfigSummary | null
}

const buildAuditLogCommits = (
  opts: PushMigrationToCloudOptions,
  callbacks: {onAccumulatorUpdate: (acc: AuditAccumulator) => void},
): CommitSpec[] => {
  const auditCommits: CommitSpec[] = opts.changes.map((change, index) => {
    // Resolve commit meta once. The source must provide it for every change in
    // full-history mode; null at this point means the bead-level invariant
    // (Launch always carries changedBy + changedAt) was violated and we should
    // fail loudly rather than silently fall back to migrator identity.
    const meta = opts.source.getCommitMeta?.(change) ?? null
    if (!meta) {
      return {
        author: MIGRATOR_IDENTITY,
        message: `migrator: imported change ${index + 1} of ${opts.changes.length} from ${opts.source.name}`,
        async apply(dir) {
          writeQuonfigFiles(dir, [change], opts.source)
        },
      }
    }

    return {
      author: meta.author,
      authorDate: meta.date,
      message: meta.message,
      async apply(dir) {
        writeQuonfigFiles(dir, [change], opts.source)
      },
    }
  })

  // Final commit: environments merge (so quonfig.json reflects the source-side
  // env list), state-file bookkeeping, migration report, and the pre-flight
  // verify pass against the cumulative tree.
  const finalCommit: CommitSpec = {
    author: MIGRATOR_IDENTITY,
    async apply(dir) {
      if (opts.environments && opts.environments.length > 0) {
        mergeEnvironmentsIntoQuonfigJson(dir, opts.environments)
      }

      // Recompute live paths from disk so counts and duplicate-resolution
      // reflect the cumulative state rather than the last change's slice.
      const livePaths = collectLivePathsOnDisk(dir)
      const droppedOverrides = opts.source.getDroppedOverrides?.() ?? null
      const skippedConfigs = opts.source.getSkippedConfigs?.() ?? null
      const coercedSentinels = opts.source.getCoercedSentinels?.() ?? null
      const duplicateResolutions: DuplicateResolutionSummary | null = null

      removeQfFromGitignore(dir)
      writeImportState(dir, opts.importState)

      const skippedTotal = skippedConfigs?.total ?? 0
      const environmentsCount = opts.environments?.length ?? 0
      const counts = buildMigrationCounts(livePaths, environmentsCount, skippedTotal)
      const reportData: MigrationReportData = {
        ...opts.reportData,
        counts,
        ...(coercedSentinels ? {coercedSentinels} : {}),
        ...(droppedOverrides ? {droppedOverrides} : {}),
        ...(skippedConfigs ? {skippedConfigs} : {}),
      }
      writeMigrationReport(dir, reportData)

      callbacks.onAccumulatorUpdate({coercedSentinels, droppedOverrides, duplicateResolutions, skippedConfigs})

      // qfg-52qg: client-side verify of the cumulative tree before the final
      // commit lands. Pre-receive hook runs only against the final HEAD, so
      // failing here matches what the server would reject.
      const verifyResult = validateWorkspace(dir)
      if (!verifyResult.valid) throw new MigratorVerifyError(verifyResult)
    },
    message: () => `migrator: imported ${opts.changes.length} change(s) from ${opts.source.name} (audit log)`,
  }

  return [...auditCommits, finalCommit]
}

const collectLivePathsOnDisk = (dir: string): string[] => {
  // Walk the type-dir top-levels we care about. Matches the prefixes that
  // countsFromLivePaths inspects.
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
