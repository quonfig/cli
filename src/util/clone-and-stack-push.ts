import * as fs from 'node:fs'
import * as path from 'node:path'

import {runGit as runGitSafe, spawnGit} from './git-ops.js'

export const MIGRATOR_IDENTITY = {
  name: 'quonfig migrator',
  email: 'migrator@quonfig.com',
} as const

export interface PushIdentity {
  email: string
  name: string
}

/**
 * A single commit to apply on top of the cloned local tree. `apply` writes/deletes
 * files; it must NOT commit. cloneAndStackPush stages and commits with the given
 * author + optional author date.
 */
export interface CommitSpec {
  /** File operations to perform in `localDir` before this commit is staged. */
  apply: (localDir: string) => Promise<void> | void
  /** Commit author. Defaults to the migrator identity. */
  author?: PushIdentity
  /**
   * Optional author/committer date. Passed via GIT_AUTHOR_DATE +
   * GIT_COMMITTER_DATE. Any value `new Date(...)` accepts. Omit to use "now".
   */
  authorDate?: Date | number | string
  /**
   * Commit message. May be a function when the message depends on counts that
   * are only known after `apply` runs (qfg-7eig).
   */
  message: string | (() => string)
}

export interface CloneAndStackPushOptions {
  /** Branch to track and push. Defaults to `main`. */
  branch?: string
  /**
   * One or more commits to layer onto the clone. Commits are applied + committed
   * in order; commits whose `apply` produces no staged changes are silently
   * skipped (no empty commits). All non-empty commits are pushed in a single
   * `git push`.
   */
  commits: CommitSpec[]
  /** Where to clone into, or an existing clone to reuse. */
  localDir: string
  /** Gitea repo URL (may include token). */
  remoteUrl: string
}

export interface CloneAndStackPushResult {
  /** `'cloned'` if we had to clone fresh, `'reused'` if the local dir was already a clone of the remote. */
  action: 'cloned' | 'reused'
  /** SHA of the LAST commit landed (back-compat alias for the final entry in commitShas). Null when no commit landed. */
  commitSha: string | null
  /** SHAs of every commit landed, in order. Empty when no commit landed. */
  commitShas: string[]
  /** `false` if every commit's `apply` produced no changes — nothing was committed or pushed. */
  committed: boolean
}

const redactToken = (s: string): string => s.replaceAll(/:([^\s/@]+)@/g, ':***@')

export class PushConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PushConflictError'
  }
}

export class PushHookRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PushHookRejectedError'
  }
}

const runGit = async (cwd: string, args: string[]): Promise<{stdout: string; stderr: string}> => {
  try {
    return await runGitSafe(args, {cwd})
  } catch (error: unknown) {
    const e = error as {stderr?: string; stdout?: string} & Error
    const stderr = redactToken(e.stderr ?? '')
    const stdout = redactToken(e.stdout ?? '')
    const message = redactToken(e.message || String(error))
    const wrapped = new Error(`${message}\n${stderr}`.trim()) as {
      stderr?: string
      stdout?: string
    } & Error
    wrapped.stderr = stderr
    wrapped.stdout = stdout
    throw wrapped
  }
}

/**
 * True only when `dir` is itself the root of a git repo. Uses `--show-prefix`
 * (relative path from enclosing toplevel down to `dir`, empty when `dir` IS
 * the toplevel) to avoid cross-platform path-string pitfalls — see the
 * matching comment in cli/src/migrate/local-write.ts (qfg-wu85).
 */
const isGitRepo = async (dir: string): Promise<boolean> => {
  try {
    const {stdout} = await runGitSafe(['-C', dir, 'rev-parse', '--show-prefix'])
    return stdout.trim() === ''
  } catch {
    return false
  }
}

const getOriginUrl = async (dir: string): Promise<string | null> => {
  try {
    const {stdout} = await runGitSafe(['-C', dir, 'remote', 'get-url', 'origin'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

const normalizeRemoteUrl = (url: string): string => redactToken(url.replace(/\.git$/, '').trim())

const ensureCloneOrReuse = async (
  remoteUrl: string,
  localDir: string,
  branch: string,
): Promise<'cloned' | 'reused'> => {
  if (fs.existsSync(localDir) && (await isGitRepo(localDir))) {
    const origin = await getOriginUrl(localDir)
    if (origin && normalizeRemoteUrl(origin) === normalizeRemoteUrl(remoteUrl)) {
      // Reuse: fetch + ff-merge
      await runGit(localDir, ['fetch', 'origin', branch])
      await runGit(localDir, ['checkout', branch])
      await runGit(localDir, ['merge', '--ff-only', `origin/${branch}`])
      return 'reused'
    }

    throw new Error(
      `Local dir ${localDir} is a git repo but its origin (${origin ? redactToken(origin) : 'unset'}) does not match the target remote.\n` +
        `Refuse to clobber.\n\n` +
        `Most likely cause: you ran \`qfg migrate --dir ${localDir}\` first (which \`git init\`s a fresh repo with no remote) and are now trying to \`--push\` from the same dir.\n\n` +
        `Pick one of:\n` +
        `  - Re-run with \`--push\` against a NEW empty/non-existent path (the canonical flow).\n` +
        `  - Run \`qfg pull --workspace <org/slug> --dir ${localDir}-clone\` to seed a fresh clone, then \`qfg migrate --dir ${localDir}-clone --workspace <org/slug> --push\`.\n` +
        `Docs: https://docs.quonfig.com/docs/migrating/from-launch (Flow B).`,
    )
  }

  if (fs.existsSync(localDir)) {
    const entries = fs.readdirSync(localDir)
    if (entries.length > 0) {
      throw new Error(
        `Local dir ${localDir} exists and is not empty, but is not a git clone of ${redactToken(remoteUrl)}. Refuse to clobber.`,
      )
    }
  }

  fs.mkdirSync(path.dirname(localDir), {recursive: true})
  await runGit(path.dirname(localDir) || '.', ['clone', '--branch', branch, remoteUrl, localDir])
  return 'cloned'
}

const hasStagedChanges = async (dir: string): Promise<boolean> => {
  const {stdout} = await runGitSafe(['-C', dir, 'status', '--porcelain'])
  return stdout.trim().length > 0
}

const toGitDate = (value: Date | number | string): string => {
  // Normalize via Date so any of the three accepted shapes round-trips through
  // git's ISO-8601 parser cleanly.
  const d = value instanceof Date ? value : new Date(value)
  return d.toISOString()
}

/**
 * Apply + commit a sequence of CommitSpecs against an existing repo at `localDir`.
 * Per-commit author/date come from each spec (defaults to migrator identity, "now").
 * Empty commits — where `apply` produces no staged changes — are silently skipped.
 * Does NOT clone, fetch, or push: callers handle network I/O. Used by
 * `cloneAndStackPush` for cloud pushes and by the local migrator for `--full-summary`
 * imports into a `git init`-ed dir.
 */
export const stackCommits = async (localDir: string, commits: CommitSpec[]): Promise<{commitShas: string[]}> => {
  const commitShas: string[] = []
  for (const spec of commits) {
    const author = spec.author ?? MIGRATOR_IDENTITY

    // eslint-disable-next-line no-await-in-loop
    await spec.apply(localDir)
    // eslint-disable-next-line no-await-in-loop
    await runGitSafe(['-C', localDir, 'add', '--all'])

    // eslint-disable-next-line no-await-in-loop
    if (!(await hasStagedChanges(localDir))) {
      // No-op commits are silently skipped (qfg-3uks: no empty commits, ever).
      continue
    }

    const message = typeof spec.message === 'function' ? spec.message() : spec.message
    const env: Record<string, string> = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    }
    if (spec.authorDate !== undefined) {
      const iso = toGitDate(spec.authorDate)
      env.GIT_AUTHOR_DATE = iso
      env.GIT_COMMITTER_DATE = iso
    }

    // eslint-disable-next-line no-await-in-loop
    await spawnGit(['-C', localDir, 'commit', '-F', '-'], {stdin: message, env})

    // eslint-disable-next-line no-await-in-loop
    const {stdout: sha} = await runGitSafe(['-C', localDir, 'rev-parse', 'HEAD'])
    commitShas.push(sha.trim())
  }

  return {commitShas}
}

export const cloneAndStackPush = async (opts: CloneAndStackPushOptions): Promise<CloneAndStackPushResult> => {
  const branch = opts.branch ?? 'main'
  if (opts.commits.length === 0) {
    throw new Error('cloneAndStackPush: commits array must contain at least one entry')
  }

  const action = await ensureCloneOrReuse(opts.remoteUrl, opts.localDir, branch)

  // Pin a stable committer identity on the repo. Per-commit author overrides
  // happen via env vars in stackCommits; this default catches the case where a
  // CommitSpec omits `author` entirely.
  await runGit(opts.localDir, ['config', 'user.name', MIGRATOR_IDENTITY.name])
  await runGit(opts.localDir, ['config', 'user.email', MIGRATOR_IDENTITY.email])

  const {commitShas} = await stackCommits(opts.localDir, opts.commits)

  if (commitShas.length === 0) {
    return {action, committed: false, commitSha: null, commitShas: []}
  }

  try {
    // Plain push — no force, no force-with-lease. If the remote has advanced, we fail
    // and surface a conflict; we do NOT clobber UI edits.
    await runGit(opts.localDir, ['push', 'origin', branch])
  } catch (error: unknown) {
    const e = error as {stderr?: string} & Error
    const stderr = e.stderr ?? ''
    const combined = `${e.message}\n${stderr}`
    const detail = redactToken(stderr || e.message)
    // Pre-receive / update hook rejections are functionally distinct from fast-forward
    // conflicts: nothing the user can do by re-fetching will help. Route them to a
    // different lead-in so the hook output (e.g. qfg-verify FAILED ...) is the call to action.
    if (/hook declined|\[remote rejected]/i.test(combined)) {
      throw new PushHookRejectedError(
        `Push to origin/${branch} was rejected by the remote validation hook. Fix the errors below and push again. Original git error:\n${detail}`,
      )
    }

    if (/non-fast-forward|fetch first|rejected/i.test(combined)) {
      throw new PushConflictError(
        `Push to origin/${branch} was rejected: the remote has changes we do not have locally. Re-run the migrator to pick up those changes, then push again. Original git error:\n${detail}`,
      )
    }

    throw error
  }

  return {action, committed: true, commitSha: commitShas.at(-1) ?? null, commitShas}
}
