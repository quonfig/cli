/**
 * A shallow, read-only snapshot of a workspace repo at `main`'s tip: what a
 * secret write reads `quonfig.json`, the existing `secrets/<key>.json` and
 * the other families from, and whose HEAD sha is the write's lock
 * (`configs.push` `expectedSha`). Bead qfg-mol-hle, plan section 0.
 *
 * Credentials. The clone URL carries a Gitea token. `git clone <url>` (what
 * `qfg generate` and the `qfg push` probe do) stores that URL, token
 * included, as `remote.origin.url` in the clone's `.git/config`. Here the
 * repo is created empty and the tip is fetched BY URL, which records no
 * remote at all; `FETCH_HEAD` (which names the source) is deleted after the
 * checkout. Nothing in the clone's `.git` names the URL afterwards. git runs
 * through `runGit` (no credential helper, no prompts, tokens redacted from
 * errors). The temp directory is removed on every failure inside this
 * module, and by `cleanup()` / `withWorkspaceSnapshot` otherwise.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {BaseCommand} from '../index.js'

import {KNOWN_DIRS} from '../verify/validate.js'
import {runGit} from '../util/git-ops.js'

export type PooledKeyMatch = {dir: string; file: string; key: string}

export interface WorkspaceSnapshot {
  /** Remove the clone. Safe to call more than once. */
  cleanup(): Promise<void>
  dir: string
  /** Every top-level file under the validated directories (src/verify KNOWN_DIRS), path -> text. */
  documents(): Map<string, string>
  /** Documents in any family whose key equals `key` case-insensitively (keys are pooled, spec 11.6). */
  findKey(key: string): PooledKeyMatch[]
  /** True when `secrets/` holds at least one document (spec 13.4: the first-secret notice). */
  hasSecrets(): boolean
  /** The commit the snapshot is at: the lock for a write built from it. */
  headSha: string
  /** Names of the `*.json` files directly in `subdir` (none when it does not exist). */
  listJson(subdir: string): string[]
  /** Text of a file in the snapshot, or undefined when it does not exist. */
  readFile(relPath: string): string | undefined
}

export type SnapshotOptions = {
  /** Branch to snapshot (default main, the only branch a workspace writes to). */
  branch?: string
  /** Where the temp directory goes (default the OS temp directory). For tests. */
  tmpRoot?: string
}

const SHA_RE = /^[\da-f]{40}([\da-f]{24})?$/

const removeDir = (dir: string) => fs.promises.rm(dir, {force: true, maxRetries: 3, recursive: true})

/** Resolve `rel` inside `dir`, refusing anything that escapes it or reaches `.git`. */
function inside(dir: string, rel: string): string {
  const parts = rel.split(/[/\\]/)
  if (path.isAbsolute(rel) || parts.includes('..') || parts[0] === '.git' || rel.length === 0) {
    throw new Error(`${JSON.stringify(rel)} is outside the workspace snapshot`)
  }

  return path.join(dir, ...parts)
}

function snapshotAt(dir: string, headSha: string): WorkspaceSnapshot {
  const readFile = (rel: string) => {
    try {
      return fs.readFileSync(inside(dir, rel), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  const entries = (subdir: string) => {
    try {
      return fs.readdirSync(inside(dir, subdir), {withFileTypes: true}).filter((d) => d.isFile())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return []
      throw error
    }
  }

  const listJson = (subdir: string) =>
    entries(subdir)
      .map((d) => d.name)
      .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
      .sort()

  let removed: Promise<void> | undefined
  return {
    cleanup() {
      removed ??= removeDir(dir)
      return removed
    },
    dir,
    documents() {
      const out = new Map<string, string>()
      for (const sub of [...KNOWN_DIRS].sort()) {
        for (const d of entries(sub)) out.set(`${sub}/${d.name}`, readFile(`${sub}/${d.name}`) ?? '')
      }

      return out
    },
    findKey(key: string) {
      const wanted = key.toLowerCase()
      const out: PooledKeyMatch[] = []
      for (const sub of [...KNOWN_DIRS].sort()) {
        for (const name of listJson(sub)) {
          const k = name.slice(0, -'.json'.length)
          if (k.toLowerCase() === wanted) out.push({dir: sub, file: `${sub}/${name}`, key: k})
        }
      }

      return out
    },
    hasSecrets: () => listJson('secrets').length > 0,
    headSha,
    listJson,
    readFile,
  }
}

/**
 * Snapshot `branch` (default main) of the repo at `repoUrl` into a new temp
 * directory: depth 1, no tags, no remote recorded. The caller must call
 * `cleanup()`; prefer `withWorkspaceSnapshot`.
 */
export async function cloneWorkspaceSnapshot(
  repoUrl: string,
  options: SnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const branch = options.branch ?? 'main'
  const dir = await fs.promises.mkdtemp(path.join(options.tmpRoot ?? os.tmpdir(), 'qfg-secret-snapshot-'))
  try {
    await runGit(['init', '-q', dir])
    // Fetch by URL: no remote (and so no URL) is written to .git/config.
    await runGit(['-C', dir, 'fetch', '-q', '--depth', '1', '--no-tags', repoUrl, `refs/heads/${branch}`])
    const {stdout} = await runGit(['-C', dir, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    const headSha = stdout.trim()
    if (!SHA_RE.test(headSha)) throw new Error(`workspace snapshot: unexpected HEAD ${JSON.stringify(headSha)}`)
    await runGit(['-C', dir, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', headSha])
    // FETCH_HEAD names the fetch source; nothing reads it after this point.
    await fs.promises.rm(path.join(dir, '.git', 'FETCH_HEAD'), {force: true})
    return snapshotAt(dir, headSha)
  } catch (error) {
    await removeDir(dir)
    throw error
  }
}

/** Snapshot, run `fn`, and remove the snapshot whatever happens. */
export async function withWorkspaceSnapshot<T>(
  repoUrl: string,
  fn: (snapshot: WorkspaceSnapshot) => Promise<T>,
  options: SnapshotOptions = {},
): Promise<T> {
  const snapshot = await cloneWorkspaceSnapshot(repoUrl, options)
  try {
    return await fn(snapshot)
  } finally {
    await snapshot.cleanup()
  }
}

type ReadToken = {expiresAt: null | string; repoUrl: string; token: string}

export type SnapshotDeps = {
  clone: (repoUrl: string) => Promise<WorkspaceSnapshot>
  /** A stored read token that is still valid, else null. */
  loadToken: (workspaceId: string) => Promise<null | ReadToken>
  mintToken: (workspaceId: string, orgSlug: string) => Promise<ReadToken>
  resolveWorkspace: (workspace: string | undefined) => Promise<{orgSlug: string; workspaceId: string}>
  verbose?: (message: string) => void
}

const looksLike401 = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('401') || message.toLowerCase().includes('authentication failed')
}

/**
 * Snapshot the workspace a command acts on, with the same token handling as
 * `qfg pull` / `qfg generate`: a stored unexpired read token, else a freshly
 * minted one, and one re-mint on a 401.
 */
export async function openWorkspaceSnapshot(
  workspace: string | undefined,
  deps: SnapshotDeps,
): Promise<{orgSlug: string; snapshot: WorkspaceSnapshot; workspaceId: string}> {
  const {orgSlug, workspaceId} = await deps.resolveWorkspace(workspace)
  let token = await deps.loadToken(workspaceId)
  if (!token) {
    deps.verbose?.('Minting a Gitea read token for the workspace snapshot')
    token = await deps.mintToken(workspaceId, orgSlug)
  }

  let snapshot: WorkspaceSnapshot
  try {
    snapshot = await deps.clone(token.repoUrl)
  } catch (error) {
    if (!looksLike401(error)) throw error
    deps.verbose?.('Snapshot got a 401; minting a fresh read token')
    snapshot = await deps.clone((await deps.mintToken(workspaceId, orgSlug)).repoUrl)
  }

  return {orgSlug, snapshot, workspaceId}
}

/** The real dependencies of `openWorkspaceSnapshot` for a command. */
export async function defaultSnapshotDeps(command: BaseCommand): Promise<SnapshotDeps> {
  const [{resolveWorkspaceUuid}, {isGiteaTokenExpired, loadGiteaToken}, {mintAndStoreGiteaReadToken}] =
    await Promise.all([
      import('../util/resolve-workspace.js'),
      import('../util/gitea-token-storage.js'),
      import('../util/gitea-api.js'),
    ])
  return {
    clone: (repoUrl) => cloneWorkspaceSnapshot(repoUrl),
    async loadToken(workspaceId) {
      const entry = await loadGiteaToken(workspaceId)
      return entry && !isGiteaTokenExpired(entry) ? entry : null
    },
    mintToken: (workspaceId, orgSlug) => mintAndStoreGiteaReadToken(workspaceId, orgSlug),
    resolveWorkspace: (workspace) => resolveWorkspaceUuid(command, workspace),
    verbose: (message) => command.verboseLog('secrets', message),
  }
}
