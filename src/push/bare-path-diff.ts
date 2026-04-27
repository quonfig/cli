/**
 * Bare-path diff helper for `qfg push`.
 *
 * When the user's local dir is NOT a clone of the cloud repo (no `.git/`, or
 * a mismatched origin) we still need to show a Guard 3 diff summary BEFORE
 * asking them to confirm the push. The clone-path implementation uses
 * `git log origin/main..HEAD` — that doesn't work here because there is no
 * origin in the local dir.
 *
 * Strategy: probe-clone the cloud repo into an OS tmpdir, then walk both
 * trees file-by-file and classify each as added / modified / deleted.
 *
 * The caller owns cleanup of `scratchDir`. The real caller (buildRealDeps in
 * `commands/push.ts`) stashes the scratch clone path on a closure so it can
 * delete it in a finally-block after runPush resolves — matching the bare
 * path's existing scratch-clone lifecycle in `run-push.ts`.
 *
 * Intentional non-goals:
 *   - No token handling. Caller passes a fully-authenticated `remoteUrl`.
 *   - No filtering to "known" workspace dirs (configs/, feature-flags/, ...).
 *     We exclude dotfiles/dotdirs (`.git`, `.DS_Store`, `.quonfig-*`) so the
 *     scratch clone's own `.git/` does not leak into the diff, but otherwise
 *     diff whatever is on disk. This keeps the diff surface consistent with
 *     `copyDirMirror` in `commands/push.ts`, which mirrors every non-dotfile
 *     into the real push clone.
 */

import {execFile as execFileCb} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as util from 'node:util'

import {FileDelta} from './diff-summary.js'

const execFile = util.promisify(execFileCb)

export interface BarePathDiffResult {
  deltas: FileDelta[]
  /** Tmp dir holding the probe clone. Caller must rm -rf in a finally block. */
  scratchDir: string
  /** Total file count in the scratch clone (under the same prefix rules as `deltas`). */
  totalRemoteFiles: number
}

/**
 * Clone `remoteUrl` into an OS tmp dir, then diff the working tree of `localDir`
 * against the scratch clone's working tree. Returns `FileDelta[]` plus the
 * scratch clone's file count.
 */
export async function computeBarePathDiff(localDir: string, remoteUrl: string): Promise<BarePathDiffResult> {
  const scratchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qfg-push-probe-'))
  try {
    // --depth 1 would miss information needed for later identity checks, but
    // for the diff we only need the tip — shallow is fine and a lot faster on
    // workspaces with 2 years of history.
    await execFile('git', ['clone', '--branch', 'main', '--depth', '1', remoteUrl, scratchDir])
  } catch (error: unknown) {
    // Clean up before re-throwing so we never leak a scratch dir on failure.
    try {
      fs.rmSync(scratchDir, {force: true, recursive: true})
    } catch {
      /* ignore */
    }

    throw error
  }

  const localFiles = collectFiles(localDir)
  const remoteFiles = collectFiles(scratchDir)

  const deltas: FileDelta[] = []

  for (const [rel, local] of localFiles) {
    const remote = remoteFiles.get(rel)
    if (remote === undefined) {
      deltas.push({kind: 'added', path: rel, afterJson: local.content})
    } else if (remote.hash !== local.hash) {
      deltas.push({kind: 'modified', path: rel, beforeJson: remote.content, afterJson: local.content})
    }
  }

  for (const [rel, remote] of remoteFiles) {
    if (!localFiles.has(rel)) {
      deltas.push({kind: 'deleted', path: rel, beforeJson: remote.content})
    }
  }

  return {deltas, scratchDir, totalRemoteFiles: remoteFiles.size}
}

interface FileEntry {
  content: string
  hash: string
}

/**
 * Walk `root` and return a map of relative-path -> {content, hash} for every
 * non-dotfile file under it. The content string is needed by qfg-azk.13's
 * `configs.push` wire shape; the hash is used to short-circuit the
 * unchanged-file case without comparing full bodies.
 *
 * We skip any entry whose name starts with a `.`, which covers `.git/`,
 * `.DS_Store`, and the transient `.quonfig-push-clone-*` scratch dirs that
 * `run-push.ts` creates next to the local workspace. Keeping the rule simple
 * and symmetric on both sides prevents one-off false positives.
 */
function collectFiles(root: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>()
  if (!fs.existsSync(root)) return out

  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true})
    } catch {
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, rel)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          const content = fs.readFileSync(full, 'utf8')
          out.set(rel, {content, hash: hashString(content)})
        } catch {
          /* ignore unreadable files — they won't appear on either side */
        }
      }
    }
  }

  walk(root, '')
  return out
}

/**
 * Content hash. We don't need cryptographic strength — just a stable
 * fingerprint so we can say "file A on local matches file A on remote". The
 * contents are small JSON in practice, so sha1 is plenty fast.
 */
function hashString(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}
