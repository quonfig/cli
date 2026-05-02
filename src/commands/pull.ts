import * as path from 'node:path'
import * as fs from 'node:fs'

import {Flags} from '@oclif/core'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {loadGiteaToken, isGiteaTokenExpired, saveGiteaToken} from '../util/gitea-token-storage.js'
import {mintAndStoreGiteaReadToken, mintGiteaToken} from '../util/gitea-api.js'
import {readWorkspaceSlug, tryParseWorkspacePin, writeWorkspaceSlug} from '../util/quonfig-json.js'
import {resolveWorkspaceUuid} from '../util/resolve-workspace.js'
import {
  isGitRepo,
  getRemoteUrl,
  gitFetch,
  gitSetRemote,
  canFastForward,
  hasDivergedFromRemote,
  gitMergeFfOnly,
  gitClone,
  displayUrl,
  addAndCommitFile,
  dirtyTrackedFiles,
} from '../util/git-ops.js'

export default class Pull extends BaseCommand {
  static description = `Clone or update a local copy of your workspace config files.

Use this when you need to edit flag JSON directly — for complex targeting rules,
multi-rule configs, or anything beyond a single scalar value.

For the config file format, operator reference, and examples:
  qfg config-schema              # human-readable reference
  qfg config-schema --json-schema  # machine-readable JSON Schema

After editing files:
  qfg verify <dir>               # validate JSON before pushing
  git -C <dir> add -A && git -C <dir> commit -m "feat: ..." && git -C <dir> push

CLI shortcuts (no JSON editing needed for simple cases):
  qfg set-rollout my.flag --environment production --true-percent 20
  qfg set-default my.flag --environment production --value true`

  static examples = ['<%= config.bin %> pull --dir ./our-config', '<%= config.bin %> pull  # uses QUONFIG_DIR env var']

  static flags = {
    dir: Flags.string({
      description: 'Local directory to clone/update (defaults to QUONFIG_DIR env var)',
    }),
    workspace: Flags.string({
      description: 'Workspace ID (defaults to active profile)',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Pull)

    // Resolve target directory
    const dir = flags.dir || process.env.QUONFIG_DIR
    if (!dir) {
      return this.err('No directory specified. Use --dir <path> or set QUONFIG_DIR.')
    }

    const resolvedDir = path.resolve(dir)

    // Resolve workspace ID — supports both OAuth and QUONFIG_API_KEY paths,
    // mirroring what APICommand does via get-client.ts so `qfg pull` behaves
    // the same in CI as `qfg create` or `qfg push`.
    const {workspaceId, orgSlug} = await resolveWorkspaceUuid(this, flags.workspace)

    this.verboseLog('Pull', {workspaceId, orgSlug, dir: resolvedDir})

    // Get or mint Gitea read token
    const tokenEntry = await this.resolveTokenEntry(workspaceId, orgSlug)
    const repoUrl = tokenEntry.repoUrl

    // Perform git operation
    const isRepo = await isGitRepo(resolvedDir)

    if (isRepo) {
      // Existing repo — check remote
      const existingRemote = await getRemoteUrl(resolvedDir)
      const expectedUrlBase = stripAuth(repoUrl)

      if (existingRemote && stripAuth(existingRemote) !== expectedUrlBase) {
        return this.err(
          `Directory has a different git remote:\n  existing: ${displayUrl(existingRemote)}\n  expected: ${expectedUrlBase}\n\nResolve manually or use a different --dir.`,
        )
      }

      // Update the remote URL to use current (possibly refreshed) token
      await gitSetRemote(resolvedDir, repoUrl)

      // Note: we intentionally don't pre-check for untracked or modified files.
      // Plain `git pull` is fine with untracked files, and `git merge --ff-only`
      // below will fail loudly on real conflicts (tracked modifications, or an
      // incoming commit that would overwrite an untracked file). Pre-checking
      // just creates a self-trap when qfg itself writes files like
      // `.qfg-friction.log` into the workspace dir (qfg-q2l).

      // Fetch
      this.log('Fetching from remote...')
      try {
        await gitFetch(resolvedDir)
      } catch (error: unknown) {
        if (this.looksLike401(error)) {
          this.verboseLog('Pull', 'Got 401 on fetch, refreshing Gitea token...')
          const freshUrl = await this.refreshAndGetUrl(workspaceId, orgSlug)
          await gitSetRemote(resolvedDir, freshUrl)
          await gitFetch(resolvedDir)
        } else {
          throw error
        }
      }

      const ff = await canFastForward(resolvedDir)
      const diverged = !ff && (await hasDivergedFromRemote(resolvedDir))

      if (diverged) {
        return this.err('Local commits diverge from remote — resolve manually.')
      }

      if (ff) {
        const newCommits = await gitMergeFfOnly(resolvedDir)
        if (newCommits.length > 0) {
          this.log(`Pulled ${newCommits.length} new commit(s):`)
          for (const msg of newCommits) {
            this.log(`  - ${msg}`)
          }
        } else {
          this.log('Updated successfully.')
        }
      } else {
        this.log('Already up to date.')
        // Don't early-return: we still want to run the post-pull work
        // below (QUONFIG_DIR write, workspace pin backfill+commit).
      }
    } else {
      // Clone fresh
      this.log(`Cloning workspace into ${resolvedDir}...`)
      try {
        await gitClone(repoUrl, resolvedDir)
      } catch (error: unknown) {
        // On 401, refresh token and retry once
        if (this.looksLike401(error)) {
          this.verboseLog('Pull', 'Got 401, refreshing Gitea token...')
          const freshUrl = await this.refreshAndGetUrl(workspaceId, orgSlug)
          await gitClone(freshUrl, resolvedDir)
        } else {
          throw error
        }
      }

      this.log(`Cloned successfully into ${resolvedDir}`)
    }

    // Write QUONFIG_DIR to ~/.quonfig/config if not set
    await this.maybeWriteQuonfigDir(resolvedDir)

    // Backfill the `workspace` pin in `quonfig.json` if missing
    // (Guard 1 in project/plans/cli-git-sync.md). When the workspace dir
    // is a git repo, we also commit the new pin so it's included in the
    // user's next `qfg push` delta — push diffs HEAD vs origin, so a
    // working-tree-only write would never reach the server (qfg-0fn).
    await this.backfillWorkspacePin(resolvedDir, tokenEntry, workspaceId, orgSlug)

    return {dir: resolvedDir, workspaceId}
  }

  /**
   * Wraps `readWorkspaceSlug` so a legacy bare-slug value (`"workspace":
   * "foo"` instead of `"workspace": "org/foo"`) reads as `undefined`
   * rather than throwing. The caller then takes the "no pin set" branch
   * and overwrites with the canonical form, completing the migration.
   *
   * Any other parse error still resolves to `undefined` here (and is
   * verbose-logged) — backfill is non-fatal; the next push surfaces the
   * real diagnosis.
   */
  private async readPinTolerant(dir: string) {
    try {
      return await readWorkspaceSlug(dir)
    } catch (error: unknown) {
      this.verboseLog('Pull', `quonfig.json workspace pin needs migration: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Local-only backfill of the `workspace` pin in `quonfig.json`.
   *
   * - Missing pin → write it from the token response's `workspaceSlug`.
   * - Pin already set and matches → no-op.
   * - Pin already set and disagrees → log a warning showing both values
   *   and LEAVE IT ALONE. Overwriting someone's explicit pin is a Guard 2
   *   concern, not a pull concern — the next `qfg push` is where the
   *   identity-check dispatches a hard abort.
   *
   * This never throws — a broken `quonfig.json` shouldn't fail `qfg pull`.
   */
  private async backfillWorkspacePin(
    dir: string,
    tokenEntry: {workspaceSlug?: string},
    workspaceId: string,
    orgSlug: string,
  ): Promise<void> {
    let backendSlug = tokenEntry.workspaceSlug
    if (!backendSlug) {
      // Older cached entries lack the slug. Mint a fresh one solely to learn the
      // slug. Cheap (one API call), and the refresh updates the cache for next time.
      try {
        const fresh = await mintAndStoreGiteaReadToken(workspaceId, orgSlug)
        backendSlug = fresh.workspaceSlug
      } catch (error: unknown) {
        this.verboseLog('Pull', `Could not mint token to learn workspace slug: ${String(error)}`)
        return
      }
    }

    if (!backendSlug) {
      this.verboseLog('Pull', 'Backend did not return a workspaceSlug; skipping pin backfill.')
      return
    }

    // The pin is stored as `<org-slug>/<workspace-slug>`. The backend's
    // mint-token still returns the bare workspace component; we already
    // resolved the org separately during workspace lookup, so combine the
    // two halves locally. If the backend ever upgrades to returning slash
    // form, tryParseWorkspacePin handles it; the explicit org overrides
    // any mismatch in favor of the workspace we actually authenticated as.
    const parsedBackend = tryParseWorkspacePin(backendSlug)
    const backendPin = parsedBackend ?? {orgSlug, workspaceSlug: backendSlug}

    try {
      const existingPin = await this.readPinTolerant(dir)
      if (!existingPin) {
        await writeWorkspaceSlug(dir, backendPin)
        const formatted = `${backendPin.orgSlug}/${backendPin.workspaceSlug}`
        this.verboseLog('Pull', `Backfilled workspace pin "${formatted}" into quonfig.json.`)
        await this.commitPinIfRepo(dir, formatted)
        return
      }

      if (existingPin.orgSlug !== backendPin.orgSlug || existingPin.workspaceSlug !== backendPin.workspaceSlug) {
        const existingFormatted = `${existingPin.orgSlug}/${existingPin.workspaceSlug}`
        const backendFormatted = `${backendPin.orgSlug}/${backendPin.workspaceSlug}`
        this.log('')
        this.log(
          `Warning: quonfig.json pins workspace "${existingFormatted}", but the backend says this workspace is "${backendFormatted}".`,
        )
        this.log('Leaving the existing pin in place. Run `qfg push` to see the full identity check.')
      }
    } catch (error: unknown) {
      // Non-fatal — pull itself already succeeded.
      this.verboseLog('Pull', `Could not backfill workspace pin: ${String(error)}`)
    }
  }

  /**
   * Commit the freshly-written pin if `dir` is a git repo. Only commits
   * when `quonfig.json` is the only thing dirty in the working tree —
   * we don't want to sweep up the user's unrelated work-in-progress
   * (untracked files are fine; tracked modifications are not).
   *
   * Skips silently when not in a git repo, when other tracked files are
   * dirty, or when git itself errors. Pull already succeeded; this is
   * cleanup that the next push can also do (qfg-0fn).
   */
  private async commitPinIfRepo(dir: string, slug: string): Promise<void> {
    try {
      if (!(await isGitRepo(dir))) return

      const dirty = await dirtyTrackedFiles(dir)
      const otherDirty = dirty.filter((p) => p !== 'quonfig.json')
      if (otherDirty.length > 0) {
        this.verboseLog('Pull', `Other tracked files dirty (${otherDirty.join(', ')}); skipping pin commit.`)
        return
      }

      const committed = await addAndCommitFile(dir, 'quonfig.json', `qfg: pin workspace = ${slug}`)
      if (committed) {
        this.log(`Committed workspace pin "${slug}" to quonfig.json.`)
      }
    } catch (error: unknown) {
      this.verboseLog('Pull', `Could not commit workspace pin: ${String(error)}`)
    }
  }

  private looksLike401(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('401') || msg.toLowerCase().includes('authentication failed')
  }

  private async maybeWriteQuonfigDir(dir: string): Promise<void> {
    if (process.env.QUONFIG_DIR) return // already set via env

    const pathMod = await import('node:path')
    const {getQuonfigConfigHome} = await import('../util/quonfig-home.js')
    const configFilePath = pathMod.join(getQuonfigConfigHome(), 'config')

    try {
      const existing = await fs.promises.readFile(configFilePath, 'utf8').catch(() => '')
      if (existing.includes('QUONFIG_DIR') || existing.includes('quonfig_dir')) return

      const line = `\nQUONFIG_DIR = ${dir}\n`
      await fs.promises.appendFile(configFilePath, line, 'utf8')
      this.verboseLog('Pull', `Wrote QUONFIG_DIR to ${configFilePath}`)
    } catch {
      // Non-fatal
    }
  }

  private async refreshAndGetUrl(workspaceId: string, orgSlug: string): Promise<string> {
    const data = await mintGiteaToken(workspaceId, orgSlug, 'read', 'pull')
    const entry = {
      token: data.token,
      repoUrl: data.repoUrl,
      expiresAt: data.expiresAt,
      workspaceSlug: data.workspaceSlug,
    }
    await saveGiteaToken(workspaceId, entry)
    return entry.repoUrl
  }

  private async resolveTokenEntry(
    workspaceId: string,
    orgSlug: string,
  ): Promise<{repoUrl: string; workspaceSlug?: string}> {
    let entry = await loadGiteaToken(workspaceId)

    if (!entry || isGiteaTokenExpired(entry)) {
      this.verboseLog('Pull', 'Minting new Gitea read token...')
      entry = await mintAndStoreGiteaReadToken(workspaceId, orgSlug)
    }

    return entry
  }
}

/**
 * Strip auth credentials from a git URL for comparison purposes.
 * Converts `https://user:token@host/path` to `https://host/path`.
 */
function stripAuth(url: string): string {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    // Not a valid URL (e.g. SSH) — return as-is
    return url
  }
}
