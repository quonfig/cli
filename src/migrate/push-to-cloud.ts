import * as fs from 'node:fs'
import * as path from 'node:path'

import {type ImportState, removeQfFromGitignore, writeImportState} from './import-state.js'
import {type MigrationReportData, writeMigrationReport} from './migration-report.js'
import {detectDuplicateKeys} from './sources/launch/translate.js'
import {type CloneAndStackPushOptions, type CloneAndStackPushResult, cloneAndStackPush} from '../util/clone-and-stack-push.js'
import type {DroppedOverrideSummary, LegacyChange, MigrationSource, SkippedConfigSummary} from './source.js'

export interface PushMigrationToCloudOptions {
  branch?: string
  changes: LegacyChange[]
  commitMessage: string
  importState: ImportState
  localDir: string
  remoteUrl: string
  reportData: MigrationReportData
  source: MigrationSource
}

export interface PushMigrationToCloudResult extends CloneAndStackPushResult {
  droppedOverrides: DroppedOverrideSummary | null
  skippedConfigs: SkippedConfigSummary | null
}

const writeQuonfigFiles = (dir: string, changes: LegacyChange[], source: MigrationSource): void => {
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

  detectDuplicateKeys([...livePaths.keys()].map((p) => ({path: p})))
}

export const pushMigrationToCloud = async (opts: PushMigrationToCloudOptions): Promise<PushMigrationToCloudResult> => {
  let droppedOverrides: DroppedOverrideSummary | null = null
  let skippedConfigs: SkippedConfigSummary | null = null
  const cloneOpts: CloneAndStackPushOptions = {
    applyDelta(dir) {
      writeQuonfigFiles(dir, opts.changes, opts.source)
      removeQfFromGitignore(dir)
      writeImportState(dir, opts.importState)

      droppedOverrides = opts.source.getDroppedOverrides?.() ?? null
      skippedConfigs = opts.source.getSkippedConfigs?.() ?? null
      const reportData: MigrationReportData = {
        ...opts.reportData,
        ...(droppedOverrides ? {droppedOverrides} : {}),
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
  return {...result, droppedOverrides, skippedConfigs}
}
