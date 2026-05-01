import * as fs from 'node:fs'
import * as path from 'node:path'

import {addAndCommitFile, isGitRepo} from './git-ops.js'

/**
 * Subdirectory under QUONFIG_DIR where each entity type lives. Mirrors the
 * `directory` field on app-quonfig's CRUD configs (see
 * `app-quonfig/src/lib/orpc/routes/{flags,configs,log-levels}.ts`). Keep these
 * in lock-step or `qfg pull` and `qfg create` will disagree on file paths.
 */
export type EntitySubdir = 'feature-flags' | 'configs' | 'log-levels'

export interface WriteResult {
  /** True when the file was committed to local git too. */
  committed: boolean
  /** Absolute path of the file written. */
  filePath: string
  /** Reason for skipping git commit, when applicable (verbose-log only). */
  skippedCommitReason?: string
}

/**
 * Strip server-only metadata fields from the API response so the on-disk file
 * matches what app-quonfig itself stores in git (see
 * `config-crud-handlers.ts:writeAndCommit` — it serializes the StoredConfig
 * shape, not the FlagDetail shape).
 */
const stripServerMetadata = (storedConfig: Record<string, unknown>): Record<string, unknown> => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {commitSha: _commitSha, ...rest} = storedConfig
  return rest
}

/**
 * Write the StoredConfig the server returned to
 * `${QUONFIG_DIR}/<subdir>/<key>.json` so users don't need to run `qfg pull`
 * after every `qfg create`. Closes qfg-d5t.
 *
 * Best-effort: returns null when QUONFIG_DIR is unset, the directory does not
 * exist, or the workspace dir lacks a `quonfig.json`. Throws only on real
 * filesystem write errors — callers should treat those as fatal because
 * silent corruption (e.g., unwriteable workspace dir) is worse than a noisy
 * failure.
 */
export const writeStoredConfigToWorkspace = async (opts: {
  subdir: EntitySubdir
  key: string
  storedConfig: Record<string, unknown>
  /** Override QUONFIG_DIR for testing. */
  quonfigDir?: string
}): Promise<WriteResult | null> => {
  const dir = opts.quonfigDir ?? process.env.QUONFIG_DIR
  if (!dir) return null

  const resolvedDir = path.resolve(dir)
  // Skip silently if the workspace dir isn't there yet — first-time users
  // who have run `qfg login` but not `qfg pull` shouldn't get a hard error.
  if (!fs.existsSync(resolvedDir)) return null

  // Refuse to write into a directory that doesn't look like a Quonfig
  // workspace. This avoids accidentally seeding `feature-flags/` files into
  // an unrelated directory the user happened to point QUONFIG_DIR at.
  if (!fs.existsSync(path.join(resolvedDir, 'quonfig.json'))) return null

  const subdirPath = path.join(resolvedDir, opts.subdir)
  await fs.promises.mkdir(subdirPath, {recursive: true})

  const filePath = path.join(subdirPath, `${opts.key}.json`)
  const cleaned = stripServerMetadata(opts.storedConfig)
  await fs.promises.writeFile(filePath, JSON.stringify(cleaned, null, 2) + '\n', 'utf8')

  // If the workspace is a git repo, commit the new file with the same
  // message format app-quonfig's createEntity uses. This keeps the next
  // `qfg pull` clean: when origin has the equivalent server-side commit,
  // a fast-forward reconciles cleanly because both histories share the
  // pre-create base. (If they diverge, pull will say so — better than an
  // "untracked file would be overwritten" trap.)
  if (await isGitRepo(resolvedDir)) {
    const relPath = path.relative(resolvedDir, filePath)
    const entityLabel = opts.subdir === 'feature-flags' ? 'flag' : opts.subdir === 'log-levels' ? 'log level' : 'config'
    try {
      const committed = await addAndCommitFile(resolvedDir, relPath, `Create ${entityLabel}: ${opts.key}`)
      return {filePath, committed}
    } catch (error) {
      return {filePath, committed: false, skippedCommitReason: String(error)}
    }
  }

  return {filePath, committed: false, skippedCommitReason: 'not a git repo'}
}
