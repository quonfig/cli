import {execFile as execFileCb} from 'node:child_process'
import * as util from 'node:util'

const execFile = util.promisify(execFileCb)

/**
 * Redact a token from a URL string so it is safe to display to users.
 */
export const redactToken = (url: string): string => url.replace(/:([^/@]+)@/, ':***@')

/**
 * Wrap execFile errors to strip tokens from the message.
 */
const safeExec = async (
  file: string,
  args: string[],
  options?: {cwd?: string},
): Promise<{stdout: string; stderr: string}> => {
  try {
    return await execFile(file, args, {cwd: options?.cwd})
  } catch (error: unknown) {
    const e = error as {stdout?: string; stderr?: string; cmd?: string} & Error
    const message = redactToken(e.message || String(error))
    const stderr = redactToken(e.stderr ?? '')
    const safeErr = new Error(message) as {stderr?: string} & Error
    safeErr.stderr = stderr
    throw safeErr
  }
}

export const gitClone = async (repoUrl: string, dir: string): Promise<void> => {
  await safeExec('git', ['clone', repoUrl, dir])
}

export const isGitRepo = async (dir: string): Promise<boolean> => {
  try {
    await execFile('git', ['-C', dir, 'rev-parse', '--git-dir'])
    return true
  } catch {
    return false
  }
}

export const getRemoteUrl = async (dir: string): Promise<string | null> => {
  try {
    const {stdout} = await execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

export const isWorkingTreeClean = async (dir: string): Promise<boolean> => {
  const {stdout} = await execFile('git', ['-C', dir, 'status', '--porcelain'])
  return stdout.trim() === ''
}

/**
 * Returns true if `file` (relative to `dir`) has any working-tree or
 * staged change, false if its tracked content matches HEAD.
 */
export const hasFileChanges = async (dir: string, file: string): Promise<boolean> => {
  const {stdout} = await execFile('git', ['-C', dir, 'status', '--porcelain', '--', file])
  return stdout.trim() !== ''
}

/**
 * Returns the list of tracked files (relative paths) with working-tree
 * or staged modifications. Untracked files (`??`) are excluded — they
 * are not considered "dirty" by callers that want to know whether the
 * user has work-in-progress that should not be swept into a commit.
 */
export const dirtyTrackedFiles = async (dir: string): Promise<string[]> => {
  const {stdout} = await execFile('git', ['-C', dir, 'status', '--porcelain'])
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
  await safeExec('git', ['-C', dir, 'add', '--', file])
  await safeExec('git', ['-C', dir, 'commit', '-m', message, '--', file])
  return true
}

/**
 * Read the contents of `file` (relative to `dir`) at HEAD. Returns
 * `undefined` if the file does not exist at HEAD or if HEAD itself is
 * unset (empty repo).
 */
export const readFileAtHead = async (dir: string, file: string): Promise<string | undefined> => {
  try {
    const {stdout} = await execFile('git', ['-C', dir, 'show', `HEAD:${file}`])
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
export type PinFixResult =
  | {kind: 'committed'; slug: string}
  | {kind: 'clean'}
  | {kind: 'skipped'; reason: string}

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
export const commitPinFixIfPinOnly = async (
  dir: string,
  file: string,
  expectedSlug: string,
): Promise<PinFixResult> => {
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

  await safeExec('git', ['-C', dir, 'add', '--', file])
  await safeExec('git', ['-C', dir, 'commit', '-m', `qfg: pin workspace = ${expectedSlug}`, '--', file])
  return {kind: 'committed', slug: expectedSlug}
}

export const gitFetch = async (dir: string): Promise<void> => {
  await safeExec('git', ['-C', dir, 'fetch', 'origin'])
}

/**
 * Returns true if origin/main has commits that can be fast-forwarded into the local branch.
 */
export const canFastForward = async (dir: string): Promise<boolean> => {
  try {
    // Get the local HEAD and origin/main SHAs
    const {stdout: localSha} = await execFile('git', ['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: remoteSha} = await execFile('git', ['-C', dir, 'rev-parse', 'origin/main'])

    const local = localSha.trim()
    const remote = remoteSha.trim()

    if (local === remote) return false // already up to date

    // Check if local is an ancestor of remote (i.e. ff is possible)
    try {
      await execFile('git', ['-C', dir, 'merge-base', '--is-ancestor', local, remote])
      return true // exit code 0 means local is an ancestor of remote
    } catch {
      return false // local has diverged
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
    const {stdout: localSha} = await execFile('git', ['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: remoteSha} = await execFile('git', ['-C', dir, 'rev-parse', 'origin/main'])

    const local = localSha.trim()
    const remote = remoteSha.trim()

    if (local === remote) return false

    // If remote is an ancestor of local, local is ahead (diverged for our purposes)
    try {
      await execFile('git', ['-C', dir, 'merge-base', '--is-ancestor', remote, local])
      return true
    } catch {
      // Check if truly diverged (neither is ancestor of the other)
      try {
        await execFile('git', ['-C', dir, 'merge-base', '--is-ancestor', local, remote])
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
    const {stdout: localSha} = await execFile('git', ['-C', dir, 'rev-parse', 'HEAD'])
    const {stdout: log} = await execFile('git', [
      '-C',
      dir,
      'log',
      '--pretty=format:%s',
      `${localSha.trim()}..origin/main`,
    ])
    newCommits = log
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    // Non-fatal — we'll still attempt the merge
  }

  await safeExec('git', ['-C', dir, 'merge', '--ff-only', 'origin/main'])
  return newCommits
}

/**
 * Adds or updates the origin remote for a repo.
 */
export const gitSetRemote = async (dir: string, url: string): Promise<void> => {
  const existing = await getRemoteUrl(dir)
  if (existing === null) {
    await safeExec('git', ['-C', dir, 'remote', 'add', 'origin', url])
  } else {
    await safeExec('git', ['-C', dir, 'remote', 'set-url', 'origin', url])
  }
}

export const gitPushForceLease = async (dir: string): Promise<void> => {
  await safeExec('git', ['-C', dir, 'push', 'origin', 'main', '--force-with-lease'])
}

export const gitPushForce = async (dir: string): Promise<void> => {
  await safeExec('git', ['-C', dir, 'push', 'origin', 'main', '--force'])
}

export const hasAtLeastOneCommit = async (dir: string): Promise<boolean> => {
  try {
    await execFile('git', ['-C', dir, 'rev-parse', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * Get the URL stripped of credentials for display purposes.
 */
export const displayUrl = (url: string): string => redactToken(url)
