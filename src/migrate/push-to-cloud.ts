import * as fs from 'node:fs'
import * as path from 'node:path'

import {type ImportState, removeQfFromGitignore, writeImportState} from './import-state.js'
import {buildMigrationCommitMessage, buildMigrationCounts, writeQuonfigFiles} from './local-write.js'
import {type MigrationReportData, writeMigrationReport} from './migration-report.js'
import {
  type CloneAndStackPushOptions,
  type CloneAndStackPushResult,
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
  let coercedSentinels: CoercedSentinelSummary | null = null
  let droppedOverrides: DroppedOverrideSummary | null = null
  let duplicateResolutions: DuplicateResolutionSummary | null = null
  let skippedConfigs: SkippedConfigSummary | null = null
  let computedCommitMessage: string = `migrator: imported 0 objects from ${opts.source.name}`
  const cloneOpts: CloneAndStackPushOptions = {
    applyDelta(dir) {
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

      // Pre-flight: run the same validation the Gitea pre-receive `qfg-verify`
      // hook will run after the push lands. Failing here saves a full
      // git-push round-trip and gives the customer a local, fixable error
      // (qfg-52qg).
      const verifyResult = validateWorkspace(dir)
      if (!verifyResult.valid) throw new MigratorVerifyError(verifyResult)
    },
    commitMessage: () => computedCommitMessage,
    localDir: opts.localDir,
    remoteUrl: opts.remoteUrl,
  }
  if (opts.branch !== undefined) cloneOpts.branch = opts.branch

  const result = await cloneAndStackPush(cloneOpts)
  return {...result, coercedSentinels, droppedOverrides, duplicateResolutions, skippedConfigs}
}
