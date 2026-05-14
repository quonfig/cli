/**
 * Pack-push primitives for the CLI clone-path flow (qfg-7429.4, §4.1
 * of project/plans/qfg-git-commit-push-pull-improvements.md).
 *
 * The CLI ships actual git commit objects to app-quonfig instead of a
 * file-delta list. This module owns the two preflight checks and the
 * `git pack-objects` wrapper:
 *
 *   - `getCurrentBranch(dir)` — refuse detached HEAD and `master`
 *     before any pack work happens. Returns the branch name to use as
 *     the basename of `targetRef` on success.
 *   - `buildPack(dir, expectedSha, newSha)` — produce the packfile of
 *     `<expectedSha>..<newSha>` and return it as raw bytes. Capped at
 *     25 MiB per §7 open Q #7; throws `PackTooLargeError` on overflow.
 *
 * Pure(ish): every git invocation goes through `runGit`/`spawn`. Tests
 * stand up real tmp-dir git repos rather than mocking the shell — the
 * pack format is too fiddly to fake convincingly.
 */

import {spawn} from 'node:child_process'

import {GIT_SAFE_ARGS, GIT_SAFE_ENV, runGit} from '../util/git-ops.js'

/** Per §7 open Q #7 of the design plan: pack size cap of 25 MiB. */
export const MAX_PACK_BYTES = 25 * 1024 * 1024

/**
 * Result of `getCurrentBranch`. `branch` carries the name to forward
 * into the server `targetRef`. `detached` and `master` carry the exact
 * user-facing refusal message — callers throw it as-is.
 */
export type CurrentBranchResult =
  | {kind: 'branch'; name: string}
  | {kind: 'detached'; message: string}
  | {kind: 'master'; message: string}

/**
 * Resolve HEAD via `git symbolic-ref HEAD`. Empty/failed resolution
 * means detached HEAD (per §4.1 step 1). `master` is treated as a
 * structural workspace error rather than a transient one — the
 * workspace template uses `main`, and a `master` checkout is almost
 * always a leftover from cloning a non-Quonfig template.
 */
export async function getCurrentBranch(dir: string): Promise<CurrentBranchResult> {
  let stdout: string
  try {
    const res = await runGit(['-C', dir, 'symbolic-ref', '--quiet', '--short', 'HEAD'])
    stdout = res.stdout.trim()
  } catch {
    return {kind: 'detached', message: 'qfg push requires a checked-out branch.'}
  }

  if (stdout.length === 0) {
    return {kind: 'detached', message: 'qfg push requires a checked-out branch.'}
  }

  if (stdout === 'master') {
    return {
      kind: 'master',
      message: 'Quonfig workspaces use `main`; rename with `git branch -m master main`.',
    }
  }

  return {kind: 'branch', name: stdout}
}

export class PackTooLargeError extends Error {
  bytes: number
  limit: number
  constructor(bytes: number, limit: number) {
    super(
      `Pack exceeds ${limit} bytes (got ${bytes} bytes). Reduce the size of new commits or split them across multiple pushes.`,
    )
    this.name = 'PackTooLargeError'
    this.bytes = bytes
    this.limit = limit
  }
}

export interface BuildPackOptions {
  /** Override the size cap. Defaults to MAX_PACK_BYTES. */
  maxBytes?: number
}

/**
 * Produce a packfile covering `<expectedSha>..<newSha>` — i.e. the new
 * commit objects, their trees, and their blobs that are not already
 * reachable from `expectedSha`. Internally:
 *
 *     printf '<newSha>\n^<expectedSha>\n' | git pack-objects --revs --stdout
 *
 * which is the canonical "pack everything reachable from newSha but not
 * from expectedSha" recipe. Buffers the entire output to memory so we
 * can enforce the §7 cap before shipping anything to the server.
 *
 * Returns an empty `Uint8Array` when `expectedSha === newSha` — there
 * are no new commits, so `pack-objects` would either error on stdin
 * with no candidate revs or produce an empty pack. Skipping the spawn
 * keeps the no-op caller path simple.
 */
export async function buildPack(
  dir: string,
  expectedSha: string,
  newSha: string,
  options: BuildPackOptions = {},
): Promise<Uint8Array> {
  if (expectedSha === newSha) {
    return new Uint8Array(0)
  }

  const limit = options.maxBytes ?? MAX_PACK_BYTES

  return new Promise<Uint8Array>((resolve, reject) => {
    const env = {...process.env, ...GIT_SAFE_ENV}
    const args = [...GIT_SAFE_ARGS, '-C', dir, 'pack-objects', '--revs', '--stdout']
    const child = spawn('git', args, {env, stdio: ['pipe', 'pipe', 'pipe']})

    const chunks: Buffer[] = []
    let totalBytes = 0
    let stderr = ''
    let killedForOverflow = false

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength
      if (totalBytes > limit) {
        if (!killedForOverflow) {
          killedForOverflow = true
          child.kill('SIGKILL')
        }
        return
      }
      chunks.push(chunk)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => reject(err))

    child.on('close', (code, signal) => {
      if (killedForOverflow) {
        reject(new PackTooLargeError(totalBytes, limit))
        return
      }
      if (code !== 0) {
        reject(new Error(`git pack-objects exited ${code ?? signal}: ${stderr}`))
        return
      }
      const out = Buffer.concat(chunks, totalBytes)
      // Defensive: if git produced more than the limit but stayed under
      // a chunk boundary that triggered our SIGKILL, double-check here.
      if (out.byteLength > limit) {
        reject(new PackTooLargeError(out.byteLength, limit))
        return
      }
      resolve(new Uint8Array(out.buffer, out.byteOffset, out.byteLength))
    })

    // Feed the rev-list spec on stdin: include newSha, exclude expectedSha.
    // `--revs` tells pack-objects to read this as `git rev-list` would.
    child.stdin.end(`${newSha}\n^${expectedSha}\n`)
  })
}
