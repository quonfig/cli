/**
 * Guards 1 + 2 of `qfg push`, as a pure function.
 *
 * See `project/plans/cli-git-sync.md` — "Safety model (three independent guards)".
 *
 * The caller collects three identity signals about the local directory the user
 * is about to push:
 *
 *   A. Requested target   — slug or UUID the user asked for (--workspace or profile default)
 *   B. Repo pin           — `workspace` slug from `quonfig.json`, if present
 *   C. Remote URLs        — `git remote -v` URLs on the local repo, if any
 *
 * ...and the canonical `backend` identity (the workspace the gitea.token
 * response was minted for). This module cross-checks them and returns one of:
 *
 *   - ok                                    all defined signals agree
 *   - abort                                 any defined signal disagrees
 *   - requires-typed-slug-confirmation      the repo is unpinned and has no
 *                                           remotes, so only the requested
 *                                           target supports our identity —
 *                                           we demand the user type the slug
 *
 * Multi-remote support (qfg-glrd.3): customers often use GitHub for PR review
 * (origin = github.com/their-org/configs) and a secondary remote for Quonfig.
 * As long as ANY configured remote matches the backend's repo URL, the remote
 * signal is `match`. Only when every configured remote points elsewhere do we
 * abort — and the abort details list every remote that was considered.
 *
 * The module is intentionally pure: no I/O, no prompting, no UI. The UI layer
 * (confirm prompts, diff summary) and the data-fetch layer (reading quonfig.json,
 * shelling out to git, calling gitea.token) live elsewhere.
 */

export interface IdentityCheckInput {
  /** The canonical workspace identity from the backend (gitea.token response). */
  backend: {
    workspaceSlug: string
    workspaceId: string
    repoUrl: string
  }
  /**
   * "C. Remote URLs" — every configured `git remote` URL on the local repo.
   * Empty array means "no remotes configured" (either not a git repo, or a
   * fresh repo with no remotes). Length ≥ 1 means at least one remote must
   * match the backend's repo URL.
   */
  remoteUrls: string[]
  /** "B. Repo pin" — slug from `quonfig.json.workspace`, if present. */
  repoPinSlug: string | undefined
  /** "A. Requested target" — what the user asked for. Slug or UUID. */
  requestedTarget: string
}

export type IdentityCheckOutcome =
  | {kind: 'ok'; canonicalSlug: string}
  | {kind: 'abort'; reason: string; details: Record<string, string | string[]>}
  | {kind: 'requires-typed-slug-confirmation'; canonicalSlug: string; reason: string}

/**
 * Resolved identity for a single input signal against the backend.
 *
 * `match` means this signal points at the backend's workspace.
 * `mismatch` means this signal points at a *different* workspace.
 * `malformed` means we could not resolve the signal at all — treated as a
 *   mismatch for safety (see the malformed-origin test case and comment below).
 */
type Resolution = 'match' | 'mismatch' | 'malformed'

/**
 * Normalize a git remote URL so we can compare two URLs that describe the
 * same repo:
 *   - strip any `user:pw@` basic-auth prefix
 *   - strip a trailing `.git`
 *   - lowercase the host (not the path — repo slugs may be case-sensitive)
 *   - ignore trailing slash
 *
 * Returns `undefined` when the URL is too malformed to parse — callers treat
 * that as the `malformed` resolution.
 */
const normalizeRemoteUrl = (url: string): string | undefined => {
  const trimmed = url.trim()
  if (!trimmed) return undefined

  // Strip basic-auth: "https://user:pw@host/..." -> "https://host/..."
  const stripped = trimmed.replace(/^([a-z][\d+.a-z-]*:\/\/)[^/@]+@/i, '$1')

  let parsed: URL
  try {
    parsed = new URL(stripped)
  } catch {
    return undefined
  }

  const host = parsed.host.toLowerCase()
  // Strip trailing "/" first so a trailing-slash URL still has its ".git" suffix recognized.
  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
  return `${parsed.protocol}//${host}${pathname}`
}

const resolveRequested = (requested: string, backend: IdentityCheckInput['backend']): Resolution => {
  if (requested === backend.workspaceSlug || requested === backend.workspaceId) return 'match'
  return 'mismatch'
}

const resolvePin = (pin: string, backend: IdentityCheckInput['backend']): Resolution => {
  if (pin === backend.workspaceSlug) return 'match'
  return 'mismatch'
}

/**
 * Resolve the remote signal: any single configured remote that normalizes to
 * the backend's repo URL counts as a `match`. If we hit at least one such
 * match, the overall resolution is `match` regardless of how many other
 * remotes are configured. Otherwise, if every remote is either a clean
 * mismatch or malformed, the resolution is `mismatch` — the user's git
 * config doesn't agree with the workspace we're pushing to.
 */
const resolveRemotes = (remotes: string[], backend: IdentityCheckInput['backend']): Resolution => {
  const target = normalizeRemoteUrl(backend.repoUrl)
  if (!target) return 'malformed'

  let sawMalformed = false
  for (const remote of remotes) {
    const normalized = normalizeRemoteUrl(remote)
    if (!normalized) {
      sawMalformed = true
      continue
    }
    if (normalized === target) return 'match'
  }

  // No remote matched. If every remote was malformed and we never saw a
  // resolvable mismatch, surface the malformed case so the abort message
  // can speak about unreadable URLs specifically. Otherwise it's a plain
  // mismatch — none of the configured remotes point at us.
  if (sawMalformed && remotes.every((r) => normalizeRemoteUrl(r) === undefined)) {
    return 'malformed'
  }
  return 'mismatch'
}

export function checkIdentity(input: IdentityCheckInput): IdentityCheckOutcome {
  if (!input.requestedTarget || input.requestedTarget.length === 0) {
    // Programming error: the caller is responsible for resolving the user's
    // --workspace flag / profile default into a non-empty string before
    // calling this function. If they didn't, crash loudly rather than
    // producing a misleading abort.
    throw new Error('checkIdentity: requestedTarget is required (slug or UUID)')
  }

  const backend = input.backend
  const requested = resolveRequested(input.requestedTarget, backend)
  const pin = input.repoPinSlug === undefined ? undefined : resolvePin(input.repoPinSlug, backend)
  // Empty `remoteUrls` means "no remotes configured" — we have no signal to
  // resolve, identical to the old `remoteOriginUrl === undefined` case.
  const remote = input.remoteUrls.length === 0 ? undefined : resolveRemotes(input.remoteUrls, backend)

  // Judgment call (flagged in tests): a malformed remote with no resolvable
  // alternative is a signal we cannot resolve. We treat it as `mismatch`
  // rather than `missing` so the guard aborts — it is safer to refuse a push
  // with an unreadable remote than to silently drop that signal and rely on
  // the pin alone.
  const signalLabels: Record<string, Resolution | undefined> = {
    requested,
    pin,
    remote,
  }

  // Collect which sources disagree with the backend (or are malformed).
  const disagreeing: string[] = []
  for (const [name, res] of Object.entries(signalLabels)) {
    if (res === 'mismatch' || res === 'malformed') disagreeing.push(name)
  }

  // Build a details payload that shows each input's raw value and resolved status.
  // Useful for the abort UI to render a concrete "this is why we stopped" message.
  const details: Record<string, string | string[]> = {
    requestedTarget: input.requestedTarget,
    requestedResolution: requested,
    backendSlug: backend.workspaceSlug,
    backendId: backend.workspaceId,
    backendRepoUrl: backend.repoUrl,
  }
  if (input.repoPinSlug !== undefined) {
    details.repoPinSlug = input.repoPinSlug
    details.pinResolution = pin!
  }

  if (input.remoteUrls.length > 0) {
    // Surface every remote URL that was considered. When multiple remotes
    // disagree the user needs to see each one to figure out which to fix.
    details.remoteUrls = input.remoteUrls
    details.remoteResolution = remote!
  }

  if (disagreeing.length > 0) {
    // Any single defined source pointing somewhere other than the backend is
    // grounds to abort — the user has asked for A but has evidence of B.
    const reason =
      disagreeing.length === 1
        ? `${disagreeing[0]} disagrees with backend workspace "${backend.workspaceSlug}"`
        : `${disagreeing.join('/')} disagree with backend workspace "${backend.workspaceSlug}"`
    return {kind: 'abort', reason, details}
  }

  // No disagreement among defined sources. Are we in the "bare dir" case
  // where only the requested target speaks for identity?
  if (input.repoPinSlug === undefined && input.remoteUrls.length === 0) {
    return {
      kind: 'requires-typed-slug-confirmation',
      canonicalSlug: backend.workspaceSlug,
      reason:
        'Local directory has no workspace pin and no git remotes — cannot cross-check the requested target. Confirm by typing the workspace slug.',
    }
  }

  return {kind: 'ok', canonicalSlug: backend.workspaceSlug}
}

/**
 * Walk a list of configured git remote URLs and return the first one that
 * normalizes to the same repo as `backendRepoUrl`. Returns `undefined` if no
 * configured remote matches.
 *
 * Useful for callers that have already resolved the backend and want to know
 * *which* remote authenticated against it (e.g. `qfg pull` updating the URL
 * to embed a fresh token).
 */
export function findQuonfigRemote(remotes: string[], backendRepoUrl: string): string | undefined {
  const target = normalizeRemoteUrl(backendRepoUrl)
  if (!target) return undefined
  for (const remote of remotes) {
    const normalized = normalizeRemoteUrl(remote)
    if (normalized === target) return remote
  }
  return undefined
}
