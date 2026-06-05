import * as path from 'node:path'

import {Flags} from '@oclif/core'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {loadGiteaToken, isGiteaTokenExpired, saveGiteaToken} from '../util/gitea-token-storage.js'
import {mintGiteaToken} from '../util/gitea-api.js'
import {evaluateOriginGuard} from '../push/identity-check.js'
import {resolveWorkspaceUuid} from '../util/resolve-workspace.js'
import {
  isGitRepo,
  isWorkingTreeClean,
  gitFetch,
  canFastForward,
  hasDivergedFromRemote,
  gitMergeFfOnly,
  gitSetRemote,
  getAllRemoteUrls,
  getRemoteUrl,
  displayUrl,
} from '../util/git-ops.js'

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export default class Sync extends BaseCommand {
  static description = 'Continuously poll for workspace config updates and apply them locally'

  static examples = [
    '<%= config.bin %> sync --watch',
    '<%= config.bin %> sync --watch --interval 10',
    '<%= config.bin %> sync --watch --dir ./our-config --interval 30',
  ]

  static flags = {
    dir: Flags.string({
      description: 'Local directory to sync (defaults to QUONFIG_DIR env var)',
    }),
    interval: Flags.integer({
      default: 60,
      description: 'Poll interval in seconds',
    }),
    watch: Flags.boolean({
      description: 'Run as a continuous polling daemon (required)',
      required: true,
    }),
  }

  private orgSlug!: string
  private resolvedDir!: string
  private workspaceId!: string

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Sync)

    // Resolve directory
    const dir = flags.dir || process.env.QUONFIG_DIR
    if (!dir) {
      return this.err('No directory specified. Use --dir <path> or set QUONFIG_DIR.')
    }

    this.resolvedDir = path.resolve(dir)

    const resolved = await resolveWorkspaceUuid(this, undefined, this.resolvedDir)
    this.workspaceId = resolved.workspaceId
    this.orgSlug = resolved.orgSlug

    // Validate the directory is a git repo
    const isRepo = await isGitRepo(this.resolvedDir)
    if (!isRepo) {
      return this.err(`${this.resolvedDir} is not a git repository. Run \`qfg pull --dir ${this.resolvedDir}\` first.`)
    }

    const intervalSec = flags.interval
    this.log(`Watching ${this.resolvedDir} — polling every ${intervalSec}s. Press Ctrl+C to stop.`)

    // Ensure remote URL is up to date before starting
    await this.ensureRemoteUrl()

    // Run initial sync
    await this.runSync()

    // Poll loop
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(intervalSec * 1000)
      // eslint-disable-next-line no-await-in-loop
      await this.runSync()
    }
  }

  private async ensureRemoteUrl(): Promise<void> {
    const entry = await loadGiteaToken(this.workspaceId)

    if (!entry || isGiteaTokenExpired(entry)) {
      await this.refreshToken()
      return
    }

    await this.setRemoteGuarded(entry.repoUrl)
  }

  private looksLike401(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err)
    return msg.includes('401') || msg.toLowerCase().includes('authentication failed')
  }

  private async refreshToken(): Promise<void> {
    const data = await mintGiteaToken(this.workspaceId, this.orgSlug, 'read', 'pull')
    const entry = {token: data.token, repoUrl: data.repoUrl, expiresAt: data.expiresAt}
    await saveGiteaToken(this.workspaceId, entry)
    await this.setRemoteGuarded(entry.repoUrl)
    this.verboseLog('Sync', 'Token refreshed.')
  }

  private async runSync(): Promise<void> {
    const timestamp = new Date().toISOString()

    try {
      // Ensure token is valid
      await this.ensureRemoteUrl()

      // Fetch
      this.verboseLog('Sync', 'Fetching...')
      await gitFetch(this.resolvedDir)

      // Check if there's anything to do
      const ff = await canFastForward(this.resolvedDir)

      if (!ff) {
        // Check if diverged
        const diverged = await hasDivergedFromRemote(this.resolvedDir)
        if (diverged) {
          this.log(`[${timestamp}] Skipped: local commits diverge from remote. Resolve manually.`)
          return
        }

        this.log(`[${timestamp}] Already up to date.`)
        return
      }

      // Check working tree
      const clean = await isWorkingTreeClean(this.resolvedDir)
      if (!clean) {
        this.log(`[${timestamp}] Skipped: local changes present. Commit or stash first.`)
        return
      }

      // Merge
      const newCommits = await gitMergeFfOnly(this.resolvedDir)

      if (newCommits.length > 0) {
        this.log(`[${timestamp}] Pulled ${newCommits.length} new commit(s):`)
        for (const msg of newCommits) {
          this.log(`  - ${msg}`)
        }
      } else {
        this.log(`[${timestamp}] Updated.`)
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      if (this.looksLike401(error)) {
        this.log(`[${timestamp}] Token expired, refreshing...`)
        try {
          await this.refreshToken()
          await this.ensureRemoteUrl()
        } catch (error: unknown) {
          this.log(`[${timestamp}] Warning: could not refresh token: ${String(error)}`)
        }
      } else {
        this.log(`[${timestamp}] Warning: sync failed: ${msg}`)
      }
    }
  }

  /**
   * Point `origin` at `repoUrl`, but refuse first if the dir already has a
   * remote pointing at a DIFFERENT workspace (qfg-08i). Without this guard,
   * `qfg sync --dir ./our-config` under an unrelated active profile silently
   * rewrites origin to the wrong repo and fetches it in, producing phantom
   * "diverged" state. Mirrors the guard `qfg pull` runs (qfg-glrd.3).
   */
  private async setRemoteGuarded(repoUrl: string): Promise<void> {
    const allRemotes = await getAllRemoteUrls(this.resolvedDir)
    const originUrl = await getRemoteUrl(this.resolvedDir)
    const guard = evaluateOriginGuard(allRemotes, originUrl, repoUrl)

    if (guard.kind === 'no-quonfig-remote') {
      const remoteList = allRemotes.map((r) => `  - ${displayUrl(r)}`).join('\n')
      this.error(
        `Refusing to sync ${this.resolvedDir}: no configured git remote matches the resolved Quonfig workspace.\n` +
          `Configured remotes:\n${remoteList}\n` +
          `Expected: ${displayUrl(repoUrl)}\n\n` +
          `This usually means the active workspace doesn't match this directory. Pin it in quonfig.json ` +
          `(\`"workspace": "<org>/<ws>"\`) or pass the right workspace, then retry — sync will not rewrite origin.`,
        {exit: 1},
      )
    }

    if (guard.kind === 'not-origin') {
      this.error(
        `Refusing to sync ${this.resolvedDir}: the Quonfig remote is not named "origin".\n` +
          `  matching remote: ${displayUrl(guard.matching)}\n` +
          `  origin:          ${originUrl ? displayUrl(originUrl) : '(unset)'}\n\n` +
          `Rename the Quonfig remote to origin, or point origin at ${displayUrl(repoUrl)}.`,
        {exit: 1},
      )
    }

    await gitSetRemote(this.resolvedDir, repoUrl)
  }
}
