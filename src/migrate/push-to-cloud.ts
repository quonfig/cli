import * as fs from 'node:fs'
import * as path from 'node:path'

import {type ImportState, readKeyPlan, removeQfFromGitignore, writeImportState, writeKeyPlan} from './import-state.js'
import {
  type AuditAccumulator,
  buildAuditFinalCommit,
  buildAuditPerChangeCommits,
  buildMigrationCommitMessage,
  buildMigrationCounts,
  writeQuonfigFiles,
} from './local-write.js'
import {getFullKeyPlan, getKeyRewrites, preflightKeyRewrites} from './key-rewriter.js'
import {deriveFollowUpFromConversionNotes, type MigrationReportData, writeMigrationReport} from './migration-report.js'
import {
  type CloneAndStackPushOptions,
  type CloneAndStackPushResult,
  type CommitSpec,
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
 * this client-side after the commit's `apply` writes files but before commit +
 * push, so the customer sees the failure locally rather than after a full push
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
   * .qf/MIGRATION_REPORT.md so the audit-log commits aren't polluted by
   * bookkeeping churn. Requires that `source.getCommitMeta` be defined.
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
  /** qfg-6na9.3: `--strict-keys` — refuse to migrate if any key would be rewritten. */
  strictKeys?: boolean
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

const verifyOnDisk = (dir: string): void => {
  // qfg-52qg: client-side verify against the cumulative tree before commit
  // lands. The Gitea pre-receive hook runs against the final HEAD; failing
  // here matches what the server would reject and avoids a wasted push.
  const verifyResult = validateWorkspace(dir)
  if (!verifyResult.valid) throw new MigratorVerifyError(verifyResult)
}

export const pushMigrationToCloud = async (opts: PushMigrationToCloudOptions): Promise<PushMigrationToCloudResult> => {
  if (opts.fullHistory && !opts.source.getCommitMeta) {
    throw new Error(
      `--full-summary requires the source to provide per-change author + date + summary, but \`${opts.source.name}\` does not. ` +
        `Drop --full-summary or use a source (e.g. launch) that supports it.`,
    )
  }

  // qfg-6na9.3: plan Policy A key rewrites over ALL changes up front (run-level,
  // not per-commit) so key-def and reference sites resolve identically, then
  // enforce --strict-keys before any clone/commit/push. Mappings persisted by a
  // previous run (.qf/key-plan.json in the reused clone) are authoritative so a
  // delta run cannot replan a subset and land on different finals. (When the
  // clone is fresh, the plan only comes down WITH the clone — the collapsed
  // commit's apply() re-plans below once it can read the cloned .qf/.)
  preflightKeyRewrites(opts.changes, {
    persistedKeys: readKeyPlan(opts.localDir) ?? undefined,
    strict: opts.strictKeys,
  })

  const acc: AuditAccumulator = {
    coercedSentinels: null,
    droppedOverrides: null,
    duplicateResolutions: null,
    skippedConfigs: null,
  }
  let computedCommitMessage: string = `migrator: imported 0 objects from ${opts.source.name}`

  const mergeEnvsIfPresent = (dir: string): void => {
    if (opts.environments && opts.environments.length > 0) {
      mergeEnvironmentsIntoQuonfigJson(dir, opts.environments)
    }
  }

  const commits: CommitSpec[] = opts.fullHistory
    ? [
        ...buildAuditPerChangeCommits(opts.changes, opts.source),
        buildAuditFinalCommit({
          changes: opts.changes,
          environments: opts.environments ?? [],
          importState: opts.importState,
          onAccumulatorUpdate: (a) => Object.assign(acc, a),
          postWrite: verifyOnDisk,
          preWrite: mergeEnvsIfPresent,
          reportData: opts.reportData,
          source: opts.source,
        }),
      ]
    : [
        {
          message: () => computedCommitMessage,
          async apply(dir) {
            // Re-plan now that the clone exists: a FRESH clone of a previously
            // migrated workspace delivers .qf/key-plan.json only at this point
            // (the pre-clone preflight above couldn't see it), and the
            // persisted mappings must win before any file is written.
            preflightKeyRewrites(opts.changes, {
              persistedKeys: readKeyPlan(dir) ?? undefined,
              strict: opts.strictKeys,
            })

            mergeEnvsIfPresent(dir)

            const {livePaths, resolutions: resolutionEntries} = writeQuonfigFiles(dir, opts.changes, opts.source)
            removeQfFromGitignore(dir)
            writeImportState(dir, opts.importState)
            writeKeyPlan(dir, getFullKeyPlan())

            acc.droppedOverrides = opts.source.getDroppedOverrides?.() ?? null
            acc.skippedConfigs = opts.source.getSkippedConfigs?.() ?? null
            acc.coercedSentinels = opts.source.getCoercedSentinels?.() ?? null
            acc.duplicateResolutions =
              resolutionEntries.length > 0 ? {entries: resolutionEntries, total: resolutionEntries.length} : null
            const conversionNotes = opts.source.getConversionNotes?.() ?? null
            const environmentMap = opts.source.getEnvironmentMap?.() ?? null
            const maintainerMap = opts.source.getMaintainerMap?.() ?? null
            const skippedTotal =
              (acc.skippedConfigs?.total ?? 0) + resolutionEntries.reduce((sum, r) => sum + r.deleted.length, 0)
            const environmentsCount = opts.environments?.length ?? 0
            const counts = buildMigrationCounts(livePaths, environmentsCount, skippedTotal)
            computedCommitMessage = buildMigrationCommitMessage(opts.source.name, counts)
            const reportData: MigrationReportData = {
              ...opts.reportData,
              counts,
              keyRewrites: getKeyRewrites(),
              ...(environmentMap && environmentMap.length > 0 ? {environmentMap} : {}),
              followUp: deriveFollowUpFromConversionNotes(opts.reportData.followUp, conversionNotes ?? undefined),
              ...(acc.coercedSentinels ? {coercedSentinels: acc.coercedSentinels} : {}),
              ...(conversionNotes && conversionNotes.length > 0 ? {conversionNotes} : {}),
              ...(acc.droppedOverrides ? {droppedOverrides: acc.droppedOverrides} : {}),
              ...(acc.duplicateResolutions ? {duplicateResolutions: acc.duplicateResolutions} : {}),
              ...(maintainerMap && Object.keys(maintainerMap).length > 0 ? {maintainerMap} : {}),
              ...(acc.skippedConfigs ? {skippedConfigs: acc.skippedConfigs} : {}),
            }
            writeMigrationReport(dir, reportData)

            verifyOnDisk(dir)
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
  return {
    ...result,
    coercedSentinels: acc.coercedSentinels,
    droppedOverrides: acc.droppedOverrides,
    duplicateResolutions: acc.duplicateResolutions,
    skippedConfigs: acc.skippedConfigs,
  }
}
