import {execFile as execFileCb, spawn} from 'node:child_process'
import * as util from 'node:util'

const execFile = util.promisify(execFileCb)

/**
 * Args prepended to every git invocation. Empty `credential.helper` resets the
 * helper chain for this child process only — prevents macOS git's osxkeychain
 * helper from popping a "Keychain Not Found" dialog when qfg-managed creds are
 * embedded in the URL.
 */
export const GIT_SAFE_ARGS: readonly string[] = ['-c', 'credential.helper=']

/**
 * Env additions for every git invocation. Suppress tty prompts and Git
 * Credential Manager interactive flows.
 */
export const GIT_SAFE_ENV: Readonly<NodeJS.ProcessEnv> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'Never',
}

/**
 * Redact a token from a URL string so it is safe to display to users.
 */
export const redactToken = (url: string): string => url.replace(/:([^/@]+)@/, ':***@')

export interface RunGitOptions {
  cwd?: string
  /** Extra env vars merged on top of `process.env` and `GIT_SAFE_ENV`. */
  env?: NodeJS.ProcessEnv
}

/**
 * Canonical entry point for shelling out to git from the CLI. Always prepends
 * `GIT_SAFE_ARGS` and merges `GIT_SAFE_ENV` so credential prompts never leak
 * to the user. Errors are re-thrown with tokens redacted from message/stderr.
 */
export const runGit = async (args: string[], options?: RunGitOptions): Promise<{stdout: string; stderr: string}> => {
  const env = {...process.env, ...GIT_SAFE_ENV, ...options?.env}
  try {
    return await execFile('git', [...GIT_SAFE_ARGS, ...args], {cwd: options?.cwd, env})
  } catch (error: unknown) {
    const e = error as {stdout?: string; stderr?: string; cmd?: string} & Error
    const message = redactToken(e.message || String(error))
    const stderr = redactToken(e.stderr ?? '')
    const safeErr = new Error(message) as {stderr?: string} & Error
    safeErr.stderr = stderr
    throw safeErr
  }
}

export interface SpawnGitOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** If set, written to the child's stdin and then stdin is closed. */
  stdin?: string
}

/**
 * Spawn-based git invocation for cases where stdin needs to be piped (e.g.
 * `git commit -F -`). Same safe-args/env injection as `runGit`.
 */
export const spawnGit = (args: string[], options?: SpawnGitOptions): Promise<void> =>
  new Promise((resolve, reject) => {
    const env = {...process.env, ...GIT_SAFE_ENV, ...options?.env}
    const child = spawn('git', [...GIT_SAFE_ARGS, ...args], {cwd: options?.cwd, env})
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`git ${args[0] ?? ''} exited ${code}: ${redactToken(stderr)}`))
    })
    if (options?.stdin !== undefined) child.stdin.end(options.stdin)
  })

export const gitClone = async (repoUrl: string, dir: string): Promise<void> => {
  await runGit(['clone', repoUrl, dir])
}

export const isGitRepo = async (dir: string): Promise<boolean> => {
  try {
    await runGit(['-C', dir, 'rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

export const getRemoteUrl = async (dir: string): Promise<string | null> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'remote', 'get-url', 'origin'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export const isWorkingTreeClean = async (dir: string): Promise<boolean> => {
  const {stdout} = await runGit(['-C', dir, 'status', '--porcelain'])
  return stdout.trim() === ''
}

/**
 * Returns true if `file` (relative to `dir`) has any working-tree or
 * staged change, false if its tracked content matches HEAD.
 */
export const hasFileChanges = async (dir: string, file: string): Promise<boolean> => {
  const {stdout} = await runGit(['-C', dir, 'status', '--porcelain', '--', file])
  return stdout.trim() !== ''
}

/**
 * Returns the list of tracked files (relative paths) with working-tree
 * or staged modifications. Untracked files (`??`) are excluded — they
 * are not considered "dirty" by callers that want to know whether the
 * user has work-in-progress that should not be swept into a commit.
 */
export const dirtyTrackedFiles = async (dir: string): Promise<string[]> => {
  const {stdout} = await runGit(['-C', dir, 'status', '--porcelain'])
  return stdout
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.startsWith('??'))
    .map((line) => line.slice(3).trim())
}

/**
 * Stage and commit a single file with the given message. The path argument
 * to `git commit` ensures only this file is committed even if other files
 * are already staged in the index.
 *
 * Returns true if a commit was created, false if there was nothing to
 * commit (file matches HEAD already). Throws on real git errors.
 */
export const addAndCommitFile = async (dir: string, file: string, message: string): Promise<boolean> => {
  if (!(await hasFileChanges(dir, file))) return false
  await runGit(['-C', dir, 'add', '--', file])
  await runGit(['-C', dir, 'commit', '-m', message, '--', file])
  return true
}

/**
 * Read the contents of `file` (relative to `dir`) at HEAD. Returns
 * `undefined` if the file does not exist at HEAD or if HEAD itself is
 * unset (empty repo).
 */
export const readFileAtHead = async (dir: string, file: string): Promise<string | undefined> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'show', `HEAD:${file}`])
    return stdout
  } catch {
    return undefined
  }
}

/**
 * Result of `commitPinFixIfPinOnly`. Tells callers whether a commit was
 * made and, if not, why — useful for verbose logging without throwing on
 * the migration path.
 */
export type PinFixResult = {kind: 'committed'; slug: string} | {kind: 'clean'} | {kind: 'skipped'; reason: string}

/**
 * Migration helper for legacy state where `qfg pull` wrote the workspace
 * pin to the working tree but never committed it (qfg-0fn). If
 * `quonfig.json` is dirty AND its only diff vs HEAD is an added or
 * changed `workspace` key matching `expectedSlug`, stage and commit the
 * file so push's HEAD-vs-origin delta picks it up.
 *
 * Skips (returns `kind: 'skipped'`) when the dirty file has any other
 * changes, when the pin doesn't match the backend slug, or when JSON
 * parsing fails — leaving the user's working tree alone.
 */
export const commitPinFixIfPinOnly = async (dir: string, file: string, expectedSlug: string): Promise<PinFixResult> => {
  if (!(await hasFileChanges(dir, file))) return {kind: 'clean'}

  let workingTreeRaw: string
  try {
    const {readFile} = await import('node:fs/promises')
    const {join} = await import('node:path')
    workingTreeRaw = await readFile(join(dir, file), 'utf8')
  } catch {
    return {kind: 'skipped', reason: 'could not read working-tree file'}
  }

  const headRaw = await readFileAtHead(dir, file)

  let workingParsed: Record<string, unknown>
  try {
    workingParsed = JSON.parse(workingTreeRaw) as Record<string, unknown>
  } catch {
    return {kind: 'skipped', reason: 'working-tree file is not valid JSON'}
  }

  if (typeof workingParsed.workspace !== 'string' || workingParsed.workspace !== expectedSlug) {
    return {kind: 'skipped', reason: 'working-tree workspace pin does not match backend slug'}
  }

  let headParsed: Record<string, unknown> = {}
  if (headRaw !== undefined) {
    try {
      headParsed = JSON.parse(headRaw) as Record<string, unknown>
    } catch {
      return {kind: 'skipped', reason: 'HEAD file is not valid JSON'}
    }
  }

  // Compare working tree vs HEAD ignoring `workspace`. If anything else
  // differs, the user has additional uncommitted edits — leave alone.
  const stripped = (o: Record<string, unknown>): Record<string, unknown> => {
    const {workspace: _ignored, ...rest} = o
    return rest
  }
  const a = JSON.stringify(stripped(workingParsed), Object.keys(stripped(workingParsed)).sort())
  const b = JSON.stringify(stripped(headParsed), Object.keys(stripped(headParsed)).sort())
  if (a !== b) {
    return {kind: 'skipped', reason: 'working-tree file has changes beyond the workspace pin'}
  }

  await runGit(['-C', dir, 'add', '--', file])
  await runGit(['-C', dir, 'commit', '-m', `qfg: pin workspace = ${expectedSlug}`, '--', file])
  return {kind: 'committed', slug: expectedSlug}
}

export const gitFetch = async (dir: string): Promise<void> => {
  await runGit(['-C', dir, 'fetch', 'origin'])
}

/**
 * Returns true if origin/main has commits that can be fast-forwarded into the local branch.
 */
export const canFastForward = async (dir: string): Promise<boolean> => {
  try {
    // Get the local HEAD and origin/main SHAs
    const {stdout: localSha} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: remoteSha} = await runGit(['-C', dir, 'rev-parse', 'origin/main'])

    const local = localSha.trim()
    const remote = remoteSha.trim()

    if (local === remote) return false // already up to date

    // Check if local is an ancestor of remote (i.e. ff is possible)
    try {
      await runGit(['-C', dir, 'merge-base', '--is-ancestor', local, remote])
      return true // exit code 0 means local is an ancestor of remote
    } catch {
      return false // local has diverged
    }
  } catch {
    return false
  }
}

/**
 * Returns true iff origin/main is NOT an ancestor of the local HEAD —
 * covering both "local strictly behind" and "diverged" in one boolean.
 *
 * Used by the clone-path stale-HEAD guard in `qfg push` (qfg-fboj):
 * either of those two states would otherwise produce a `HEAD..origin/main`
 * diff that ships REVERSAL deltas to the server, silently undoing
 * remote-newer commits. Both must refuse.
 *
 * Returns false on any git failure (no `origin/main` ref yet, no `.git/`,
 * etc.) so the caller falls through to its other guards rather than
 * aborting on an opaque error.
 */
export const isLocalBehindOrDivergedFromRemote = async (dir: string): Promise<boolean> => {
  try {
    const {stdout: localSha} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: remoteSha} = await runGit(['-C', dir, 'rev-parse', 'origin/main'])
    const local = localSha.trim()
    const remote = remoteSha.trim()
    if (local === remote) return false
    try {
      // exit 0 → remote is an ancestor of local → local is strictly ahead, fine.
      await runGit(['-C', dir, 'merge-base', '--is-ancestor', remote, local])
      return false
    } catch {
      // non-zero exit → remote is NOT an ancestor → behind or diverged.
      return true
    }
  } catch {
    return false
  }
}

/**
 * Returns true if local has commits not reachable from origin/main (diverged).
 */
export const hasDivergedFromRemote = async (dir: string): Promise<boolean> => {
  try {
    const {stdout: localSha} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: remoteSha} = await runGit(['-C', dir, 'rev-parse', 'origin/main'])

    const local = localSha.trim()
    const remote = remoteSha.trim()

    if (local === remote) return false

    // If remote is an ancestor of local, local is ahead (diverged for our purposes)
    try {
      await runGit(['-C', dir, 'merge-base', '--is-ancestor', remote, local])
      return true
    } catch {
      // Check if truly diverged (neither is ancestor of the other)
      try {
        await runGit(['-C', dir, 'merge-base', '--is-ancestor', local, remote])
        return false // ff possible, not diverged
      } catch {
        return true // truly diverged
      }
    }
  } catch {
    return false
  }
}

/**
 * Performs a fast-forward-only merge of origin/main. Returns list of new commit subjects.
 */
export const gitMergeFfOnly = async (dir: string): Promise<string[]> => {
  // Get commits that will be merged (before merge)
  let newCommits: string[] = []
  try {
    const {stdout: localSha} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: log} = await runGit(['-C', dir, 'log', '--pretty=format:%s', `${localSha.trim()}..origin/main`])
    newCommits = log
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    // Non-fatal — we'll still attempt the merge
  }

  await runGit(['-C', dir, 'merge', '--ff-only', 'origin/main'])
  return newCommits
}

/**
 * Adds or updates the origin remote for a repo.
 */
export const gitSetRemote = async (dir: string, url: string): Promise<void> => {
  const existing = await getRemoteUrl(dir)
  if (existing === null) {
    await runGit(['-C', dir, 'remote', 'add', 'origin', url])
  } else {
    await runGit(['-C', dir, 'remote', 'set-url', 'origin', url])
  }
}

export const gitPushForceLease = async (dir: string): Promise<void> => {
  await runGit(['-C', dir, 'push', 'origin', 'main', '--force-with-lease'])
}

export const gitPushForce = async (dir: string): Promise<void> => {
  await runGit(['-C', dir, 'push', 'origin', 'main', '--force'])
}

export const hasAtLeastOneCommit = async (dir: string): Promise<boolean> => {
  try {
    await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * Get the URL stripped of credentials for display purposes.
 */
export const displayUrl = (url: string): string => redactToken(url)

/**
 * Outcome of `gitPullRebase`. Three branches the caller MUST distinguish
 * — silent failure here is what made qfg-4tey a P1 (qfg pull exit 0 with
 * no recovery path).
 */
export type GitPullRebaseResult =
  | {kind: 'clean'; commitsRebased: number}
  | {kind: 'conflicts'; conflictedFiles: string[]}
  | {kind: 'failed'; reason: string}

/**
 * `git pull --rebase origin main`. Replays local commits on top of the
 * remote tip. On conflicts, leaves the repo in rebase-in-progress state
 * with `<<<<<<<` / `=======` / `>>>>>>>` markers planted by git so the
 * user can resolve via standard git tools (`git rebase --continue` /
 * `git rebase --abort`).
 *
 * Caller is responsible for surfacing recovery instructions; this function
 * only reports the outcome.
 */
export const gitPullRebase = async (dir: string): Promise<GitPullRebaseResult> => {
  // Count local-only commits BEFORE the rebase so the success path can
  // tell the user how many got moved. After a clean rebase, origin/main
  // is the merge-base and ahead-count == commits-rebased.
  let commitsRebased = 0
  try {
    const {stdout} = await runGit(['-C', dir, 'rev-list', '--count', 'origin/main..HEAD'])
    commitsRebased = Number.parseInt(stdout.trim(), 10) || 0
  } catch {
    // Non-fatal — counting is for UX, not correctness.
  }

  try {
    await runGit(['-C', dir, 'pull', '--rebase', 'origin', 'main'])
    return {kind: 'clean', commitsRebased}
  } catch (err: unknown) {
    // Distinguish "rebase paused on conflicts" from "rebase never started".
    // Conflicts: `diff --diff-filter=U` lists the unmerged paths and
    // `.git/rebase-merge/` is present.
    try {
      const {stdout} = await runGit(['-C', dir, 'diff', '--name-only', '--diff-filter=U'])
      const conflictedFiles = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
      if (conflictedFiles.length > 0) {
        return {kind: 'conflicts', conflictedFiles}
      }
    } catch {
      // Fall through to 'failed' — diff itself errored.
    }

    const reason = err instanceof Error ? err.message : String(err)
    return {kind: 'failed', reason}
  }
}

/**
 * Returns the local SHA of `origin/main` (i.e. the remote tip we last
 * fetched), or undefined if the repo has no `origin/main` ref.
 *
 * Used as the `expectedSha` passed to the server-side `configs.push`
 * optimistic lock (qfg-gj3i): the server compares the value we send
 * against the current Gitea workspace HEAD and rejects the push if
 * origin advanced between fetch and push. Belt-and-suspenders next to
 * the CLI-side stale-HEAD guard from qfg-fboj — closes the gap for
 * non-CLI clients and CLI regressions.
 *
 * Returns undefined on bare-path pushes (no `.git/`) and on any git
 * error so the caller can fall back to other locks rather than aborting
 * on an opaque rev-parse failure.
 */
export const getOriginMainSha = async (dir: string): Promise<string | undefined> => {
  try {
    const {stdout} = await runGit(['-C', dir, 'rev-parse', 'origin/main'])
    const sha = stdout.trim()
    return sha.length > 0 ? sha : undefined
  } catch {
    return undefined
  }
}
