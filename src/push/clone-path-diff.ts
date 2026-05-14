/**
 * Clone-path diff helper for `qfg push`.
 *
 * The clone path runs when the user's local dir is a clone of the cloud repo
 * (`.git/` present and origin matches the backend). We need a list of file
 * deltas to ship to `configs.push`.
 *
 * Two sources, both contribute to the returned list:
 *   1. Committed deltas — `git diff --name-status origin/main..HEAD`. Each line
 *      becomes an added / modified / deleted FileDelta with content drawn
 *      from `git show origin/main:<path>` (before) and the working tree (after).
 *   2. Untracked working-tree files — `git ls-files --others --exclude-standard`.
 *      Each becomes an 'added' FileDelta with content from the working tree.
 *
 * (2) was added for qfg-3fc6: a beta tester dropped a new
 * `configs/quonfig.secrets.encryption.key.json` into a pulled workspace dir
 * and ran `qfg push`; the file was silently dropped because the diff only
 * reflected committed changes. We now pick those files up so they actually
 * push instead of vanishing without a warning.
 *
 * Tracked-but-modified files (working-tree edits to files that ARE in HEAD)
 * are intentionally NOT included — the existing dirty-tree warning in
 * `run-push.ts` surfaces those to the user, and silently auto-shipping
 * mid-edit working-tree state would be a different design choice. New
 * untracked files were unambiguously the user's intent.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import {FileDelta} from './diff-summary.js'
import {runGit} from '../util/git-ops.js'

export async function computeClonePathDiff(dir: string): Promise<FileDelta[]> {
  const deltas: FileDelta[] = []

  const {stdout} = await runGit(['-C', dir, 'diff', '--name-status', 'origin/main..HEAD'])
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const [status, ...rest] = line.split(/\s+/)
    const pathStr = rest.join(' ')
    if (!pathStr) continue
    if (status.startsWith('A')) {
      // eslint-disable-next-line no-await-in-loop
      const afterJson = await readWorkingTreeFile(dir, pathStr)
      deltas.push({kind: 'added', path: pathStr, ...(afterJson === undefined ? {} : {afterJson})})
    } else if (status.startsWith('D')) {
      // eslint-disable-next-line no-await-in-loop
      const beforeJson = await showAtRef(dir, 'origin/main', pathStr)
      deltas.push({kind: 'deleted', path: pathStr, ...(beforeJson === undefined ? {} : {beforeJson})})
    } else if (status.startsWith('M') || status.startsWith('R') || status.startsWith('C')) {
      // eslint-disable-next-line no-await-in-loop
      const beforeJson = await showAtRef(dir, 'origin/main', pathStr)
      // eslint-disable-next-line no-await-in-loop
      const afterJson = await readWorkingTreeFile(dir, pathStr)
      deltas.push({
        kind: 'modified',
        path: pathStr,
        ...(beforeJson === undefined ? {} : {beforeJson}),
        ...(afterJson === undefined ? {} : {afterJson}),
      })
    }
  }

  // qfg-3fc6: pick up untracked, non-ignored working-tree files. Without
  // this, dropping a fresh `configs/foo.json` into a pulled dir and running
  // `qfg push` silently drops the file — the diff above sees nothing
  // because it only reads committed history.
  const untracked = await listUntrackedFiles(dir)
  const seen = new Set(deltas.map((d) => d.path))
  for (const rel of untracked) {
    if (seen.has(rel)) continue
    // eslint-disable-next-line no-await-in-loop
    const afterJson = await readWorkingTreeFile(dir, rel)
    deltas.push({kind: 'added', path: rel, ...(afterJson === undefined ? {} : {afterJson})})
  }

  return deltas
}

async function listUntrackedFiles(dir: string): Promise<string[]> {
  try {
    const {stdout} = await runGit(['-C', dir, 'ls-files', '--others', '--exclude-standard'])
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

async function showAtRef(dir: string, ref: string, relPath: string): Promise<string | undefined> {
  try {
    const {stdout} = await runGit(['-C', dir, 'show', `${ref}:${relPath}`])
    return stdout
  } catch {
    return undefined
  }
}

async function readWorkingTreeFile(dir: string, relPath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(path.join(dir, relPath), 'utf8')
  } catch {
    return undefined
  }
}
