import * as path from 'node:path'
import * as fs from 'node:fs'

import {Flags} from '@oclif/core'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getActiveProfile, loadAuthConfig} from '../util/token-storage.js'
import {loadGiteaToken, isGiteaTokenExpired, saveGiteaToken} from '../util/gitea-token-storage.js'
import {mintAndStoreGiteaReadToken, mintGiteaToken} from '../util/gitea-api.js'
import {
  isGitRepo,
  getRemoteUrl,
  isWorkingTreeClean,
  gitFetch,
  gitSetRemote,
  canFastForward,
  hasDivergedFromRemote,
  gitMergeFfOnly,
  gitClone,
  displayUrl,
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

  static examples = [
    '<%= config.bin %> pull --dir ./our-config',
    '<%= config.bin %> pull  # uses QUONFIG_DIR env var',
  ]

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

    // Resolve workspace ID
    let workspaceId = flags.workspace
    if (!workspaceId) {
      const authConfig = await loadAuthConfig()
      if (!authConfig) {
        return this.err('Not logged in. Please run `qfg login` first.')
      }

      const activeProfile = getActiveProfile()
      const profile = authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']
      if (!profile) {
        return this.err('No active profile found. Please run `qfg login` first.')
      }

      workspaceId = profile.workspace
    }

    this.verboseLog('Pull', {workspaceId, dir: resolvedDir})

    // Get or mint Gitea read token
    const repoUrl = await this.resolveRepoUrl(workspaceId)

    // Perform git operation
    const isRepo = await isGitRepo(resolvedDir)

    if (!isRepo) {
      // Clone fresh
      this.log(`Cloning workspace into ${resolvedDir}...`)
      try {
        await gitClone(repoUrl, resolvedDir)
      } catch (err: unknown) {
        // On 401, refresh token and retry once
        if (this.looksLike401(err)) {
          this.verboseLog('Pull', 'Got 401, refreshing Gitea token...')
          const freshUrl = await this.refreshAndGetUrl(workspaceId)
          await gitClone(freshUrl, resolvedDir)
        } else {
          throw err
        }
      }

      this.log(`Cloned successfully into ${resolvedDir}`)
    } else {
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

      // Check working tree
      const clean = await isWorkingTreeClean(resolvedDir)
      if (!clean) {
        return this.err(
          'Local changes present — commit, stash, or run `git reset --hard origin/main` to discard.',
        )
      }

      // Fetch
      this.log('Fetching from remote...')
      try {
        await gitFetch(resolvedDir)
      } catch (err: unknown) {
        if (this.looksLike401(err)) {
          this.verboseLog('Pull', 'Got 401 on fetch, refreshing Gitea token...')
          const freshUrl = await this.refreshAndGetUrl(workspaceId)
          await gitSetRemote(resolvedDir, freshUrl)
          await gitFetch(resolvedDir)
        } else {
          throw err
        }
      }

      const ff = await canFastForward(resolvedDir)
      const diverged = !ff && (await hasDivergedFromRemote(resolvedDir))

      if (diverged) {
        return this.err('Local commits diverge from remote — resolve manually.')
      }

      if (!ff) {
        this.log('Already up to date.')
        return {dir: resolvedDir, newCommits: [], workspaceId}
      }

      // Merge
      const newCommits = await gitMergeFfOnly(resolvedDir)
      if (newCommits.length > 0) {
        this.log(`Pulled ${newCommits.length} new commit(s):`)
        for (const msg of newCommits) {
          this.log(`  - ${msg}`)
        }
      } else {
        this.log('Updated successfully.')
      }
    }

    // Write QUONFIG_DIR to ~/.quonfig/config if not set
    await this.maybeWriteQuonfigDir(resolvedDir)

    return {dir: resolvedDir, workspaceId}
  }

  private async resolveRepoUrl(workspaceId: string): Promise<string> {
    let entry = await loadGiteaToken(workspaceId)

    if (!entry || isGiteaTokenExpired(entry)) {
      this.verboseLog('Pull', 'Minting new Gitea read token...')
      entry = await mintAndStoreGiteaReadToken(workspaceId)
    }

    return entry.repoUrl
  }

  private async refreshAndGetUrl(workspaceId: string): Promise<string> {
    const data = await mintGiteaToken(workspaceId, 'read', 'pull')
    const entry = {token: data.token, repoUrl: data.repoUrl, expiresAt: data.expiresAt}
    await saveGiteaToken(workspaceId, entry)
    return entry.repoUrl
  }

  private looksLike401(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('401') || msg.toLowerCase().includes('authentication failed')
  }

  private async maybeWriteQuonfigDir(dir: string): Promise<void> {
    if (process.env.QUONFIG_DIR) return // already set via env

    const os = await import('node:os')
    const pathMod = await import('node:path')
    const configFilePath = pathMod.join(os.homedir(), '.quonfig', 'config')

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
