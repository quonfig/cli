/**
 * Core logic for `qfg push`. Pure-ish, dependency-injected, so tests can drive
 * it without hitting the network, touching git, or running validation.
 *
 * The oclif command (`src/commands/push.ts`) is a thin wrapper that fills in
 * real implementations of every dependency and calls `runPush`.
 *
 * The three guards from `project/plans/cli-git-sync.md` are all enforced here:
 *   - Guards 1 + 2: `checkIdentity` cross-checks the requested target, repo
 *     pin, and git origin against the backend-resolved workspace.
 *   - Guard 3: `summarizeDiff` + `confirmYesNo`/`confirmTypedSlug` force the
 *     user to acknowledge destructive changes.
 *
 * Dispatch between the "clone path" (the local dir is a clone of the cloud
 * repo) and the "bare path" (anything else — no .git, or a mismatched origin)
 * is decided after identity passes.
 *
 * `--yes` skips the normal Y/N confirmation. It NEVER skips a typed-slug
 * confirmation — that prompt is the destructive-change brake.
 */

import * as fs from 'node:fs'

import {commitPinFixIfPinOnly} from '../util/git-ops.js'
import {readWorkspaceSlug, tryParseWorkspacePin, writeWorkspaceSlug} from '../util/quonfig-json.js'
import {checkIdentity} from './identity-check.js'
import {confirmTypedSlug, confirmYesNo} from './confirm.js'
import {FileDelta, summarizeDiff} from './diff-summary.js'
import type {CurrentBranchResult} from './git-pack.js'

/** All-zeros object id, the git-protocol convention for "no such ref". */
const ZERO_OID = '0000000000000000000000000000000000000000'

export interface GiteaTokenMintResult {
  expiresAt: string | null
  repoUrl: string
  token: string
  workspaceId: string
  workspaceSlug: string
}

export interface GitOps {
  /**
   * Pack-push — produce a packfile of `<expectedSha>..<newSha>` (or an
   * empty buffer when expectedSha === newSha). Capped at 25 MiB per §7
   * open Q #7; throws on overflow so callers see a concrete error
   * before any HTTP traffic.
   */
  buildPack(dir: string, expectedSha: string, newSha: string): Promise<Uint8Array>
  /**
   * Pack-push — count of commits in `<expectedSha>..<newSha>`. Drives
   * the final "Pushed N commit(s)" log line. Returns 0 for a no-op
   * push (already at the tip) and best-effort for new branches with
   * a zero-OID base.
   */
  countCommitsBetween(dir: string, expectedSha: string, newSha: string): Promise<number>
  /** Number of tracked files on origin/main (used for the destructive-ratio heuristic). */
  countFilesInRemote(dir: string): Promise<number>
  /**
   * Produce the list of file deltas to render in the Guard 3 summary and
   * send to the server. Each delta carries before/after JSON content per
   * the `configs.push` wire shape (qfg-azk.13). For the clone path this is
   * HEAD vs origin/main; for the bare path it's local vs probe-clone.
   */
  diffHeadVsOrigin(dir: string): Promise<FileDelta[]>
  /**
   * Tracked files (relative paths) with working-tree or staged changes.
   * Used by the clone-path dirty-tree warning to surface uncommitted
   * edits the user may believe are being pushed (qfg-fboj). Untracked
   * files are excluded — same rule as `dirtyTrackedFiles` in git-ops.ts.
   */
  dirtyTrackedFiles(dir: string): Promise<string[]>
  /** `git fetch origin` in the given dir. */
  fetch(dir: string): Promise<void>
  /**
   * Returns every configured remote URL on the repo (i.e. `git remote -v`
   * URLs, deduped per remote name). Used by the identity check to support
   * multi-remote workspaces where `origin` points at a customer's PR-review
   * remote (GitHub) and a secondary remote points at Quonfig (qfg-glrd.3).
   *
   * Returns an empty array when the dir isn't a git repo or has no remotes
   * configured.
   */
  getAllRemoteUrls(dir: string): Promise<string[]>
  /**
   * Run `git log -1 --pretty=oneline <sha>` and return the resulting line
   * (`<short-sha> <subject>`) or an empty string when the commit is not
   * present locally. Used by the qfg-7429.5 denial renderer to print the
   * offending commit's identity alongside the server's recovery message.
   */
  getCommitOneline(dir: string, sha: string): Promise<string>
  /**
   * Pack-push (qfg-7429.4) — resolve HEAD as a branch name or refuse
   * cleanly. Returns the documented refusal text for detached HEAD and
   * the local default branch being `master`. The result drives the
   * `targetRef` the server sees on success.
   */
  getCurrentBranch(dir: string): Promise<CurrentBranchResult>
  /** Pack-push — local HEAD SHA. Forwarded as `newSha` on the wire. */
  getHeadSha(dir: string): Promise<string>
  /**
   * Returns the workspace-HEAD sha that the diff was computed against —
   * threaded into `configs.push` as `expectedSha` for the server-side
   * optimistic lock (qfg-gj3i). Clone path: the local `origin/main` SHA
   * after fetch. Bare path: the probe clone's HEAD. Undefined only when
   * neither is available; the server rejects a missing value with a 426.
   */
  getOriginMainSha(dir: string): Promise<string | undefined>
  /**
   * Pack-push — local SHA for `origin/<branchName>`, or undefined when
   * the remote-tracking ref doesn't exist yet (brand-new branch).
   * Drives `expectedSha`: defined → SHA, undefined → zero-OID.
   */
  getRemoteBranchSha(dir: string, branchName: string): Promise<string | undefined>
  /** Returns the `remote.origin.url` for the repo, or undefined if unset / not a repo. */
  getRemoteOriginUrl(dir: string): Promise<string | undefined>
  /**
   * qfg-7429.6 — return the tree SHA for `<ref>^{tree}`, or undefined when
   * the ref can't be resolved. Used by the legacy-divergence detector in
   * the pack-push conflict handler: workspaces created before pack-push
   * shipped have local commit SHAs that diverge from origin even when the
   * tree content is identical (the old server fabricated commits). If
   * `HEAD^{tree}` matches `origin/<branch>^{tree}`, the apparent conflict
   * is actually that one-shot legacy state, not a real concurrent push.
   */
  getTreeShaForRef(dir: string, ref: string): Promise<string | undefined>
  /** Returns true if the dir has a `.git/` (worktree or repo). */
  isGitRepo(dir: string): Promise<boolean>
  /**
   * Returns true if origin/main has commits the local HEAD does not have
   * (local strictly behind, or diverged). False when local is up-to-date
   * or strictly ahead of origin/main, or when origin/main is unknown.
   *
   * The clone-path stale-HEAD guard (qfg-fboj) refuses to push in either
   * "behind" or "diverged" state because both produce a diff that ships
   * REVERSAL deltas to the server, silently undoing remote-newer commits.
   */
  isLocalBehindRemote(dir: string): Promise<boolean>
  /** Set origin to `url` (add if missing, set-url if present). */
  setRemoteOrigin(dir: string, url: string): Promise<void>
}

/** Server-side `kind` enum (matches `FileDeltaSchema` in app-quonfig). */
export type ServerFileKind = 'add' | 'delete' | 'modify'

export interface ServerFileDelta {
  afterJson?: string
  beforeJson?: string
  kind: ServerFileKind
  path: string
}

export interface ConfigPushInput {
  expectedSha?: string
  files: ServerFileDelta[]
  message?: string
  workspaceId: string
}

export type ConfigPushResult =
  | {kind: 'bad-request'; message: string}
  | {kind: 'conflict'; message: string}
  | {commitSha: string; kind: 'success'}
  | {denials: PushDenial[]; kind: 'denied'}

export interface PushDenial {
  path: string
  reason: string
  requiredPermission: string
}

/**
 * Pack-push wire input for `configs.gitPush` (qfg-7429.4). The pack
 * itself stays raw on the CLI side; the HTTP client base64-encodes it
 * so the JSON envelope stays text-safe.
 */
export interface GitPushInput {
  /** Remote tip the CLI saw (zero-OID for a brand-new branch). */
  expectedSha: string
  /**
   * qfg-7429.5 / §6: true when at least one configured git remote on
   * the local clone does not normalize to the backend's Quonfig repo
   * URL. The server uses this to decide whether to attach the
   * GitHub-fork dead-end `suggestedRecovery` block to a 403 response.
   */
  hasUpstreamRemote: boolean
  /** Local HEAD being published. Server returns this back as commitSha. */
  newSha: string
  pack: Uint8Array
  /** `refs/heads/main` or `refs/heads/<branch>`. */
  targetRef: string
  workspaceId: string
}

/**
 * Pack-push denial. Carries `commitSha` so the CLI can name which
 * commit failed authz — the §6 GitHub-fork dead-end UX (rendered
 * fully in qfg-7429.5).
 */
export interface GitPushDenial {
  commitSha: string
  path: string
  reason: string
  requiredPermission: string
}

/**
 * Server-emitted recovery hint for the GitHub-fork dead-end (§6 of
 * the design plan). Currently the only `kind` is `revert-upstream`;
 * future kinds are forward-compatible because the discriminator is
 * tagged.
 */
export type SuggestedRecovery = {
  kind: 'revert-upstream'
  offendingCommitSha: string
  message: string
}

export type GitPushResult =
  | {kind: 'success'; commitSha: string; ref: string}
  | {kind: 'conflict'; message: string}
  | {kind: 'bad-request'; message: string}
  | {kind: 'denied'; denials: GitPushDenial[]; suggestedRecovery?: SuggestedRecovery}

export type ConfirmIO = {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export interface RunPushInput {
  /** Absolute path to the local dir the user is pushing. */
  dir: string
  /**
   * Global `--interactive` / `--no-interactive` flag (defaults to `true`
   * upstream). When explicitly false, runPush refuses to invoke any prompt
   * and instead aborts with a message that points the user at `--yes` (for
   * the standard Y/N) or explains that destructive pushes always require
   * interactive typed-slug confirmation. qfg-3uks Item B: the previous
   * behaviour was to fall through to the prompt, which immediately resolved
   * to a decline against a non-TTY stdin.
   */
  interactive?: boolean
  /** `--message` — optional commit message override (bare path only). */
  message?: string
  /** `--no-pin-write` — do not offer to write the slug pin into quonfig.json. */
  noPinWrite: boolean
  /**
   * Caller's resolved org slug for this workspace. Used to construct the
   * `<org>/<ws>` pin when the backend's mint-token returns just the bare
   * workspace component (current backend behavior). Optional in tests; if
   * omitted, pin backfill only runs when the backend already returns the
   * slash form.
   */
  orgSlug?: string
  /** `--workspace` flag, or the active profile's workspace UUID. Must be non-empty. */
  requestedTarget: string
  /** `--skip-validate` — suppress the validate step. */
  skipValidate: boolean
  /** `--yes` — skip standard Y/N confirm. Never skips typed-slug. */
  yes: boolean
}

export interface RunPushDeps {
  /** Optional io streams for confirmation prompts. Defaults to process stdin/stdout. */
  confirmIO?: ConfirmIO
  /** Error logger; defaults to console.error. */
  errLog?: (line: string) => void
  gitOps: GitOps
  /** Logger; defaults to console.log. */
  log?: (line: string) => void
  /**
   * Resolve the backend's identity for this workspace. Returns repoUrl,
   * workspaceSlug, workspaceId — used by the identity check and (for
   * read-only auth) by the bare-path probe-clone and clone-path fetch.
   *
   * Named `mintWriteToken` for historical reasons; as of qfg-azk.13 the
   * push code path no longer mints a write-scoped Gitea token (server-side
   * commit via `configs.push`), so the real implementation now mints a
   * read-scope token. The name is preserved to keep the test harness shape
   * stable across the qfg-azk.13 transition.
   */
  mintWriteToken(requestedTarget: string): Promise<GiteaTokenMintResult>
  /**
   * Pack-push — call the server-side `configs.gitPush` oRPC procedure
   * (qfg-7429.4). Used by the clone-path dispatch; bare-path still
   * routes through `pushToServer` above.
   */
  pushPackToServer(input: GitPushInput): Promise<GitPushResult>
  /**
   * Call the server-side `configs.push` oRPC procedure. Returns a tagged
   * union so callers can distinguish success / per-file denials / a stale
   * expectedSha conflict / a path allow-list violation without parsing
   * HTTP status codes.
   */
  pushToServer(input: ConfigPushInput): Promise<ConfigPushResult>
  /** Run `qfg validate` semantics. Should throw on error. */
  validate(dir: string): Promise<{errors: string[]}>
}

export type RunPushResult =
  | {kind: 'aborted'; reason: string}
  | {kind: 'pushed'; dispatchedAs: 'clone-path' | 'bare-path'; commitSha?: string | null}
  | {kind: 'no-op'; reason: string}

export class PushFatalError extends Error {
  code: string
  constructor(message: string, code = 'PUSH_FATAL') {
    super(message)
    this.code = code
    this.name = 'PushFatalError'
  }
}

/**
 * Normalize a git remote URL for case-insensitive-host comparison. Mirrors
 * the logic in `identity-check.ts` but we only need the boolean "do these
 * point at the same repo" answer.
 */
const normalizeForCompare = (url: string): string => {
  const stripped = url.replace(/^([a-z][\d+.a-z-]*:\/\/)[^/@]+@/i, '$1')
  try {
    const u = new URL(stripped)
    const host = u.host.toLowerCase()
    const pathname = u.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
    return `${u.protocol}//${host}${pathname}`
  } catch {
    return url.trim()
  }
}

const sameRepo = (a: string, b: string): boolean => normalizeForCompare(a) === normalizeForCompare(b)

/**
 * qfg-glrd.6: the `Pushed-Via: cli` trailer was retired. Audit data
 * now lives in the server-side `push_events` table (qfg-glrd.4), so a
 * CLI-appended trailer would be redundant — and CLI trailers also
 * break SHA identity end-to-end once pack-push lands (the message the
 * user committed wouldn't match the message that travels to the server).
 *
 * Kept as a no-op shim instead of deleted so callers and tests don't
 * need a coordinated cross-repo rename. Will be removed once every
 * caller has been updated to drop the call entirely.
 */
export const withPushedViaTrailer = (message: string): string => message

export async function runPush(input: RunPushInput, deps: RunPushDeps): Promise<RunPushResult> {
  const log = deps.log ?? ((s: string) => console.log(s))
  const errLog = deps.errLog ?? ((s: string) => console.error(s))

  if (!input.requestedTarget || input.requestedTarget.trim().length === 0) {
    throw new PushFatalError(
      'No workspace target set. Pass --workspace or run `qfg login` to set the active profile workspace.',
      'NO_TARGET',
    )
  }

  if (!fs.existsSync(input.dir)) {
    throw new PushFatalError(`Directory does not exist: ${input.dir}`, 'NO_DIR')
  }

  // Guard 1 pre-work: read repo pin + current origin BEFORE we mint a write
  // token. The identity check happens after minting (so we can cross-reference
  // the backend's canonical identity) but we want the pin/origin up front.
  // The pin is `<org>/<ws>`; identity-check still operates on the workspace
  // component until backend responses carry the org slug too (qfg-kr7 epic).
  // A legacy bare-slug pin is treated as "no pin set" so the post-push
  // backfill can rewrite it to the canonical form.
  let repoPin: Awaited<ReturnType<typeof readWorkspaceSlug>>
  try {
    repoPin = await readWorkspaceSlug(input.dir)
  } catch {
    repoPin = undefined
  }
  const repoPinSlug = repoPin?.workspaceSlug
  const hasGit = await deps.gitOps.isGitRepo(input.dir)
  // Multi-remote support (qfg-glrd.3): walk EVERY configured remote, not
  // just `origin`. Customers commonly run `origin=github` for PR review and
  // a secondary remote against Quonfig. Identity check accepts as long as
  // any one of them matches the backend.
  const remoteUrls = hasGit ? await deps.gitOps.getAllRemoteUrls(input.dir) : []
  // Clone-path dispatch still keys off `origin` specifically — the
  // implementation reads `origin/main` and pushes via origin. With a
  // non-matching origin (e.g. origin=github), the bare-path probe clone is
  // used instead. Identity-check already accepted the push via a different
  // remote, so this is a dispatch detail, not a refusal.
  const remoteOriginUrl = hasGit ? await deps.gitOps.getRemoteOriginUrl(input.dir) : undefined

  // Mint the write token. The backend accepts a slug OR a UUID for workspaceId
  // and resolves to the same row — we trust whatever `requestedTarget` is.
  const backend = await deps.mintWriteToken(input.requestedTarget)

  // Guards 1 + 2: cross-check the three identity signals.
  const identity = checkIdentity({
    requestedTarget: input.requestedTarget,
    repoPinSlug,
    remoteUrls,
    backend: {
      workspaceSlug: backend.workspaceSlug,
      workspaceId: backend.workspaceId,
      repoUrl: backend.repoUrl,
    },
  })

  if (identity.kind === 'abort') {
    errLog(`Identity check failed: ${identity.reason}`)
    for (const [k, v] of Object.entries(identity.details)) {
      errLog(`  ${k}: ${v}`)
    }
    errLog('Refusing to push. --yes does not override this.')
    throw new PushFatalError(`identity check: ${identity.reason}`, 'IDENTITY_ABORT')
  }

  const requiresTypedSlug = identity.kind === 'requires-typed-slug-confirmation'

  // Guard: validation. Skipped with --skip-validate.
  if (!input.skipValidate) {
    log('Verifying config files...')
    const result = await deps.validate(input.dir)
    if (result.errors.length > 0) {
      errLog(`Found ${result.errors.length} validation error(s):`)
      for (const msg of result.errors) errLog(`  ${msg}`)
      throw new PushFatalError('validation failed; pass --skip-validate to bypass', 'VALIDATION_FAILED')
    }

    log('Validation passed.')
  }

  // Dispatch: clone path vs bare path.
  //
  // Clone path: the dir has a `.git/` AND its origin normalizes to the
  // backend.repoUrl. We push HEAD directly.
  //
  // Bare path: no `.git/`, OR the origin points elsewhere. We clone the cloud
  // repo into a scratch dir inside `.quonfig-push-clone/` and stack a commit
  // that mirrors the local dir's contents on top.
  const isClonePath = hasGit && remoteOriginUrl !== undefined && sameRepo(remoteOriginUrl, backend.repoUrl)
  const dispatchedAs: 'bare-path' | 'clone-path' = isClonePath ? 'clone-path' : 'bare-path'

  // Clone path: align origin with the backend so the gitOps.fetch + diff
  // walk authenticates against the read URL we minted. The bare path's
  // probe-clone path bypasses local origin entirely.
  //
  // Pack-push (qfg-7429.4): the §4.1 step-1 refusals run BEFORE any
  // network work in clone-path so a detached-HEAD or `master` checkout
  // gets a clear error message without us pinging Gitea or the backend.
  let currentBranch: CurrentBranchResult | undefined
  if (isClonePath) {
    currentBranch = await deps.gitOps.getCurrentBranch(input.dir)
    if (currentBranch.kind === 'detached') {
      throw new PushFatalError(currentBranch.message, 'DETACHED_HEAD')
    }
    if (currentBranch.kind === 'master') {
      throw new PushFatalError(currentBranch.message, 'MASTER_BRANCH')
    }

    await deps.gitOps.setRemoteOrigin(input.dir, backend.repoUrl)
    log('Fetching from remote...')
    await deps.gitOps.fetch(input.dir)

    // Guard 4 (qfg-fboj): refuse to push when local HEAD is behind or has
    // diverged from origin/main. The §4.1 server-side fast-forward check
    // already covers correctness; this client-side guard turns a 409 round
    // trip into a fast local error with a `qfg pull` hint. Only meaningful
    // on `main` — branch pushes are evaluated against origin/<branch>, not
    // origin/main, and may legitimately diverge.
    if (currentBranch.name === 'main' && (await deps.gitOps.isLocalBehindRemote(input.dir))) {
      throw new PushFatalError(
        'Local HEAD is behind origin/main. Run `qfg pull` first to merge remote changes, then re-run `qfg push`.',
        'STALE_HEAD',
      )
    }

    // Migration cleanup (qfg-0fn): older `qfg pull` runs wrote the
    // workspace pin to the working tree without committing. The next
    // diff would miss it. Sweep up that legacy state IF the only dirty
    // change to quonfig.json is the matching workspace pin — never
    // silently commit other uncommitted edits the user has in flight.
    try {
      const pinFix = await commitPinFixIfPinOnly(input.dir, 'quonfig.json', backend.workspaceSlug)
      if (pinFix.kind === 'committed') {
        log(`Committed workspace pin "${pinFix.slug}" to quonfig.json (legacy backfill from prior qfg pull).`)
      } else if (pinFix.kind === 'skipped') {
        log(`Note: quonfig.json has uncommitted changes (${pinFix.reason}). They will not be included in this push.`)
      }
    } catch {
      /* non-fatal */
    }

    // Guard 5 (qfg-fboj): warn loudly about any tracked file with
    // uncommitted edits beyond the workspace pin. The clone path pushes
    // HEAD content, not the working tree, so these edits are silently
    // dropped from the push. Listing them in the log gives the user a
    // chance to ctrl-C, commit, and retry instead of believing they
    // shipped what's on disk. Untracked files are intentionally not
    // included — same rule as dirtyTrackedFiles in git-ops.ts.
    try {
      const dirty = await deps.gitOps.dirtyTrackedFiles(input.dir)
      const noisyDirty = dirty.filter((f) => f !== 'quonfig.json')
      if (noisyDirty.length > 0) {
        log('')
        log('Warning: working tree has uncommitted changes that will NOT be included in this push:')
        for (const f of noisyDirty) log(`  ${f}`)
        log('Commit them with `git add` + `git commit` and re-run `qfg push` if you meant to ship them.')
      }
    } catch {
      /* non-fatal */
    }
  }

  const deltas = await deps.gitOps.diffHeadVsOrigin(input.dir)
  const totalFilesInRemote = await deps.gitOps.countFilesInRemote(input.dir)
  const unpinned = repoPinSlug === undefined
  const summary = summarizeDiff(deltas, {totalFilesInRemote, unpinned})

  log('')
  log(
    summary.renderText({
      workspaceSlug: backend.workspaceSlug,
      repoUrl: stripAuth(backend.repoUrl),
      branch: 'main',
      localDir: input.dir,
    }),
  )
  log('')

  if (summary.totals.filesTouched === 0) {
    return {kind: 'no-op', reason: 'Local tree matches remote HEAD. Nothing to push.'}
  }

  const decision = await decideConfirm({
    destructive: summary.isDestructive,
    requiresTypedSlug,
    yes: input.yes,
    interactive: input.interactive,
    workspaceSlug: backend.workspaceSlug,
    confirmIO: deps.confirmIO,
  })
  if (!decision.ok) {
    log('Aborted, nothing pushed.')
    return {kind: 'aborted', reason: decision.reason}
  }

  // Pack-push branch (qfg-7429.4): clone-path now ships actual git
  // commit objects via `configs.gitPush`. The bare-path branch below is
  // the unchanged file-delta wire shape used by the UI and CI pushes
  // that don't carry a `.git/`.
  let pushedCommitSha: string | null | undefined
  if (isClonePath && currentBranch && currentBranch.kind === 'branch') {
    const branchName = currentBranch.name
    const targetRef = `refs/heads/${branchName}`

    // expectedSha: for `main`, the origin/main SHA we already know; for
    // branches, look up `origin/<branch>` (zero-OID for brand-new branches).
    const expectedShaRaw =
      branchName === 'main'
        ? await deps.gitOps.getOriginMainSha(input.dir)
        : await deps.gitOps.getRemoteBranchSha(input.dir, branchName)
    const expectedSha = expectedShaRaw ?? ZERO_OID
    const newSha = await deps.gitOps.getHeadSha(input.dir)

    log('Building pack...')
    const pack = await deps.gitOps.buildPack(input.dir, expectedSha, newSha)

    // §6 / qfg-7429.5: tell the server whether the local clone has a
    // non-Quonfig upstream so it can decide whether to attach a
    // GitHub-fork dead-end recovery hint to a 403.
    const hasUpstreamRemote = remoteUrls.some((u) => !sameRepo(u, backend.repoUrl))

    log('Sending push to Quonfig cloud...')
    const packResult = await deps.pushPackToServer({
      workspaceId: backend.workspaceId,
      targetRef,
      expectedSha,
      newSha,
      pack,
      hasUpstreamRemote,
    })

    if (packResult.kind === 'denied') {
      errLog(`Push denied for ${packResult.denials.length} commit(s):`)
      for (const d of packResult.denials) {
        // qfg-7429.5 denial line: `<short-sha>  <path>  -- <reason>, requires <requiredPermission>`
        errLog(`  ${d.commitSha.slice(0, 8)}  ${d.path}  -- ${d.reason}, requires ${d.requiredPermission}`)
      }
      if (packResult.suggestedRecovery) {
        errLog('')
        errLog(packResult.suggestedRecovery.message)
        try {
          const oneline = await deps.gitOps.getCommitOneline(input.dir, packResult.suggestedRecovery.offendingCommitSha)
          if (oneline.length > 0) {
            errLog(`  ${oneline}`)
          }
        } catch {
          /* non-fatal — the recovery message is the load-bearing part */
        }
      }
      throw new PushFatalError(
        `Push denied for ${packResult.denials.length} commit(s). See errors above.`,
        'PUSH_DENIED',
      )
    }

    if (packResult.kind === 'conflict') {
      // qfg-7429.6: every workspace ever pushed under the pre-pack-push
      // fabricate-commit handler has local commit SHAs that diverge from
      // origin even when content is identical. The first pack push from
      // such a dir trips the server's fast-forward check. Distinguish
      // that one-shot legacy state from a real conflict by comparing
      // HEAD's tree to origin/<branch>'s tree: equal trees → migration
      // hint (`git reset --hard origin/<branch>`); different trees →
      // existing qfg-pull message. Rebase would produce phantom replay
      // commits with new SHAs forever, so it is NOT the recommended path.
      let headTree: string | undefined
      let originTree: string | undefined
      try {
        headTree = await deps.gitOps.getTreeShaForRef(input.dir, 'HEAD')
      } catch {
        /* fall through — treat unknown tree as "real conflict" */
      }
      try {
        originTree = await deps.gitOps.getTreeShaForRef(input.dir, `origin/${branchName}`)
      } catch {
        /* fall through */
      }

      if (headTree && originTree && headTree === originTree) {
        errLog('')
        errLog(`Your local ${branchName} and origin/${branchName} have diverged from an older push using the`)
        errLog('fabricate-commit handler. Your local content matches origin (no real conflict).')
        errLog('')
        errLog(`To align: git reset --hard origin/${branchName}`)
        errLog('Then re-run qfg push.')
        errLog('')
        errLog('This is a one-time cutover. Subsequent pushes from this dir will preserve your')
        errLog('commit SHAs end-to-end.')
        throw new PushFatalError(
          `Legacy orphan-commit divergence with origin/${branchName}. Run \`git reset --hard origin/${branchName}\` and retry.`,
          'CONFLICT_LEGACY_DIVERGE',
        )
      }

      throw new PushFatalError(
        `Remote moved while preparing this push (${packResult.message}). Run \`qfg pull\` and retry.`,
        'CONFLICT',
      )
    }

    if (packResult.kind === 'bad-request') {
      throw new PushFatalError(`Push rejected by server: ${packResult.message}`, 'BAD_REQUEST')
    }

    pushedCommitSha = packResult.commitSha

    // §4.1 step 4: post-push refresh — `git fetch origin` (NOT `git
    // reset`) brings the local origin/<ref> tracking ref in line with
    // the SHA the server published, so subsequent `qfg pull` runs are
    // a no-op. SHAs already match by construction (pack-push round-trip).
    try {
      await deps.gitOps.fetch(input.dir)
    } catch {
      /* non-fatal — the push itself succeeded */
    }

    const commitCount = await deps.gitOps.countCommitsBetween(input.dir, expectedSha, newSha)
    log(`Pushed ${commitCount} commit(s) to origin/${targetRef} as ${newSha.slice(0, 7)}. Local repo in sync.`)
  } else {
    const baseMessage = input.message ?? `qfg push: ${summary.totals.filesTouched} file change(s)`
    const commitMessage = withPushedViaTrailer(baseMessage)

    const serverFiles: ServerFileDelta[] = deltas.map((d) => ({
      path: d.path,
      kind: toServerKind(d.kind),
      ...(d.beforeJson === undefined ? {} : {beforeJson: d.beforeJson}),
      ...(d.afterJson === undefined ? {} : {afterJson: d.afterJson}),
    }))

    // qfg-gj3i: expectedSha is the workspace HEAD the server checks its
    // optimistic lock against. For the bare path it is the probe clone's
    // HEAD (resolved inside getOriginMainSha, qfg-nhcb). It must be present
    // — the server rejects a missing expectedSha with a forced-upgrade 426.
    const expectedSha = await deps.gitOps.getOriginMainSha(input.dir)

    log('Sending push to Quonfig cloud...')
    const result = await deps.pushToServer({
      workspaceId: backend.workspaceId,
      files: serverFiles,
      message: commitMessage,
      ...(expectedSha === undefined ? {} : {expectedSha}),
    })

    if (result.kind === 'denied') {
      errLog(`Push denied for ${result.denials.length} file(s):`)
      for (const d of result.denials) {
        errLog(`  ${d.path}: missing permission ${d.requiredPermission}`)
      }

      throw new PushFatalError(`Push denied for ${result.denials.length} file(s). See errors above.`, 'PUSH_DENIED')
    }

    if (result.kind === 'conflict') {
      throw new PushFatalError(
        `Remote moved while preparing this push (${result.message}). Run \`qfg pull\` and retry.`,
        'CONFLICT',
      )
    }

    if (result.kind === 'bad-request') {
      throw new PushFatalError(`Push rejected by server: ${result.message}`, 'BAD_REQUEST')
    }

    pushedCommitSha = result.commitSha
  }

  if (unpinned && !input.noPinWrite) {
    // The backend's mint-token still returns the bare workspace component;
    // combine it with the caller-supplied orgSlug locally. If the backend
    // ever upgrades to slash form, tryParseWorkspacePin handles that case
    // and we use its parts directly. Without either signal, skip — the
    // pin is advisory and a partial slash form would be worse than absent.
    const parsedBackend = tryParseWorkspacePin(backend.workspaceSlug)
    const backendPin =
      parsedBackend ?? (input.orgSlug ? {orgSlug: input.orgSlug, workspaceSlug: backend.workspaceSlug} : undefined)
    if (backendPin) {
      try {
        await writeWorkspaceSlug(input.dir, backendPin)
        log(`Wrote workspace = "${backendPin.orgSlug}/${backendPin.workspaceSlug}" into quonfig.json`)
      } catch {
        /* non-fatal; pin is advisory */
      }
    }
  }

  return {kind: 'pushed', dispatchedAs, commitSha: pushedCommitSha}
}

const toServerKind = (kind: FileDelta['kind']): ServerFileKind => {
  switch (kind) {
    case 'added': {
      return 'add'
    }

    case 'deleted': {
      return 'delete'
    }

    case 'modified': {
      return 'modify'
    }
  }
}

interface ConfirmArgs {
  confirmIO?: ConfirmIO
  destructive: boolean
  /**
   * Global `--interactive` flag. `false` means the user explicitly passed
   * `--no-interactive` and we MUST NOT prompt; we abort with a message that
   * points at `--yes` instead. Anything else (true / undefined) means
   * prompting is allowed.
   */
  interactive?: boolean
  requiresTypedSlug: boolean
  workspaceSlug: string
  yes: boolean
}

type ConfirmDecision = {ok: false; reason: string} | {ok: true}

/**
 * Map the guard outputs to the right prompt:
 *   - Typed-slug (always, never skipped by --yes) when identity demanded it
 *     OR when the diff is destructive. Refused outright in --no-interactive
 *     mode because there is no way to type a slug headlessly.
 *   - Standard Y/N otherwise, unless --yes is set. In --no-interactive mode
 *     without --yes we abort with a clear message pointing the user at
 *     `--yes`, rather than falling through to a prompt that auto-declines
 *     against a non-TTY stdin (qfg-3uks Item B).
 */
async function decideConfirm(args: ConfirmArgs): Promise<ConfirmDecision> {
  const nonInteractive = args.interactive === false
  const needsTyped = args.requiresTypedSlug || args.destructive
  if (needsTyped) {
    if (nonInteractive) {
      return {
        ok: false,
        reason:
          'destructive change requires interactive typed-slug confirmation; refusing in --no-interactive mode (--yes does not bypass the typed-slug prompt)',
      }
    }

    const ok = await confirmTypedSlug(
      args.workspaceSlug,
      `Type the workspace slug "${args.workspaceSlug}" to confirm: `,
      args.confirmIO ?? {},
    )
    return ok ? {ok: true} : {ok: false, reason: 'typed-slug confirmation failed; nothing pushed'}
  }

  if (args.yes) return {ok: true}
  if (nonInteractive) {
    return {
      ok: false,
      reason: '--no-interactive set without --yes; pass --yes to skip the standard Y/N confirmation prompt',
    }
  }

  const ok = await confirmYesNo('Proceed? [y/N] ', args.confirmIO ?? {})
  return ok ? {ok: true} : {ok: false, reason: 'user declined at confirm prompt'}
}

const stripAuth = (url: string): string => {
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    return url
  }
}
