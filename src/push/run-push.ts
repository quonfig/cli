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

export interface GiteaTokenMintResult {
  expiresAt: string | null
  repoUrl: string
  token: string
  workspaceId: string
  workspaceSlug: string
}

export interface GitOps {
  /** Number of tracked files on origin/main (used for the destructive-ratio heuristic). */
  countFilesInRemote(dir: string): Promise<number>
  /**
   * Produce the list of file deltas to render in the Guard 3 summary and
   * send to the server. Each delta carries before/after JSON content per
   * the `configs.push` wire shape (qfg-azk.13). For the clone path this is
   * HEAD vs origin/main; for the bare path it's local vs probe-clone.
   */
  diffHeadVsOrigin(dir: string): Promise<FileDelta[]>
  /** `git fetch origin` in the given dir. */
  fetch(dir: string): Promise<void>
  /** Returns the `remote.origin.url` for the repo, or undefined if unset / not a repo. */
  getRemoteOriginUrl(dir: string): Promise<string | undefined>
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
  /**
   * Tracked files (relative paths) with working-tree or staged changes.
   * Used by the clone-path dirty-tree warning to surface uncommitted
   * edits the user may believe are being pushed (qfg-fboj). Untracked
   * files are excluded — same rule as `dirtyTrackedFiles` in git-ops.ts.
   */
  dirtyTrackedFiles(dir: string): Promise<string[]>
  /**
   * Returns the local SHA of `origin/main` after fetch — the remote tip
   * the diff was computed against — or undefined if no `origin/main` ref
   * exists (bare-path push, or repo never fetched).
   *
   * Threaded into the `configs.push` call as `expectedSha` so the
   * server-side optimistic lock (qfg-gj3i) can reject pushes whose
   * origin moved between fetch and push.
   */
  getOriginMainSha(dir: string): Promise<string | undefined>
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

export type ConfirmIO = {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export interface RunPushInput {
  /** Absolute path to the local dir the user is pushing. */
  dir: string
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

const PUSHED_VIA_TRAILER = 'Pushed-Via: cli'

/** Append the Pushed-Via trailer to a commit message if it isn't already present. */
export const withPushedViaTrailer = (message: string): string => {
  if (message.includes(PUSHED_VIA_TRAILER)) return message
  const trimmed = message.replace(/\s+$/, '')
  return `${trimmed}\n\n${PUSHED_VIA_TRAILER}\n`
}

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
  const remoteOriginUrl = hasGit ? await deps.gitOps.getRemoteOriginUrl(input.dir) : undefined

  // Mint the write token. The backend accepts a slug OR a UUID for workspaceId
  // and resolves to the same row — we trust whatever `requestedTarget` is.
  const backend = await deps.mintWriteToken(input.requestedTarget)

  // Guards 1 + 2: cross-check the three identity signals.
  const identity = checkIdentity({
    requestedTarget: input.requestedTarget,
    repoPinSlug,
    remoteOriginUrl,
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
  if (isClonePath) {
    await deps.gitOps.setRemoteOrigin(input.dir, backend.repoUrl)
    log('Fetching from remote...')
    await deps.gitOps.fetch(input.dir)

    // Guard 4 (qfg-fboj): refuse to push when local HEAD is behind or has
    // diverged from origin/main. Without this guard the HEAD-vs-origin
    // diff produces REVERSAL deltas that silently undo whatever was
    // committed to the cloud since the user last pulled. Tell the user
    // to run `qfg pull` first; the standalone `--ff-only` step keeps
    // push from doing surprising merges on the user's behalf.
    if (await deps.gitOps.isLocalBehindRemote(input.dir)) {
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

  const ok = await decideConfirm({
    destructive: summary.isDestructive,
    requiresTypedSlug,
    yes: input.yes,
    workspaceSlug: backend.workspaceSlug,
    confirmIO: deps.confirmIO,
  })
  if (!ok) {
    log('Aborted, nothing pushed.')
    return {kind: 'aborted', reason: 'user declined at confirm prompt'}
  }

  const baseMessage = input.message ?? `qfg push: ${summary.totals.filesTouched} file change(s)`
  const commitMessage = withPushedViaTrailer(baseMessage)

  const serverFiles: ServerFileDelta[] = deltas.map((d) => ({
    path: d.path,
    kind: toServerKind(d.kind),
    ...(d.beforeJson === undefined ? {} : {beforeJson: d.beforeJson}),
    ...(d.afterJson === undefined ? {} : {afterJson: d.afterJson}),
  }))

  // qfg-gj3i: pass origin/main SHA as expectedSha so the server-side
  // optimistic lock can reject the push if origin moved between fetch
  // and now. Undefined on bare-path; the server treats absence as
  // "non-clone client" and applies its bare-path policy.
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

    throw new PushFatalError(
      `Push denied for ${result.denials.length} file(s). See errors above.`,
      'PUSH_DENIED',
    )
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

  return {kind: 'pushed', dispatchedAs, commitSha: result.commitSha}
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
  requiresTypedSlug: boolean
  workspaceSlug: string
  yes: boolean
}

/**
 * Map the guard outputs to the right prompt:
 *   - Typed-slug (always, never skipped by --yes) when identity demanded it
 *     OR when the diff is destructive.
 *   - Standard Y/N otherwise, unless --yes is set.
 */
async function decideConfirm(args: ConfirmArgs): Promise<boolean> {
  const needsTyped = args.requiresTypedSlug || args.destructive
  if (needsTyped) {
    return confirmTypedSlug(
      args.workspaceSlug,
      `Type the workspace slug "${args.workspaceSlug}" to confirm: `,
      args.confirmIO ?? {},
    )
  }

  if (args.yes) return true
  return confirmYesNo('Proceed? [y/N] ', args.confirmIO ?? {})
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
