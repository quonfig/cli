import * as fs from 'node:fs'

import {Flags} from '@oclif/core'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {GiteaTokenResponse, mintGiteaToken} from '../util/gitea-api.js'
import {
  dirtyTrackedFiles,
  getAllRemoteUrls,
  getOriginMainSha,
  getRemoteUrl,
  gitFetch,
  gitSetRemote,
  isGitRepo,
  isLocalBehindOrDivergedFromRemote,
  runGit,
} from '../util/git-ops.js'
import {
  PushFatalError,
  runPush,
  type ConfigPushInput,
  type GitPushInput,
  type GiteaTokenMintResult,
  type GitOps,
} from '../push/run-push.js'
import {FileDelta} from '../push/diff-summary.js'
import {computeBarePathDiff} from '../push/bare-path-diff.js'
import {computeClonePathDiff} from '../push/clone-path-diff.js'
import {callConfigsGitPush, callConfigsPush} from '../push/config-push-client.js'
import {resolveWorkspaceDir} from '../util/resolve-workspace-dir.js'
import {resolveWorkspaceUuid} from '../util/resolve-workspace.js'

export default class Push extends BaseCommand {
  static description = `Push local config changes up to your workspace on Quonfig cloud.

Enforces three guards before touching the remote:
  1. The dir's quonfig.json "workspace" pin must match the backend (if set).
  2. The dir's git origin must match the backend repo URL (if set).
  3. A diff summary is shown; destructive changes (10+ deletes, >=25% of
     files, or an unpinned dir) require typing the workspace slug to confirm.

  qfg push                                 # resolves dir from cwd, QUONFIG_DIR, or --dir
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
      description:
        'Local directory to push (defaults to cwd / nearest ancestor with quonfig.json / QUONFIG_DIR env var)',
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

    const resolved = resolveWorkspaceDir({
      flagDir: flags.dir,
      envDir: process.env.QUONFIG_DIR,
      cwd: process.cwd(),
    })
    if (resolved.kind === 'error') {
      return this.err(resolved.message)
    }

    const resolvedDir = resolved.dir

    // Resolve requested target. --workspace > QUONFIG_WORKSPACE > active OAuth
    // profile. Supports API-key mode for headless runs so `qfg push` behaves
    // the same way `qfg create` does (both resolve via resolve-workspace.ts).
    const {workspaceId: requestedTarget, orgSlug} = await resolveWorkspaceUuid(this, flags.workspace)

    const {deps, cleanup} = buildRealDeps(this, orgSlug)
    try {
      const result = await runPush(
        {
          dir: resolvedDir,
          requestedTarget,
          orgSlug,
          yes: flags.yes,
          // Global `--interactive` / `--no-interactive` flag (BaseCommand
          // baseFlags). Threaded through so runPush can refuse to prompt
          // and instead abort with a clear --yes-required message.
          interactive: flags.interactive,
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
 *
 * As of qfg-azk.13 the push code path no longer mints a write-scoped Gitea
 * token; the actual commit is performed server-side by the `configs.push`
 * oRPC procedure. We still mint a READ token to authenticate the bare-path
 * probe-clone and the clone-path `git fetch`.
 */
export function buildRealDeps(
  cmd: Push,
  orgSlug: string,
): {deps: Parameters<typeof runPush>[1]; cleanup: () => Promise<void>} {
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
    async getAllRemoteUrls(dir) {
      return getAllRemoteUrls(dir)
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
          return await computeClonePathDiff(dir)
        } catch {
          // Fall through to the probe-clone path. This can happen if the dir
          // is a git repo but origin doesn't have a main branch fetched, etc.
        }
      }

      const probe = await ensureBarePathProbe(dir)
      return probe.deltas
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
    async isLocalBehindRemote(dir) {
      // qfg-fboj: stale-HEAD guard for the clone path. Implementation
      // lives in git-ops.ts so it can be unit-tested against a real
      // local git repo. We still gate on isGitRepo here because the
      // helper does not (it returns false on any error, but we want to
      // skip the rev-parse cost on the bare path entirely).
      if (!(await isGitRepo(dir))) return false
      return isLocalBehindOrDivergedFromRemote(dir)
    },
    async dirtyTrackedFiles(dir) {
      // qfg-fboj: surface uncommitted edits so the user sees they were
      // not included in this push. Only meaningful on the clone path —
      // bare path doesn't have a .git/ to status.
      if (!(await isGitRepo(dir))) return []
      try {
        return await dirtyTrackedFiles(dir)
      } catch {
        return []
      }
    },
    async getOriginMainSha(dir) {
      // qfg-gj3i: clone-path returns the local origin/main SHA after
      // fetch. Bare path has no `.git/` to rev-parse — return undefined
      // and let the server apply its bare-path lock policy.
      if (!(await isGitRepo(dir))) return
      return getOriginMainSha(dir)
    },
    // Pack-push (qfg-7429.4) — clone-path now ships actual git objects
    // via `configs.gitPush`. All five hooks below are no-ops on bare
    // path (the dispatch chooses configs.push instead) and only fire
    // when the local dir is a clone whose origin matches the backend.
    async getCurrentBranch(dir) {
      const {getCurrentBranch} = await import('../push/git-pack.js')
      return getCurrentBranch(dir)
    },
    async getHeadSha(dir) {
      const {stdout} = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
      return stdout.trim()
    },
    async getRemoteBranchSha(dir, branchName): Promise<string | undefined> {
      try {
        const {stdout} = await runGit(['-C', dir, 'rev-parse', `origin/${branchName}`])
        const sha = stdout.trim()
        return sha.length > 0 ? sha : undefined
      } catch {
        // No remote-tracking ref yet — brand-new branch. The pack-push
        // dispatch interprets `undefined` as zero-OID on the wire.
        return undefined
      }
    },
    async buildPack(dir, expectedSha, newSha) {
      const {buildPack} = await import('../push/git-pack.js')
      return buildPack(dir, expectedSha, newSha)
    },
    async countCommitsBetween(dir, expectedSha, newSha) {
      if (expectedSha === newSha) return 0
      const ZERO = '0000000000000000000000000000000000000000'
      const range = expectedSha === ZERO ? newSha : `${expectedSha}..${newSha}`
      try {
        const {stdout} = await runGit(['-C', dir, 'rev-list', '--count', range])
        return Number.parseInt(stdout.trim(), 10) || 0
      } catch {
        return 0
      }
    },
    async getCommitOneline(dir, sha) {
      // qfg-7429.5: surface the offending commit's identity alongside
      // the server's §6 recovery hint. Returns '' if the commit isn't
      // present locally (best-effort — the recovery message is the
      // load-bearing piece).
      try {
        const {stdout} = await runGit(['-C', dir, 'log', '-1', '--pretty=oneline', sha])
        return stdout.trim()
      } catch {
        return ''
      }
    },
  }

  const deps = {
    async mintWriteToken(requestedTarget: string) {
      // Read scope: this token authenticates probe-clone and clone-path
      // fetch. The actual commit goes through the server via configs.push,
      // which is authorized off the user's WorkOS session — no write PAT
      // needed in the push code path (qfg-azk.13).
      const resp = await mintGiteaToken(requestedTarget, orgSlug, 'read', 'pull')
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
    pushToServer: (input: ConfigPushInput) => callConfigsPush(input, orgSlug),
    pushPackToServer: (input: GitPushInput) => callConfigsGitPush(input, orgSlug),
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

async function countTrackedFilesAtRef(dir: string, ref: string): Promise<number> {
  try {
    const {stdout} = await runGit(['-C', dir, 'ls-tree', '-r', '--name-only', ref])
    return stdout.split('\n').filter((l) => l.trim().length > 0).length
  } catch {
    return 0
  }
}
