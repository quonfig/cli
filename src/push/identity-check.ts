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
 *   C. Remote origin      — `remote.origin.url` on the local git repo, if present
 *
 * ...and the canonical `backend` identity (the workspace the gitea.token
 * response was minted for). This module cross-checks them and returns one of:
 *
 *   - ok                                    all defined signals agree
 *   - abort                                 any two defined signals disagree
 *   - requires-typed-slug-confirmation      the repo is unpinned and has no
 *                                           origin, so only the requested
 *                                           target supports our identity —
 *                                           we demand the user type the slug
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
  /** "C. Remote origin" — the origin URL on the local git repo, if present. */
  remoteOriginUrl: string | undefined
  /** "B. Repo pin" — slug from `quonfig.json.workspace`, if present. */
  repoPinSlug: string | undefined
  /** "A. Requested target" — what the user asked for. Slug or UUID. */
  requestedTarget: string
}

export type IdentityCheckOutcome =
  | {kind: 'ok'; canonicalSlug: string}
  | {kind: 'abort'; reason: string; details: Record<string, string>}
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

const resolveOrigin = (origin: string, backend: IdentityCheckInput['backend']): Resolution => {
  const a = normalizeRemoteUrl(origin)
  const b = normalizeRemoteUrl(backend.repoUrl)
  if (!a || !b) return 'malformed'
  return a === b ? 'match' : 'mismatch'
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
  const origin = input.remoteOriginUrl === undefined ? undefined : resolveOrigin(input.remoteOriginUrl, backend)

  // Judgment call (flagged in tests): a malformed origin URL is a signal we
  // cannot resolve. We treat it as `mismatch` rather than `missing` so the
  // guard aborts — it is safer to refuse a push with an unreadable remote
  // than to silently drop that signal and rely on the pin alone.
  const signalLabels: Record<string, Resolution | undefined> = {
    requested,
    pin,
    origin,
  }

  // Collect which sources disagree with the backend (or are malformed).
  const disagreeing: string[] = []
  for (const [name, res] of Object.entries(signalLabels)) {
    if (res === 'mismatch' || res === 'malformed') disagreeing.push(name)
  }

  // Build a details payload that shows each input's raw value and resolved status.
  // Useful for the abort UI to render a concrete "this is why we stopped" message.
  const details: Record<string, string> = {
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

  if (input.remoteOriginUrl !== undefined) {
    details.remoteOriginUrl = input.remoteOriginUrl
    details.originResolution = origin!
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
  if (input.repoPinSlug === undefined && input.remoteOriginUrl === undefined) {
    return {
      kind: 'requires-typed-slug-confirmation',
      canonicalSlug: backend.workspaceSlug,
      reason:
        'Local directory has no workspace pin and no git origin — cannot cross-check the requested target. Confirm by typing the workspace slug.',
    }
  }

  return {kind: 'ok', canonicalSlug: backend.workspaceSlug}
}
