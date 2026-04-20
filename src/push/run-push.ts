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
import * as path from 'node:path'

import {MIGRATOR_IDENTITY, PushIdentity, cloneAndStackPush} from '../util/clone-and-stack-push.js'
import {readWorkspaceSlug, writeWorkspaceSlug} from '../util/quonfig-json.js'
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
   * (for the bare path) commit. For the clone path this is HEAD vs origin/main.
   * For the bare path the caller hands us the deltas itself.
   */
  diffHeadVsOrigin(dir: string): Promise<FileDelta[]>
  /** `git fetch origin` in the given dir. */
  fetch(dir: string): Promise<void>
  /** Read local git config for author identity (used for bare-path commits). */
  getLocalAuthor(dir: string): Promise<PushIdentity | undefined>
  /** Returns the `remote.origin.url` for the repo, or undefined if unset / not a repo. */
  getRemoteOriginUrl(dir: string): Promise<string | undefined>
  /** Returns true if the dir has a `.git/` (worktree or repo). */
  isGitRepo(dir: string): Promise<boolean>
  /** `git push origin main`. Throws with a PushConflict-ish message on non-ff. */
  push(dir: string): Promise<void>
  /** Set origin to `url` (add if missing, set-url if present). */
  setRemoteOrigin(dir: string, url: string): Promise<void>
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
  /**
   * Copy files from `sourceDir` into `destDir`, skipping `.git/`. Used by the
   * bare path as the `applyDelta` callback handed to `cloneAndStackPush`.
   */
  copyDirMirror(sourceDir: string, destDir: string): Promise<void>
  /** Error logger; defaults to console.error. */
  errLog?: (line: string) => void
  gitOps: GitOps
  /** Logger; defaults to console.log. */
  log?: (line: string) => void
  /** Mint a write token via the backend. */
  mintWriteToken(requestedTarget: string): Promise<GiteaTokenMintResult>
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
  const repoPinSlug = await readWorkspaceSlug(input.dir)
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

  if (isClonePath) {
    return doClonePath(input, deps, backend, requiresTypedSlug, repoPinSlug === undefined, log)
  }

  return doBarePath(input, deps, backend, requiresTypedSlug, repoPinSlug === undefined, log)
}

async function doClonePath(
  input: RunPushInput,
  deps: RunPushDeps,
  backend: GiteaTokenMintResult,
  requiresTypedSlug: boolean,
  unpinned: boolean,
  log: (line: string) => void,
): Promise<RunPushResult> {
  // Point origin at the authenticated URL so `git fetch` / `git push` work
  // without touching global credential helpers.
  await deps.gitOps.setRemoteOrigin(input.dir, backend.repoUrl)

  log('Fetching from remote...')
  await deps.gitOps.fetch(input.dir)

  const deltas = await deps.gitOps.diffHeadVsOrigin(input.dir)
  const totalFilesInRemote = await deps.gitOps.countFilesInRemote(input.dir)
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

  // Short-circuit: literally nothing to push.
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

  log('Pushing to origin/main...')
  try {
    await deps.gitOps.push(input.dir)
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
      throw new PushFatalError(
        'Remote has changes not in local — run `qfg pull` first, then re-run `qfg push`.',
        'NON_FAST_FORWARD',
      )
    }

    throw new PushFatalError(`Push failed: ${msg}`, 'PUSH_FAILED')
  }

  // Offer to pin the workspace slug in quonfig.json if missing. Non-fatal.
  if (unpinned && !input.noPinWrite) {
    try {
      await writeWorkspaceSlug(input.dir, backend.workspaceSlug)
      log(`Wrote workspace = "${backend.workspaceSlug}" into quonfig.json`)
    } catch {
      // non-fatal; pin is advisory
    }
  }

  return {kind: 'pushed', dispatchedAs: 'clone-path'}
}

async function doBarePath(
  input: RunPushInput,
  deps: RunPushDeps,
  backend: GiteaTokenMintResult,
  requiresTypedSlug: boolean,
  unpinned: boolean,
  log: (line: string) => void,
): Promise<RunPushResult> {
  // Scratch clone location: sibling `.quonfig-push-clone-<timestamp>` so we
  // don't clobber or re-use anything from a previous run.
  const scratchDir = path.join(
    path.dirname(path.resolve(input.dir)),
    `.quonfig-push-clone-${Date.now()}`,
  )

  // Local author for the migrated commit. Prefer the local git config in
  // `input.dir` so attribution matches what the user has set. If it is not
  // available, fall back to the migrator identity but tell the user — the plan
  // requires this be loud.
  let author: PushIdentity = MIGRATOR_IDENTITY
  try {
    const local = await deps.gitOps.getLocalAuthor(input.dir)
    if (local && local.name && local.email) {
      author = local
    } else {
      log(
        `Warning: no local git user.name/user.email in ${input.dir}; commits will be attributed to ${MIGRATOR_IDENTITY.name} <${MIGRATOR_IDENTITY.email}>.`,
      )
    }
  } catch {
    log(
      `Warning: could not read local git user identity; commits will be attributed to ${MIGRATOR_IDENTITY.name} <${MIGRATOR_IDENTITY.email}>.`,
    )
  }

  // We need the deltas for the Guard 3 summary BEFORE we decide to commit and
  // push. To produce them we need the scratch clone in hand (so we can compare
  // file-by-file). We clone into the scratch dir, take the diff, show the
  // summary, confirm, then apply the delta via `cloneAndStackPush`.
  //
  // Rather than re-implement cloneAndStackPush's clone step here, we let it
  // own the clone-commit-push pipeline and pass a deltas callback that runs
  // AFTER the clone (it receives the localDir/scratchDir) but BEFORE the
  // commit. `cloneAndStackPush` only exposes an `applyDelta` hook (write files
  // then return), so we split the flow: first a probe clone to take the
  // diff, then the real clone-and-stack-push. This is simpler than rewiring
  // cloneAndStackPush's API.

  // Probe clone.
  await deps.gitOps.fetch(input.dir) // no-op for bare path if not a repo; deps.gitOps may short-circuit
    .catch(() => {
      // bare-path doesn't require a local fetch — swallow the error
    })

  // We don't have a probe clone helper; instead, ask the deps for a bare-path
  // delta computation. The test double will produce this from a fixture; the
  // real implementation walks both trees after ensuring a scratch clone exists.
  // This is provided by the command glue layer.
  const deltas = await deps.gitOps.diffHeadVsOrigin(input.dir)
  const totalFilesInRemote = await deps.gitOps.countFilesInRemote(input.dir)
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

  log('Pushing via clone-and-stack...')
  try {
    const result = await cloneAndStackPush({
      remoteUrl: backend.repoUrl,
      localDir: scratchDir,
      author,
      commitMessage,
      async applyDelta(clonedDir) {
        // The caller promised deps.copyDirMirror copies `input.dir` into
        // `clonedDir`, skipping `.git/`. cloneAndStackPush will `git add --all`
        // after this returns.
        await deps.copyDirMirror(input.dir, clonedDir)
      },
    })

    if (unpinned && !input.noPinWrite) {
      try {
        await writeWorkspaceSlug(input.dir, backend.workspaceSlug)
        log(`Wrote workspace = "${backend.workspaceSlug}" into quonfig.json`)
      } catch {
        // non-fatal
      }
    }

    return {kind: 'pushed', dispatchedAs: 'bare-path', commitSha: result.commitSha}
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/non-fast-forward|fetch first|rejected/i.test(msg)) {
      throw new PushFatalError(
        'Remote has changes not in local — run `qfg pull` first, then re-run `qfg push`.',
        'NON_FAST_FORWARD',
      )
    }

    throw new PushFatalError(`Push failed: ${msg}`, 'PUSH_FAILED')
  } finally {
    // Best-effort cleanup of the scratch clone. Ignore failures so a cleanup
    // problem doesn't mask a real error.
    try {
      fs.rmSync(scratchDir, {recursive: true, force: true})
    } catch {
      /* ignore */
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
    return confirmTypedSlug(args.workspaceSlug, `Type the workspace slug "${args.workspaceSlug}" to confirm: `, args.confirmIO ?? {})
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
