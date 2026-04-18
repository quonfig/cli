import {execFile as execFileCb, spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as util from 'node:util'

import {type ImportState, removeQfFromGitignore, writeImportState} from './import-state.js'
import {type MigrationReportData, writeMigrationReport} from './migration-report.js'
import {MIGRATOR_IDENTITY, type PushIdentity} from './push-strategy.js'
import type {LegacyChange, MigrationSource} from './source.js'

const execFile = util.promisify(execFileCb)

export interface ApplyLocalMigrationOptions {
  /** Commit author. Defaults to the migrator identity. */
  author?: PushIdentity
  /** Initial branch name when initializing a fresh repo. Defaults to `main`. */
  branch?: string
  changes: LegacyChange[]
  commitMessage: string
  /** Environments discovered from the source (slugified). Written to `quonfig.json` if missing. */
  environments: string[]
  importState: ImportState
  localDir: string
  reportData: MigrationReportData
  source: MigrationSource
}

export interface ApplyLocalMigrationResult {
  /** `'initialized'` if we had to `git init` the target, `'reused'` if it was already a repo. */
  action: 'initialized' | 'reused'
  commitSha: string | null
  /** `false` if translate produced no net changes — nothing was committed. */
  committed: boolean
}

const isGitRepo = async (dir: string): Promise<boolean> => {
  try {
    await execFile('git', ['-C', dir, 'rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

const hasStagedChanges = async (dir: string): Promise<boolean> => {
  const {stdout} = await execFile('git', ['-C', dir, 'status', '--porcelain'])
  return stdout.trim().length > 0
}

const gitCommitFromStdin = (
  cwd: string,
  message: string,
  env: NodeJS.ProcessEnv,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, 'commit', '-F', '-'], {env})
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`git commit exited ${code}: ${stderr}`))
    })
    child.stdin.end(message)
  })

const ensureQuonfigJson = (dir: string, environments: string[]): void => {
  const filePath = path.join(dir, 'quonfig.json')
  if (fs.existsSync(filePath)) return
  const sorted = [...new Set(environments)].sort()
  fs.writeFileSync(filePath, JSON.stringify({environments: sorted}, null, 2) + '\n', 'utf8')
}

const ensureLocalRepo = async (
  localDir: string,
  branch: string,
): Promise<'initialized' | 'reused'> => {
  fs.mkdirSync(localDir, {recursive: true})
  if (await isGitRepo(localDir)) return 'reused'
  await execFile('git', ['init', `--initial-branch=${branch}`, localDir])
  return 'initialized'
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

export const applyLocalMigration = async (
  opts: ApplyLocalMigrationOptions,
): Promise<ApplyLocalMigrationResult> => {
  const branch = opts.branch ?? 'main'
  const author = opts.author ?? MIGRATOR_IDENTITY

  const action = await ensureLocalRepo(opts.localDir, branch)

  await execFile('git', ['-C', opts.localDir, 'config', 'user.name', author.name])
  await execFile('git', ['-C', opts.localDir, 'config', 'user.email', author.email])

  ensureQuonfigJson(opts.localDir, opts.environments)
  writeQuonfigFiles(opts.localDir, opts.changes, opts.source)
  removeQfFromGitignore(opts.localDir)
  writeImportState(opts.localDir, opts.importState)
  writeMigrationReport(opts.localDir, opts.reportData)

  await execFile('git', ['-C', opts.localDir, 'add', '--all'])

  if (!(await hasStagedChanges(opts.localDir))) {
    return {action, committed: false, commitSha: null}
  }

  await gitCommitFromStdin(opts.localDir, opts.commitMessage, {
    ...process.env,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
  })

  const {stdout: sha} = await execFile('git', ['-C', opts.localDir, 'rev-parse', 'HEAD'])
  return {action, commitSha: sha.trim(), committed: true}
}
