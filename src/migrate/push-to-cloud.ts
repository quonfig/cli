import * as fs from 'node:fs'
import * as path from 'node:path'

import {type ImportState, removeQfFromGitignore, writeImportState} from './import-state.js'
import {type MigrationReportData, writeMigrationReport} from './migration-report.js'
import {detectDuplicateKeys} from './sources/launch/translate.js'
import {
  type CloneAndStackPushOptions,
  type CloneAndStackPushResult,
  cloneAndStackPush,
} from '../util/clone-and-stack-push.js'
import type {
  DroppedOverrideSummary,
  DuplicateResolution,
  DuplicateResolutionSummary,
  LegacyChange,
  MigrationSource,
  SkippedConfigSummary,
} from './source.js'

export interface PushMigrationToCloudOptions {
  branch?: string
  changes: LegacyChange[]
  commitMessage: string
  /**
   * Source-side environments (slugified). Additively merged into the target
   * workspace's quonfig.json so flag files that reference these envs verify
   * cleanly. Existing target-only envs are preserved.
   */
  environments?: string[]
  importState: ImportState
  localDir: string
  remoteUrl: string
  reportData: MigrationReportData
  source: MigrationSource
}

export interface PushMigrationToCloudResult extends CloneAndStackPushResult {
  droppedOverrides: DroppedOverrideSummary | null
  duplicateResolutions: DuplicateResolutionSummary | null
  skippedConfigs: SkippedConfigSummary | null
}

const writeQuonfigFiles = (dir: string, changes: LegacyChange[], source: MigrationSource): DuplicateResolution[] => {
  const livePaths = new Map<string, true>()
  for (const change of changes) {
    const files = source.translate(change)
    for (const file of files) {
      const full = path.join(dir, file.path)
      if (file.deleted) {
        try {
          fs.unlinkSync(full)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }

        livePaths.delete(file.path)
      } else {
        if (file.contents === undefined) {
          throw new Error(`translate() emitted a write op for ${file.path} without contents`)
        }

        fs.mkdirSync(path.dirname(full), {recursive: true})
        fs.writeFileSync(full, file.contents)
        livePaths.set(file.path, true)
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

  return resolutions
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
  let droppedOverrides: DroppedOverrideSummary | null = null
  let duplicateResolutions: DuplicateResolutionSummary | null = null
  let skippedConfigs: SkippedConfigSummary | null = null
  const cloneOpts: CloneAndStackPushOptions = {
    applyDelta(dir) {
      if (opts.environments && opts.environments.length > 0) {
        mergeEnvironmentsIntoQuonfigJson(dir, opts.environments)
      }

      const resolutionEntries = writeQuonfigFiles(dir, opts.changes, opts.source)
      removeQfFromGitignore(dir)
      writeImportState(dir, opts.importState)

      droppedOverrides = opts.source.getDroppedOverrides?.() ?? null
      skippedConfigs = opts.source.getSkippedConfigs?.() ?? null
      duplicateResolutions =
        resolutionEntries.length > 0 ? {entries: resolutionEntries, total: resolutionEntries.length} : null
      const reportData: MigrationReportData = {
        ...opts.reportData,
        ...(droppedOverrides ? {droppedOverrides} : {}),
        ...(duplicateResolutions ? {duplicateResolutions} : {}),
        ...(skippedConfigs ? {skippedConfigs} : {}),
      }
      writeMigrationReport(dir, reportData)
    },
    commitMessage: opts.commitMessage,
    localDir: opts.localDir,
    remoteUrl: opts.remoteUrl,
  }
  if (opts.branch !== undefined) cloneOpts.branch = opts.branch

  const result = await cloneAndStackPush(cloneOpts)
  return {...result, droppedOverrides, duplicateResolutions, skippedConfigs}
}
