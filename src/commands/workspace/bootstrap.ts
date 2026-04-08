import * as path from 'node:path'

import {confirm} from '@inquirer/prompts'
import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getActiveProfile, loadAuthConfig, loadTokens} from '../../util/token-storage.js'
import {mintGiteaToken} from '../../util/gitea-api.js'
import {
  isGitRepo,
  hasAtLeastOneCommit,
  gitSetRemote,
  gitPushForceLease,
  gitPushForce,
  getRemoteUrl,
  displayUrl,
} from '../../util/git-ops.js'

export default class WorkspaceBootstrap extends BaseCommand {
  static description = 'Push a local git repo to Gitea as this workspace\'s config repository'

  static examples = [
    '<%= config.bin %> workspace bootstrap --dir ./our-config',
    '<%= config.bin %> workspace bootstrap --dir ./launch-migrator/output',
    '<%= config.bin %> workspace bootstrap --dir ./our-config --skip-validate',
  ]

  static flags = {
    dir: Flags.string({
      description: 'Local directory to push (defaults to current directory)',
      required: false,
    }),
    force: Flags.boolean({
      default: false,
      description: 'Force push even if remote already has commits',
    }),
    'skip-validate': Flags.boolean({
      default: false,
      description: 'Skip config validation before pushing',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(WorkspaceBootstrap)

    // Resolve target directory
    const dir = flags.dir || process.env.QUONFIG_DIR || process.cwd()
    const resolvedDir = path.resolve(dir)

    // Load auth
    const authConfig = await loadAuthConfig()
    if (!authConfig) {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    const activeProfile = getActiveProfile()
    const profile = authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']
    if (!profile) {
      return this.err('No active profile found. Run `qfg login` first.')
    }

    const workspaceId = profile.workspace
    const workspaceName = profile.workspaceSlug || profile.workspaceName || workspaceId

    this.verboseLog('WorkspaceBootstrap', {workspaceId, dir: resolvedDir})

    // Validate: must be a git repo with at least one commit
    const isRepo = await isGitRepo(resolvedDir)
    if (!isRepo) {
      return this.err(`${resolvedDir} is not a git repository.\nInitialize it with \`git init\` and commit your config files first.`)
    }

    const hasCommit = await hasAtLeastOneCommit(resolvedDir)
    if (!hasCommit) {
      return this.err(`${resolvedDir} has no commits. Commit your config files first.`)
    }

    // Verify config before doing anything
    if (!flags['skip-validate']) {
      this.log('Verifying config files...')
      try {
        const {validateWorkspace} = await import('../../verify/validate.js')
        const result = validateWorkspace(resolvedDir)
        const errors = result.issues.filter((i: {severity: string}) => i.severity === 'error')
        if (errors.length > 0) {
          this.log(`\nFound ${errors.length} validation error(s):\n`)
          for (const issue of errors) {
            this.log(`  ${(issue as {message: string}).message}`)
          }
          this.log('\nFix the errors above or run with --skip-validate to bypass.')
          return this.err('Validation failed.')
        }
        this.log('Validation passed.\n')
      } catch (err: unknown) {
        this.verboseLog('Validation error', String(err))
        this.log('Warning: could not run validation. Proceeding anyway.')
        this.log('Use --skip-validate to suppress this warning.\n')
      }
    }

    // Confirmation prompt
    const existingRemote = await getRemoteUrl(resolvedDir)
    this.log(`Directory:  ${resolvedDir}`)
    this.log(`Workspace:  ${workspaceName}`)
    if (existingRemote) {
      this.log(`Remote:     ${displayUrl(existingRemote)} (will be updated)`)
    }
    this.log('')

    const confirmed = await confirm({
      message: `Push ${path.basename(resolvedDir)} to workspace "${workspaceName}"?`,
      default: false,
    })

    if (!confirmed) {
      this.log('Aborted.')
      return
    }

    this.log('')

    // Mint write token (backend provisions Gitea repo + bot account)
    this.log('Connecting to Gitea...')
    let tokenData: {token: string; repoUrl: string; expiresAt: string | null}
    try {
      tokenData = await mintGiteaToken(workspaceId, 'write', 'bootstrap')
    } catch (err: unknown) {
      return this.err(`Could not get Gitea credentials: ${String(err)}\n\nMake sure the workspace is fully provisioned in the Quonfig app before bootstrapping.`)
    }

    const {repoUrl} = tokenData
    this.verboseLog('WorkspaceBootstrap', {repoUrl: displayUrl(repoUrl)})

    // Idempotency: check if remote already has commits
    if (!flags.force) {
      const remoteHasCommits = await this.remoteHasCommits(repoUrl)
      if (remoteHasCommits) {
        this.log(`\nThe remote repository already has commits.`)
        this.log(`Run \`qfg pull --dir ${resolvedDir}\` to sync, then re-run bootstrap.`)
        this.log(`Or run with --force to overwrite the remote.\n`)
        return this.err('Remote is not empty.')
      }
    }

    // Set remote
    if (existingRemote) {
      this.log(`Updating remote origin...`)
    } else {
      this.log(`Setting remote origin...`)
    }
    await gitSetRemote(resolvedDir, repoUrl)

    // Push
    this.log('Pushing to Gitea...')
    try {
      if (flags.force) {
        await gitPushForce(resolvedDir)
      } else {
        await gitPushForceLease(resolvedDir)
      }
    } catch (err: unknown) {
      return this.err(`Push failed: ${String(err)}`)
    }

    this.log(`\nBootstrap complete.`)
    this.log(`Workspace "${workspaceName}" is now connected to your local directory.`)
    this.log(`\nTo keep it in sync locally, run:`)
    this.log(`  qfg sync --watch --dir ${resolvedDir}`)

    return {
      dir: resolvedDir,
      repoUrl: displayUrl(repoUrl),
      workspaceId,
    }
  }

  private async remoteHasCommits(repoUrl: string): Promise<boolean> {
    const {execFile: execFileCb} = await import('node:child_process')
    const util = await import('node:util')
    const execFile = util.promisify(execFileCb)
    const {stdout} = await execFile('git', ['ls-remote', '--heads', repoUrl])
    return stdout.trim().length > 0
  }
}
