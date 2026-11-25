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
 * module, and by `cleanup()` / `withWorkspaceSnapshot` otherwise. On
 * SIGINT/SIGTERM mid-write it is left behind in the OS temp directory (no
 * signal handler is installed here); it holds the workspace's committed
 * files and no token.
 *
 * Containment. The push hook accepts symlinks in a workspace repo, so a
 * committed symlink must never make a read return a LOCAL file (which a
 * write would then send as `beforeJson`). Two layers: the checkout runs with
 * `core.symlinks=false`, and every read and listing walks the path with
 * lstat, refusing any component that is a symlink or a git symlink /
 * submodule entry. `.git` (any case), `..` and absolute paths are refused
 * after normalization.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {BaseCommand} from '../index.js'

import {KNOWN_DIRS} from '../verify/validate.js'
import {runGit, streamGitNulEntries} from '../util/git-ops.js'

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
  /**
   * Text of a regular file in the snapshot, or undefined when it does not
   * exist. Throws SnapshotPathError for anything outside the snapshot, in
   * `.git`, or reached through a symlink.
   */
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

/** Thrown for a path the snapshot will not read: outside it, in `.git`, or not a regular file. */
export class SnapshotPathError extends Error {
  constructor(rel: string, why: string) {
    super(`${JSON.stringify(rel)} ${why}`)
    this.name = 'SnapshotPathError'
  }
}

/**
 * The normalized segments of `rel`, a path inside the snapshot. Refuses
 * absolute paths, any `..` segment, and `.git` in any letter case (on a
 * case-insensitive filesystem `.GIT` is the same directory), after
 * normalizing `\`, `./` and repeated separators.
 */
function segmentsOf(rel: string): string[] {
  const outside = () => new SnapshotPathError(rel, 'is outside the workspace snapshot')
  if (typeof rel !== 'string' || rel.length === 0 || rel.includes('\0')) throw outside()
  const slashed = rel.replaceAll('\\', '/')
  if (path.isAbsolute(rel) || slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) throw outside()
  const raw = slashed.split('/')
  if (raw.includes('..')) throw outside()
  const parts = raw.filter((p) => p !== '' && p !== '.')
  if (parts.length === 0 || parts.some((p) => p.toLowerCase() === '.git')) throw outside()
  return parts
}

/**
 * Where a git symlink or submodule entry sits, by path. The checkout runs
 * with `core.symlinks=false`, so such an entry is a small text file on disk
 * holding the link target; this set is what tells it apart from a document.
 *
 * `git ls-tree -r -z` is read as a stream and parsed entry by entry: a
 * workspace of tens of thousands of files lists far more than Node's 1 MiB
 * default output limit for `execFile`, and only the few non-file entries are
 * kept (carry-in S1).
 */
async function nonFileEntries(dir: string): Promise<Set<string>> {
  const out = new Set<string>()
  await streamGitNulEntries(['-C', dir, 'ls-tree', '-r', '-z', '--full-tree', 'HEAD'], (entry) => {
    const tab = entry.indexOf('\t')
    if (tab === -1) return
    const mode = entry.slice(0, entry.indexOf(' '))
    if (mode !== '100644' && mode !== '100755') out.add(entry.slice(tab + 1))
  })
  return out
}

function snapshotAt(dir: string, headSha: string, nonFiles: ReadonlySet<string>): WorkspaceSnapshot {
  /**
   * Resolve `rel` to an on-disk path, checking every component with lstat:
   * none may be a symlink (or a git symlink / submodule entry), the last must
   * be a `kind`. Undefined when a component does not exist.
   */
  const listings = new Map<string, Set<string>>()
  const namesIn = (parent: string): Set<string> => {
    let names = listings.get(parent)
    if (!names) {
      names = new Set(fs.readdirSync(parent))
      listings.set(parent, names)
    }

    return names
  }

  const resolve = (rel: string, kind: 'dir' | 'file'): string | undefined => {
    const parts = segmentsOf(rel)
    let current = dir
    for (const [i, part] of parts.entries()) {
      if (nonFiles.has(parts.slice(0, i + 1).join('/'))) {
        throw new SnapshotPathError(rel, 'is not a regular file in the workspace repo (a symlink or submodule)')
      }

      // On a case-insensitive filesystem (macOS, Windows) lstat finds
      // `DB.json` for `db.json`; the snapshot's paths are git's, which are
      // exact, so the entry must be listed with this exact name.
      if (!namesIn(current).has(part)) return undefined
      current = path.join(current, part)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(current)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
        throw error
      }

      const last = i === parts.length - 1
      const ok = last ? (kind === 'file' ? stat.isFile() : stat.isDirectory()) : stat.isDirectory()
      if (!ok) throw new SnapshotPathError(rel, `is not a regular ${kind} inside the workspace snapshot`)
    }

    return current
  }

  const readFile = (rel: string) => {
    const full = resolve(rel, 'file')
    return full === undefined ? undefined : fs.readFileSync(full, 'utf8')
  }

  /** Regular files directly in `subdir` (symlinks, submodules and directories are left out). */
  const entries = (subdir: string): string[] => {
    const full = resolve(subdir, 'dir')
    if (full === undefined) return []
    const prefix = segmentsOf(subdir).join('/')
    return fs
      .readdirSync(full, {withFileTypes: true})
      .filter((d) => d.isFile() && !nonFiles.has(`${prefix}/${d.name}`))
      .map((d) => d.name)
  }

  const listJson = (subdir: string) =>
    entries(subdir)
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
        for (const name of entries(sub)) out.set(`${sub}/${name}`, readFile(`${sub}/${name}`) ?? '')
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
    // core.symlinks=false: a symlink in the repo is checked out as a small
    // text file, never as a link that could point outside the clone.
    await runGit([
      '-C',
      dir,
      '-c',
      'core.symlinks=false',
      '-c',
      'advice.detachedHead=false',
      'checkout',
      '-q',
      '--detach',
      headSha,
    ])
    // FETCH_HEAD names the fetch source; nothing reads it after this point.
    await fs.promises.rm(path.join(dir, '.git', 'FETCH_HEAD'), {force: true})
    return snapshotAt(dir, headSha, await nonFileEntries(dir))
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
