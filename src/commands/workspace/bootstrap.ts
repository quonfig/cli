import * as path from 'node:path'

import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getActiveProfile, loadAuthConfig, loadTokens} from '../../util/token-storage.js'
import {getApiUrl} from '../../util/domain-urls.js'
import {mintGiteaToken} from '../../util/gitea-api.js'
import {
  isGitRepo,
  hasAtLeastOneCommit,
  gitSetRemote,
  gitPushForceLease,
  getRemoteUrl,
  displayUrl,
} from '../../util/git-ops.js'

export default class WorkspaceBootstrap extends BaseCommand {
  static description = 'Push a local git repo to Gitea as this workspace\'s config repository'

  static examples = [
    '<%= config.bin %> workspace bootstrap --dir ./our-config',
    '<%= config.bin %> workspace bootstrap --dir ./launch-migrator/output --workspace-name acme',
    '<%= config.bin %> workspace bootstrap --dir ./our-config --skip-validate',
  ]

  static flags = {
    dir: Flags.string({
      description: 'Local directory to push (defaults to QUONFIG_DIR env var)',
      required: false,
    }),
    force: Flags.boolean({
      default: false,
      description: 'Force push even if remote has commits',
    }),
    'skip-validate': Flags.boolean({
      default: false,
      description: 'Skip config validation before pushing',
    }),
    'workspace-name': Flags.string({
      description: 'Workspace name (informational only)',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(WorkspaceBootstrap)

    // Resolve target directory
    const dir = flags.dir || process.env.QUONFIG_DIR
    if (!dir) {
      return this.err('No directory specified. Use --dir <path> or set QUONFIG_DIR.')
    }

    const resolvedDir = path.resolve(dir)

    // Resolve workspace ID from profile
    const authConfig = await loadAuthConfig()
    if (!authConfig) {
      return this.err('Not logged in. Please run `qfg login` first.')
    }

    const activeProfile = getActiveProfile()
    const profile = authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']
    if (!profile) {
      return this.err('No active profile found. Please run `qfg login` first.')
    }

    const workspaceId = profile.workspace
    this.verboseLog('WorkspaceBootstrap', {workspaceId, dir: resolvedDir})

    // Validate: must be a git repo with at least one commit
    const isRepo = await isGitRepo(resolvedDir)
    if (!isRepo) {
      return this.err(`${resolvedDir} is not a git repository. Initialize it with \`git init\` and commit your config files first.`)
    }

    const hasCommit = await hasAtLeastOneCommit(resolvedDir)
    if (!hasCommit) {
      return this.err(`${resolvedDir} has no commits. Commit your config files first.`)
    }

    // Optional validation
    if (!flags['skip-validate']) {
      this.log('Validating workspace config...')
      try {
        const {validateWorkspace} = await import('../../verify/validate.js')
        const result = validateWorkspace(resolvedDir)
        if (!result.valid) {
          const errors = result.issues.filter((i) => i.severity === 'error')
          this.log(`Validation found ${errors.length} error(s). Run \`qfg verify ${resolvedDir}\` for details.`)
          this.log('Use --skip-validate to bypass validation.')
          return this.err('Validation failed.')
        }

        this.log('Validation passed.')
      } catch (err: unknown) {
        this.verboseLog('WorkspaceBootstrap', `Validation error: ${String(err)}`)
        this.log('Warning: could not run validation. Proceeding anyway (use --skip-validate to suppress this).')
      }
    }

    // Mint write token (backend provisions Gitea org/repo if needed)
    this.log('Provisioning Gitea repository...')
    let tokenData: {token: string; repoUrl: string; expiresAt: string | null}
    try {
      tokenData = await mintGiteaToken(workspaceId, 'write', 'bootstrap')
    } catch (err: unknown) {
      return this.err(`Failed to provision workspace: ${String(err)}`)
    }

    const {repoUrl} = tokenData
    this.verboseLog('WorkspaceBootstrap', {repoUrl: displayUrl(repoUrl)})

    // Check if remote already has commits (idempotency check)
    if (!flags.force) {
      const remoteHasCommits = await this.remoteHasCommits(workspaceId, repoUrl)
      if (remoteHasCommits) {
        this.log(`Remote already has commits. Run \`qfg pull --dir ${resolvedDir}\` to sync first, then re-run bootstrap.`)
        return this.err('Remote is not empty. Use --force to override.')
      }
    }

    // Set remote
    const existingRemote = await getRemoteUrl(resolvedDir)
    if (existingRemote) {
      this.log(`Updating remote origin from ${displayUrl(existingRemote)} to ${displayUrl(repoUrl)}`)
    } else {
      this.log(`Setting remote origin to ${displayUrl(repoUrl)}`)
    }

    await gitSetRemote(resolvedDir, repoUrl)

    // Push
    this.log('Pushing to Gitea...')
    try {
      await gitPushForceLease(resolvedDir)
    } catch (err: unknown) {
      return this.err(`Push failed: ${String(err)}`)
    }

    this.log(`Workspace bootstrapped successfully.`)
    this.log(`Remote: ${displayUrl(repoUrl)}`)

    return {
      dir: resolvedDir,
      repoUrl: displayUrl(repoUrl),
      workspaceId,
    }
  }

  private async remoteHasCommits(workspaceId: string, repoUrl: string): Promise<boolean> {
    // Use the ls-remote command to check if the remote has any refs
    const {execFile: execFileCb} = await import('node:child_process')
    const util = await import('node:util')
    const execFile = util.promisify(execFileCb)

    try {
      const {stdout} = await execFile('git', ['ls-remote', '--heads', repoUrl])
      return stdout.trim().length > 0
    } catch {
      // If ls-remote fails (e.g. repo doesn't exist yet), treat as empty
      return false
    }
  }
}
