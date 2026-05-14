/**
 * Resolve the workspace directory for `qfg push` / `qfg pull`.
 *
 * Resolution order:
 *   1. `--dir <path>` flag (explicit, wins everything)
 *   2. `QUONFIG_DIR` env var
 *   3. Walk up from cwd looking for `quonfig.json`. Stop at the first hit,
 *      the user's home dir, or the filesystem root.
 *   4. Error: `No Quonfig workspace dir found. ...`
 *
 * Pure — the caller wires `process.cwd()` and `process.env.QUONFIG_DIR` in.
 * Tests drive the function with explicit values so the cwd walk can be
 * exercised inside a tmp dir without `process.chdir`.
 *
 * Empty-string flag / env values are treated as "absent" because shells
 * routinely emit `EXPORT_FOO=` when a var is declared but has no value;
 * silently picking the empty string would resolve to cwd and produce a
 * confusing wrong-target failure downstream.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const QUONFIG_JSON = 'quonfig.json'

export const NO_WORKSPACE_DIR_ERROR =
  'No Quonfig workspace dir found. Run from inside a workspace, or pass --dir, or set QUONFIG_DIR.'

export interface ResolveWorkspaceDirInput {
  /** Current working directory — the search root for the walk. */
  cwd: string
  /** Value of `QUONFIG_DIR` env var (or undefined). */
  envDir: string | undefined
  /** Value of `--dir` flag (or undefined). */
  flagDir: string | undefined
  /**
   * The user's home directory. The cwd walk stops here (without checking
   * it) so we never pick up a stray `quonfig.json` parked in `~`. Defaults
   * to `os.homedir()` when omitted; tests pass an explicit value so they
   * can pretend a tmp dir is "home".
   */
  homeDir?: string
}

export type ResolveWorkspaceDirResult =
  | {kind: 'ok'; dir: string; source: 'flag' | 'env' | 'cwd-walk'}
  | {kind: 'error'; message: string}

const blank = (s: string | undefined): boolean => s === undefined || s === ''

export const resolveWorkspaceDir = (input: ResolveWorkspaceDirInput): ResolveWorkspaceDirResult => {
  if (!blank(input.flagDir)) {
    return {kind: 'ok', dir: path.resolve(input.cwd, input.flagDir as string), source: 'flag'}
  }

  if (!blank(input.envDir)) {
    return {kind: 'ok', dir: path.resolve(input.cwd, input.envDir as string), source: 'env'}
  }

  const homeDir = input.homeDir ?? os.homedir()
  const found = walkUpForWorkspace(input.cwd, homeDir)
  if (found !== undefined) {
    return {kind: 'ok', dir: found, source: 'cwd-walk'}
  }

  return {kind: 'error', message: NO_WORKSPACE_DIR_ERROR}
}

/**
 * Walk from `start` toward the filesystem root, returning the first ancestor
 * dir that contains a `quonfig.json`. Stops without checking when the walk
 * reaches `homeDir` or the filesystem root — `~` is not a workspace.
 */
const walkUpForWorkspace = (start: string, homeDir: string): string | undefined => {
  let current = path.resolve(start)
  // Normalize homeDir the same way so the equality check survives a
  // trailing slash or symlink-resolved path on the caller's side.
  const stop = path.resolve(homeDir)

  while (true) {
    if (current === stop) return undefined

    if (fs.existsSync(path.join(current, QUONFIG_JSON))) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}
