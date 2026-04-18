import * as fs from 'node:fs'
import * as path from 'node:path'

import {type ImportState, removeQfFromGitignore, writeImportState} from './import-state.js'
import {type MigrationReportData, writeMigrationReport} from './migration-report.js'
import {
  type CloneAndStackPushOptions,
  type CloneAndStackPushResult,
  cloneAndStackPush,
} from './push-strategy.js'
import type {LegacyChange, MigrationSource} from './source.js'

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

const writeQuonfigFiles = (
  dir: string,
  changes: LegacyChange[],
  source: MigrationSource,
): void => {
  for (const change of changes) {
    const files = source.translate(change)
    for (const file of files) {
      const full = path.join(dir, file.path)
      fs.mkdirSync(path.dirname(full), {recursive: true})
      fs.writeFileSync(full, file.contents)
    }
  }
}

export const pushMigrationToCloud = async (
  opts: PushMigrationToCloudOptions,
): Promise<CloneAndStackPushResult> => {
  const cloneOpts: CloneAndStackPushOptions = {
    applyDelta(dir) {
      writeQuonfigFiles(dir, opts.changes, opts.source)
      removeQfFromGitignore(dir)
      writeImportState(dir, opts.importState)
      writeMigrationReport(dir, opts.reportData)
    },
    commitMessage: opts.commitMessage,
    localDir: opts.localDir,
    remoteUrl: opts.remoteUrl,
  }
  if (opts.branch !== undefined) cloneOpts.branch = opts.branch

  return cloneAndStackPush(cloneOpts)
}
