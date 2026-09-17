import * as path from 'node:path'

import {confirm} from '@inquirer/prompts'
import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getActiveProfile, loadAuthConfig} from '../../util/token-storage.js'
import {mintGiteaToken} from '../../util/gitea-api.js'
import {resolveWorkspaceUuid} from '../../util/resolve-workspace.js'
import {
  isGitRepo,
  hasAtLeastOneCommit,
  gitSetRemote,
  gitFetch,
  configDocumentsAtRef,
  rebaseOntoOriginAndPush,
  getRemoteUrl,
  displayUrl,
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
      description: 'Accepted and ignored (no-op). Bootstrap never rewrites the workspace history.',
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

    // `--force` is kept so pinned scripts don't die on an unknown flag, but a
    // workspace's `main` is append-only: nothing here ever rewrites it.
    if (flags.force) {
      this.log('Note: --force is accepted for compatibility and ignored — bootstrap never rewrites the workspace.\n')
    }

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

    // Set remote
    if (existingRemote) {
      this.log(`Updating remote origin...`)
    } else {
      this.log(`Setting remote origin...`)
    }
    await gitSetRemote(resolvedDir, repoUrl)

    await gitFetch(resolvedDir)

    // Bootstrap is for a FRESH workspace only. "Fresh" is "holds no config
    // documents", NOT "has no commits": provisioning seeds README.md and
    // quonfig.json, so every real workspace arrives with two commits
    // (plan 2026-09-17-tree-derived-cache.md 5.6, 13.2 risk 5).
    const documents = await configDocumentsAtRef(resolvedDir, 'origin/main')
    if (documents.length > 0) {
      const sample = documents.slice(0, 3).join(', ') + (documents.length > 3 ? ', ...' : '')
      this.log(`\nThis workspace already holds ${documents.length} config document(s): ${sample}`)
      this.log(`Bootstrap lands your local history UNDER what is already there, so it is for fresh workspaces only.`)
      this.log(`To send local changes to a workspace that is already in use, run:`)
      this.log(`  qfg push --dir ${resolvedDir}\n`)
      return this.err('Workspace is not empty.')
    }

    // Push. The history is replayed onto the workspace's own head on a
    // temporary worktree and pushed plainly: `main` is append-only, and a
    // force-push silently wedges config delivery (plan 5.6).
    this.log('Pushing to Gitea...')
    let pushResult
    try {
      pushResult = await rebaseOntoOriginAndPush(resolvedDir)
    } catch (error: unknown) {
      return this.err(`Push failed: ${String(error)}`)
    }

    this.log(`Landed ${pushResult.commitsRebased} commit(s) on the workspace's history.`)
    if (pushResult.reconciled) {
      this.log('Added a "reconcile merge resolutions" commit so the workspace tree matches your local files exactly.')
    }

    this.log(`\nBootstrap complete.`)
    this.log(`Workspace "${workspaceName}" now holds the history from ${resolvedDir}.`)
    // The workspace's own `quonfig.json` carries the workspace pin and wins
    // over a local one, so nothing is written back here. The local branch was
    // never moved, so it still points at the pre-bootstrap history.
    this.log(`Your local branch was left where it was; \`qfg pull\` syncs it with the workspace.`)
    this.log(`\nTo keep it in sync locally, run:`)
    this.log(`  qfg sync --watch --dir ${resolvedDir}`)

    return {
      commitsRebased: pushResult.commitsRebased,
      dir: resolvedDir,
      reconciled: pushResult.reconciled,
      repoUrl: displayUrl(repoUrl),
      workspaceId,
    }
  }
}
