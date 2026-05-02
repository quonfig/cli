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

export interface CloneAndStackPushOptions {
  /** Called once `localDir` is a clone synced with origin/main. Must write/delete files under `localDir` — do NOT commit. */
  applyDelta: (localDir: string) => Promise<void> | void
  /** Commit author. Defaults to the migrator identity. */
  author?: PushIdentity
  /** Branch to track and push. Defaults to `main`. */
  branch?: string
  /** Single commit message for the delta. */
  commitMessage: string
  /** Where to clone into, or an existing clone to reuse. */
  localDir: string
  /** Gitea repo URL (may include token). */
  remoteUrl: string
}

export interface CloneAndStackPushResult {
  /** `'cloned'` if we had to clone fresh, `'reused'` if the local dir was already a clone of the remote. */
  action: 'cloned' | 'reused'
  /** SHA of the new commit, if one was made. */
  commitSha: string | null
  /** `false` if `applyDelta` produced no changes — nothing was committed or pushed. */
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

const isGitRepo = async (dir: string): Promise<boolean> => {
  try {
    await runGitSafe(['-C', dir, 'rev-parse', '--git-dir'])
    return true
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
      `Local dir ${localDir} is a git repo but its origin (${origin ? redactToken(origin) : 'unset'}) does not match the target remote. Refuse to clobber — pass an empty/non-existent path or a matching clone.`,
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

export const cloneAndStackPush = async (opts: CloneAndStackPushOptions): Promise<CloneAndStackPushResult> => {
  const branch = opts.branch ?? 'main'
  const author = opts.author ?? MIGRATOR_IDENTITY

  const action = await ensureCloneOrReuse(opts.remoteUrl, opts.localDir, branch)

  // Pin committer identity on the repo so commits are reproducible regardless of host git config.
  await runGit(opts.localDir, ['config', 'user.name', author.name])
  await runGit(opts.localDir, ['config', 'user.email', author.email])

  await opts.applyDelta(opts.localDir)

  await runGit(opts.localDir, ['add', '--all'])

  if (!(await hasStagedChanges(opts.localDir))) {
    return {action, committed: false, commitSha: null}
  }

  await spawnGit(['-C', opts.localDir, 'commit', '-F', '-'], {
    stdin: opts.commitMessage,
    env: {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
    },
  })

  const {stdout: sha} = await runGitSafe(['-C', opts.localDir, 'rev-parse', 'HEAD'])

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

  return {action, committed: true, commitSha: sha.trim()}
}
