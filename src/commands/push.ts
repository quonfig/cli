import {execFile as execFileCb} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as util from 'node:util'

import {Flags} from '@oclif/core'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {GiteaTokenResponse, mintGiteaToken} from '../util/gitea-api.js'
import type {GiteaTokenMintResult} from '../push/run-push.js'
import {
  getRemoteUrl,
  gitFetch,
  gitSetRemote,
  isGitRepo,
} from '../util/git-ops.js'
import {PushIdentity} from '../util/clone-and-stack-push.js'
import {PushFatalError, runPush, type GitOps} from '../push/run-push.js'
import {FileDelta} from '../push/diff-summary.js'
import {computeBarePathDiff} from '../push/bare-path-diff.js'
import {resolveWorkspaceUuid} from '../util/resolve-workspace.js'

const execFile = util.promisify(execFileCb)

export default class Push extends BaseCommand {
  static description = `Push local config changes up to your workspace on Quonfig cloud.

Enforces three guards before touching the remote:
  1. The dir's quonfig.json "workspace" pin must match the backend (if set).
  2. The dir's git origin must match the backend repo URL (if set).
  3. A diff summary is shown; destructive changes (10+ deletes, >=25% of
     files, or an unpinned dir) require typing the workspace slug to confirm.

  qfg push                                 # uses QUONFIG_DIR + profile workspace
  qfg push --dir ./our-config
  qfg push --dir ./our-config --workspace acme-prod
  qfg push --dir ./our-config --yes        # skip normal Y/N (never skips typed-slug)
  qfg push --dir ./our-config --skip-validate`

  static examples = [
    '<%= config.bin %> push --dir ./our-config',
    '<%= config.bin %> push --workspace acme-prod --dir ./our-config',
    '<%= config.bin %> push --dir ./our-config --yes',
  ]

  static flags = {
    dir: Flags.string({
      description: 'Local directory to push (defaults to QUONFIG_DIR env var)',
    }),
    workspace: Flags.string({
      description: 'Workspace slug or UUID (defaults to active profile)',
    }),
    yes: Flags.boolean({
      default: false,
      description: 'Skip the standard Y/N confirm. Never skips typed-slug prompts.',
    }),
    'skip-validate': Flags.boolean({
      default: false,
      description: 'Skip `qfg validate` preflight',
    }),
    'no-pin-write': Flags.boolean({
      default: false,
      description: 'Do not offer to write workspace slug into quonfig.json on success',
    }),
    message: Flags.string({
      char: 'm',
      description: 'Commit message for bare-path pushes (ignored on clone-path; push what is already committed)',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Push)

    const dir = flags.dir || process.env.QUONFIG_DIR
    if (!dir) {
      return this.err('No directory specified. Use --dir <path> or set QUONFIG_DIR.')
    }

    const resolvedDir = path.resolve(dir)

    // Resolve requested target. --workspace > QUONFIG_WORKSPACE > active OAuth
    // profile. Supports API-key mode for headless runs so `qfg push` behaves
    // the same way `qfg create` does (both resolve via resolve-workspace.ts).
    const requestedTarget = await resolveWorkspaceUuid(this, flags.workspace)

    const {deps, cleanup} = buildRealDeps(this)
    try {
      const result = await runPush(
        {
          dir: resolvedDir,
          requestedTarget,
          yes: flags.yes,
          skipValidate: flags['skip-validate'],
          noPinWrite: flags['no-pin-write'],
          message: flags.message,
        },
        deps,
      )

      if (result.kind === 'aborted') {
        this.log(`Aborted: ${result.reason}`)
        return {aborted: true, reason: result.reason}
      }

      if (result.kind === 'no-op') {
        this.log(result.reason)
        return {noop: true, reason: result.reason}
      }

      this.log(`Pushed via ${result.dispatchedAs}.`)
      return {pushed: true, via: result.dispatchedAs, commitSha: result.commitSha ?? null}
    } catch (error: unknown) {
      if (error instanceof PushFatalError) {
        return this.err(error.message)
      }

      throw error
    } finally {
      await cleanup()
    }
  }
}

/**
 * Map a raw `gitea.token` API response into the `GiteaTokenMintResult` shape
 * the push core (`runPush`) consumes. Kept as a pure function so we can unit
 * test the wiring without a network — specifically, to regression-test that
 * `workspaceId` on the result is the UUID the server returned, not the slug.
 *
 * The bug this guards against: before the backend started returning
 * `workspaceId`, this module used `resp.workspaceSlug` as the `workspaceId`
 * field, which caused `checkIdentity` to fail when the user passed
 * `--workspace <UUID>` (requested=UUID, backend.workspaceId=slug → mismatch).
 */
export function giteaResponseToMintResult(resp: GiteaTokenResponse): GiteaTokenMintResult {
  return {
    token: resp.token,
    repoUrl: resp.repoUrl,
    expiresAt: resp.expiresAt,
    workspaceSlug: resp.workspaceSlug,
    // Canonical workspace UUID from the server. checkIdentity compares this
    // against `requestedTarget` — so if the user passed --workspace as a
    // UUID, the UUID path matches backend.workspaceId; if they passed a
    // slug, the slug path matches backend.workspaceSlug. Either way the
    // backend row is the same workspace.
    workspaceId: resp.workspaceId,
  }
}

/**
 * Wire the real implementations of every dependency runPush needs. Kept in
 * the command file so the pure core stays free of oclif / git shell imports.
 *
 * Returns a `{deps, cleanup}` pair. The caller MUST call `cleanup()` in a
 * finally block so the bare-path probe clone is removed even on errors.
 */
export function buildRealDeps(cmd: Push): {deps: Parameters<typeof runPush>[1]; cleanup: () => Promise<void>} {
  const log = (line: string) => cmd.log(line)
  const errLog = (line: string) => cmd.logToStderr(line)

  // State captured across calls so a bare-path diff can share its probe clone
  // between `diffHeadVsOrigin` and `countFilesInRemote`. Populated lazily on
  // the first call that needs it.
  //
  // `authenticatedRepoUrl` is set by the wrapped `mintWriteToken` below —
  // runPush always calls mint before it calls any gitOps method that needs
  // the probe clone, so by the time we read it here it is populated.
  let authenticatedRepoUrl: string | undefined
  let barePathProbe: {deltas: FileDelta[]; scratchDir: string; totalRemoteFiles: number} | undefined

  const ensureBarePathProbe = async (dir: string) => {
    if (barePathProbe) return barePathProbe
    if (!authenticatedRepoUrl) {
      throw new Error(
        'buildRealDeps: bare-path diff requested before mintWriteToken ran. This is a bug in runPush ordering.',
      )
    }

    barePathProbe = await computeBarePathDiff(dir, authenticatedRepoUrl)
    return barePathProbe
  }

  const gitOps: GitOps = {
    async isGitRepo(dir) {
      return isGitRepo(dir)
    },
    async getRemoteOriginUrl(dir) {
      const url = await getRemoteUrl(dir)
      return url ?? undefined
    },
    async setRemoteOrigin(dir, url) {
      await gitSetRemote(dir, url)
    },
    async fetch(dir) {
      // fetch is only meaningful for the clone path. For a bare-path dir it
      // is still called by runPush but the dir has no origin, so we swallow
      // the failure here rather than in runPush. The probe-clone strategy
      // handles the remote-state read.
      try {
        await gitFetch(dir)
      } catch {
        /* bare path: no origin to fetch from — intentional no-op */
      }
    },
    async diffHeadVsOrigin(dir) {
      // Clone path: .git/ exists AND origin matches backend. Prefer the native
      // git diff; it is fast and doesn't require a second clone.
      if (await isGitRepo(dir)) {
        try {
          return await diffHeadVsOrigin(dir)
        } catch {
          // Fall through to the probe-clone path. This can happen if the dir
          // is a git repo but origin doesn't have a main branch fetched, etc.
        }
      }

      const probe = await ensureBarePathProbe(dir)
      return probe.deltas
    },
    async push(dir) {
      await execFile('git', ['-C', dir, 'push', 'origin', 'main'])
    },
    async getLocalAuthor(dir) {
      return readLocalAuthor(dir)
    },
    async countFilesInRemote(dir) {
      if (await isGitRepo(dir)) {
        const fromGit = await countTrackedFilesAtRef(dir, 'origin/main')
        // If origin/main is present we get a positive count; if the dir is a
        // bare path with a stale .git we get 0 and fall through.
        if (fromGit > 0) return fromGit
      }

      const probe = await ensureBarePathProbe(dir)
      return probe.totalRemoteFiles
    },
  }

  const deps = {
    async mintWriteToken(requestedTarget: string) {
      const resp = await mintGiteaToken(requestedTarget, 'write', 'push')
      // Stash the authenticated URL so the bare-path gitOps methods can
      // probe-clone it without a second mint.
      authenticatedRepoUrl = resp.repoUrl
      return giteaResponseToMintResult(resp)
    },
    async validate(dir: string) {
      const {validateWorkspace} = await import('../verify/validate.js')
      const result = validateWorkspace(dir)
      const errors = result.issues.filter((i) => i.severity === 'error').map((i) => i.message)
      return {errors}
    },
    gitOps,
    copyDirMirror,
    log,
    errLog,
  }

  const cleanup = async () => {
    if (!barePathProbe) return
    try {
      fs.rmSync(barePathProbe.scratchDir, {force: true, recursive: true})
    } catch {
      /* ignore — cleanup is best-effort */
    }
  }

  return {deps, cleanup}
}

/**
 * Diff the working tree (what we are about to push) against origin/main. We
 * use `git diff --name-status HEAD..origin/main` with inverted semantics:
 *   Added here  = present locally (in HEAD), absent in origin/main.
 *   Deleted     = absent locally, present in origin/main.
 *   Modified    = content differs.
 *
 * `git diff A..B` reports B relative to A. So `HEAD..origin/main` tells us
 * what origin has that we don't. We want "local vs remote" with local as the
 * baseline — i.e. origin/main..HEAD.
 */
async function diffHeadVsOrigin(dir: string): Promise<FileDelta[]> {
  // origin/main..HEAD reports changes HEAD has relative to origin/main.
  // 'A' -> added locally, 'D' -> deleted locally, 'M' -> modified locally.
  const {stdout} = await execFile('git', [
    '-C',
    dir,
    'diff',
    '--name-status',
    'origin/main..HEAD',
  ])
  const deltas: FileDelta[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const [status, ...rest] = line.split(/\s+/)
    const pathStr = rest.join(' ')
    if (!pathStr) continue
    if (status.startsWith('A')) deltas.push({kind: 'added', path: pathStr})
    else if (status.startsWith('D')) deltas.push({kind: 'deleted', path: pathStr})
    else if (status.startsWith('M') || status.startsWith('R') || status.startsWith('C')) {
      // Treat renames / copies as modifications for diff-summary purposes.
      deltas.push({kind: 'modified', path: pathStr})
    }
  }

  return deltas
}

async function countTrackedFilesAtRef(dir: string, ref: string): Promise<number> {
  try {
    const {stdout} = await execFile('git', ['-C', dir, 'ls-tree', '-r', '--name-only', ref])
    return stdout.split('\n').filter((l) => l.trim().length > 0).length
  } catch {
    return 0
  }
}

async function readLocalAuthor(dir: string): Promise<PushIdentity | undefined> {
  try {
    const {stdout: name} = await execFile('git', ['-C', dir, 'config', 'user.name'])
    const {stdout: email} = await execFile('git', ['-C', dir, 'config', 'user.email'])
    const n = name.trim()
    const e = email.trim()
    if (!n || !e) return undefined
    return {name: n, email: e}
  } catch {
    return undefined
  }
}

/**
 * Copy the contents of `sourceDir` into `destDir`, skipping `.git/` and any
 * temp push-clone scratch directories. Used as the `applyDelta` callback for
 * bare-path pushes — we mirror local files into a fresh clone so that
 * `cloneAndStackPush`'s `git add --all` + diff will reflect the union of
 * (deletes, modifies, adds) we intend.
 *
 * IMPORTANT: this deletes files in destDir that are not in sourceDir so that
 * deletions make it into the push. Without this the clone-and-stack produces
 * an "adds-only" delta and destructive heuristics would never fire in the UI.
 */
export async function copyDirMirror(sourceDir: string, destDir: string): Promise<void> {
  // Collect source entries (except .git, .quonfig-push-clone-*)
  const sourceRel = collectRelPaths(sourceDir)
  const destRel = collectRelPaths(destDir)

  // Delete anything in dest that isn't in source
  for (const rel of destRel) {
    if (!sourceRel.has(rel)) {
      const full = path.join(destDir, rel)
      try {
        fs.rmSync(full, {force: true})
      } catch {
        /* ignore */
      }
    }
  }

  // Copy / overwrite everything from source into dest
  for (const rel of sourceRel) {
    const src = path.join(sourceDir, rel)
    const dst = path.join(destDir, rel)
    fs.mkdirSync(path.dirname(dst), {recursive: true})
    fs.copyFileSync(src, dst)
  }
}

function collectRelPaths(root: string): Set<string> {
  const out = new Set<string>()
  if (!fs.existsSync(root)) return out
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === '.git') continue
      if (entry.name.startsWith('.quonfig-push-clone-')) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, rel)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.add(rel)
      }
    }
  }

  walk(root, '')
  return out
}
