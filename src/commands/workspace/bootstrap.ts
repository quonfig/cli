import * as path from 'node:path'

import {confirm} from '@inquirer/prompts'
import {Flags} from '@oclif/core'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getActiveProfile, loadAuthConfig} from '../../util/token-storage.js'
import {mintGiteaToken} from '../../util/gitea-api.js'
import {bootstrapPinMismatch, describeBootstrapTarget} from '../../util/bootstrap-target.js'
import {readWorkspaceSlug} from '../../util/quonfig-json.js'
import {resolveWorkspaceUuid} from '../../util/resolve-workspace.js'
import {
  isGitRepo,
  hasAtLeastOneCommit,
  gitSetRemote,
  gitFetch,
  workspaceDocumentsAtRef,
  rebaseOntoOriginAndPush,
  getRemoteUrl,
  getOriginMainSha,
  displayUrl,
} from '../../util/git-ops.js'

/**
 * How the customer points their clone at the workspace after bootstrap.
 * `pre-bootstrap` keeps their original history; the reset is safe because the
 * pushed tree was proven equal to their tree before the push.
 */
const LOCAL_RESET_RECIPE = 'git branch pre-bootstrap && git fetch origin && git reset --hard origin/main'

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

    // The target is resolved like push/pull/sync resolve theirs: QUONFIG_WORKSPACE,
    // then the directory's quonfig.json pin, then the active profile.
    const {workspaceId, orgSlug} = await resolveWorkspaceUuid(this, undefined, resolvedDir)

    // The pin is read again here for the prompt and for the mismatch guard
    // below. A legacy bare-slug pin reads as "no pin", as it does for push.
    let pin: Awaited<ReturnType<typeof readWorkspaceSlug>>
    try {
      pin = await readWorkspaceSlug(resolvedDir)
    } catch {
      pin = undefined
    }

    // The prompt names whichever source chose the target; the profile only
    // when it IS the resolved workspace (qfg-8p8i).
    const authConfig = await loadAuthConfig()
    const activeProfile = getActiveProfile()
    const profile = authConfig?.profiles[activeProfile] || authConfig?.profiles[authConfig?.defaultProfile || 'default']
    const workspaceName = describeBootstrapTarget({
      envOverride: process.env.QUONFIG_WORKSPACE,
      pin,
      profile,
      workspaceId,
    })

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

    // Guard, as `qfg push` has: a directory pinned to one workspace is not
    // pushed to another. Checked before the remote is touched.
    const mismatch = bootstrapPinMismatch(pin, backendSlug)
    if (mismatch) return this.err(mismatch)

    // Set remote
    if (existingRemote) {
      this.log(`Updating remote origin...`)
    } else {
      this.log(`Setting remote origin...`)
    }
    await gitSetRemote(resolvedDir, repoUrl)

    await gitFetch(resolvedDir)

    // Every workspace repo is provisioned with `main`; no `main` means the
    // workspace is half-created, and the pre-receive hook rejects creating it
    // by push (plan 5.6 item 1).
    if ((await getOriginMainSha(resolvedDir)) === undefined) {
      return this.err(
        'The workspace repository is not provisioned (it has no `main` branch).\nFinish creating the workspace in the Quonfig app, then run bootstrap again.',
      )
    }

    // Bootstrap is for a FRESH workspace only. "Fresh" is "holds no documents",
    // NOT "has no commits": provisioning seeds README.md and quonfig.json, so
    // every real workspace arrives with two commits (plan
    // 2026-09-17-tree-derived-cache.md 5.6, 13.2 risk 5).
    const documents = await workspaceDocumentsAtRef(resolvedDir, 'origin/main')
    if (documents.length > 0) {
      const sample = documents.slice(0, 3).join(', ') + (documents.length > 3 ? ', ...' : '')
      this.log(`\nThis workspace already holds ${documents.length} document(s): ${sample}`)
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
      // Validation runs again against the tree that is actually pushed (which
      // carries the WORKSPACE's quonfig.json, not the local one), so content
      // the server would reject fails here.
      pushResult = await rebaseOntoOriginAndPush(resolvedDir, {validate: !flags['skip-validate']})
    } catch (error: unknown) {
      return this.err(`Push failed: ${String(error)}`)
    }

    this.log(`Landed ${pushResult.commitsRebased} commit(s) on the workspace's history.`)
    if (pushResult.reconcileSubject !== null) {
      this.log(`Added one commit ("${pushResult.reconcileSubject}") so the workspace tree matches your local files.`)
    }

    this.log(`\nBootstrap complete.`)
    this.log(`Workspace "${workspaceName}" now holds the history from ${resolvedDir}.`)
    // The customer's branch is never touched, on success or failure, so it
    // still points at the pre-bootstrap history — which shares no commit with
    // what was just pushed (the replayed commits have new ids). `qfg pull` and
    // `qfg sync` both refuse that state ("diverge" / STALE_HEAD), so the only
    // honest advice is a reset onto the workspace.
    //
    // If we ever move the local branch ourselves (option A: save
    // refs/quonfig/pre-bootstrap and fast-forward `main` to pushedSha once
    // tree equality is proven), this block is what it replaces.
    this.log(`\nYour local branch was not moved. The workspace has the same content under new commit ids.`)
    this.log(`To point this clone at the workspace, keeping your old history on a branch:`)
    this.log(`  ${LOCAL_RESET_RECIPE}`)

    return {
      commitsRebased: pushResult.commitsRebased,
      dir: resolvedDir,
      localResetRecipe: LOCAL_RESET_RECIPE,
      reconciled: pushResult.reconcileSubject !== null,
      repoUrl: displayUrl(repoUrl),
      workspaceId,
    }
  }
}
