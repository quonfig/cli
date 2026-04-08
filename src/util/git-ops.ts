import {execFile as execFileCb} from 'node:child_process'
import * as util from 'node:util'

const execFile = util.promisify(execFileCb)

/**
 * Redact a token from a URL string so it is safe to display to users.
 */
export const redactToken = (url: string): string => url.replace(/:([^@/]+)@/, ':***@')

/**
 * Wrap execFile errors to strip tokens from the message.
 */
const safeExec = async (file: string, args: string[], options?: {cwd?: string}): Promise<{stdout: string; stderr: string}> => {
  try {
    return await execFile(file, args, {cwd: options?.cwd})
  } catch (err: unknown) {
    const e = err as Error & {stdout?: string; stderr?: string; cmd?: string}
    const message = redactToken(e.message || String(err))
    const stderr = redactToken(e.stderr ?? '')
    const safeErr = new Error(message) as Error & {stderr?: string}
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
  if (existing !== null) {
    await safeExec('git', ['-C', dir, 'remote', 'set-url', 'origin', url])
  } else {
    await safeExec('git', ['-C', dir, 'remote', 'add', 'origin', url])
  }
}

export const gitPushForceLease = async (dir: string): Promise<void> => {
  await safeExec('git', ['-C', dir, 'push', 'origin', 'main', '--force-with-lease'])
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
