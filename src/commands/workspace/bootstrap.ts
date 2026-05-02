import * as path from 'node:path'

import {confirm} from '@inquirer/prompts'
import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getActiveProfile, loadAuthConfig} from '../../util/token-storage.js'
import {mintGiteaToken} from '../../util/gitea-api.js'
import {readWorkspaceSlug, tryParseWorkspacePin, writeWorkspaceSlug} from '../../util/quonfig-json.js'
import {resolveWorkspaceUuid} from '../../util/resolve-workspace.js'
import {
  isGitRepo,
  hasAtLeastOneCommit,
  gitSetRemote,
  gitPushForceLease,
  gitPushForce,
  getRemoteUrl,
  displayUrl,
  runGit,
} from '../../util/git-ops.js'

export default class WorkspaceBootstrap extends BaseCommand {
  static description = "Push a local git repo to Gitea as this workspace's config repository"

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

    const {workspaceId, orgSlug} = await resolveWorkspaceUuid(this)

    // The display name is best-effort; we still want it for the confirmation
    // prompt. Fall back through saved profile → workspaceId UUID.
    const authConfig = await loadAuthConfig()
    const activeProfile = getActiveProfile()
    const profile = authConfig?.profiles[activeProfile] || authConfig?.profiles[authConfig?.defaultProfile || 'default']
    const workspaceName = profile?.workspaceSlug || profile?.workspaceName || workspaceId

    this.verboseLog('WorkspaceBootstrap', {workspaceId, orgSlug, dir: resolvedDir})

    // Validate: must be a git repo with at least one commit
    const isRepo = await isGitRepo(resolvedDir)
    if (!isRepo) {
      return this.err(
        `${resolvedDir} is not a git repository.\nInitialize it with \`git init\` and commit your config files first.`,
      )
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
      } catch (error: unknown) {
        this.verboseLog('Validation error', String(error))
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
    let tokenData: {token: string; repoUrl: string; expiresAt: string | null; workspaceSlug: string}
    try {
      tokenData = await mintGiteaToken(workspaceId, orgSlug, 'write', 'bootstrap')
    } catch (error: unknown) {
      return this.err(
        `Could not get Gitea credentials: ${String(error)}\n\nMake sure the workspace is fully provisioned in the Quonfig app before bootstrapping.`,
      )
    }

    const {repoUrl, workspaceSlug: backendSlug} = tokenData
    this.verboseLog('WorkspaceBootstrap', {repoUrl: displayUrl(repoUrl), backendSlug})

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
    } catch (error: unknown) {
      return this.err(`Push failed: ${String(error)}`)
    }

    // Write the workspace pin into `quonfig.json` (Guard 1 in
    // project/plans/cli-git-sync.md). If the pin already exists and disagrees,
    // we keep what is there — bootstrap is for fresh cases, not re-pinning.
    // If we do write it, commit and push so the bootstrap leaves no
    // uncommitted changes behind.
    //
    // The pin is stored as `<org-slug>/<workspace-slug>`. The backend's
    // `workspaceSlug` is just the workspace component today; until the
    // server returns the slash form, we skip the write rather than
    // emitting a bare slug.
    const backendPin = tryParseWorkspacePin(backendSlug)
    try {
      const existingPin = await readWorkspaceSlug(resolvedDir)
      const existingFormatted = existingPin ? `${existingPin.orgSlug}/${existingPin.workspaceSlug}` : undefined

      if (!backendPin) {
        this.verboseLog(
          'WorkspaceBootstrap',
          `Backend workspaceSlug "${backendSlug}" is not in <org>/<ws> form; skipping pin write.`,
        )
      } else if (
        existingPin &&
        (existingPin.orgSlug !== backendPin.orgSlug || existingPin.workspaceSlug !== backendPin.workspaceSlug)
      ) {
        const backendFormatted = `${backendPin.orgSlug}/${backendPin.workspaceSlug}`
        this.log('')
        this.log(
          `Warning: quonfig.json already pins workspace "${existingFormatted}", but the backend says this workspace is "${backendFormatted}".`,
        )
        this.log('Leaving the existing pin in place. If this is wrong, edit quonfig.json manually and re-run.')
      } else if (existingPin) {
        this.verboseLog('WorkspaceBootstrap', `quonfig.json already pinned to ${existingFormatted}; no-op.`)
      } else {
        const backendFormatted = `${backendPin.orgSlug}/${backendPin.workspaceSlug}`
        this.log('')
        this.log(`Pinning quonfig.json to workspace "${backendFormatted}"...`)
        await writeWorkspaceSlug(resolvedDir, backendPin)
        await this.commitAndPushPin(resolvedDir, backendFormatted, flags.force)
      }
    } catch (error: unknown) {
      // The main push has already succeeded, so don't fail the whole command.
      // Surface the issue clearly so the user knows to follow up.
      this.log('')
      this.log(`Warning: could not write the workspace pin to quonfig.json: ${String(error)}`)
      this.log('The workspace is connected, but you should re-run `qfg pull` to backfill the pin.')
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

  /**
   * Stage, commit, and push the `quonfig.json` pin. Runs after the main
   * bootstrap push so the pin lands as a committed+pushed change rather than
   * an uncommitted local edit. We stage only `quonfig.json` (not `-A`) so we
   * don't accidentally sweep in unrelated user edits.
   */
  private async commitAndPushPin(dir: string, slug: string, force: boolean): Promise<void> {
    // Stage just quonfig.json so we don't accidentally commit other dirty files.
    await runGit(['-C', dir, 'add', 'quonfig.json'])

    // If `git add` produced no staged change (e.g. content matched an earlier
    // version on disk), `git commit` would fail. Check the index first.
    const {stdout: diffStat} = await runGit(['-C', dir, 'diff', '--cached', '--name-only'])
    if (!diffStat.trim()) {
      this.verboseLog('WorkspaceBootstrap', 'quonfig.json pin matches HEAD; no commit needed.')
      return
    }

    await runGit(['-C', dir, 'commit', '-m', `chore: pin quonfig.json to workspace "${slug}"`])

    // Push the new commit using the same force semantics as the main push.
    const pushArgs = ['-C', dir, 'push', 'origin', 'main']
    pushArgs.push(force ? '--force' : '--force-with-lease')
    await runGit(pushArgs)
    this.log(`Pushed pin commit.`)
  }

  private async remoteHasCommits(repoUrl: string): Promise<boolean> {
    const {stdout} = await runGit(['ls-remote', '--heads', repoUrl])
    return stdout.trim().length > 0
  }
}
