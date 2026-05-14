import {getApiUrl} from './domain-urls.js'
import {getValidAccessTokenForOrgSlug} from './get-valid-token.js'
import {GiteaTokenEntry, saveGiteaToken} from './gitea-token-storage.js'

export interface GiteaTokenResponse {
  expiresAt: string | null
  repoUrl: string
  token: string
  /**
   * Canonical workspace UUID for the minted token. Used as the backend
   * identity in the push identity check — required so the CLI can match a
   * `--workspace <UUID>` request against the canonical workspace row without
   * assuming the slug is also the UUID. Backend returns this alongside
   * `workspaceSlug` as of the Guard 1 rollout in `project/plans/cli-git-sync.md`.
   */
  workspaceId: string
  /**
   * Human-readable workspace slug (NOT the UUID). Used to pin `quonfig.json`
   * and for identity-check guard messages. Required as of the Guard 1 rollout
   * in `project/plans/cli-git-sync.md`; the backend always returns it.
   */
  workspaceSlug: string
}

export const mintGiteaToken = async (
  workspaceId: string,
  orgSlug: string,
  scope: 'read' | 'write',
  purpose: 'pull' | 'bootstrap' | 'push',
): Promise<GiteaTokenResponse> => {
  const accessToken = await getValidAccessTokenForOrgSlug(orgSlug)

  const apiUrl = getApiUrl()
  const url = `${apiUrl}/api/v1/gitea/token`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({json: {scope, workspaceId, purpose}}),
  })

  // Read once as text so we can give a useful error when the response body
  // isn't JSON (e.g. an auth-redirect HTML page or a 404 from a mis-routed
  // request). qfg-3uks Item C: previously the user saw a bare
  // `SyntaxError: Unexpected token '<'...` with no URL or status.
  const text = await res.text().catch(() => '')

  if (!res.ok) {
    let message: string | undefined
    try {
      const body = JSON.parse(text)
      // oRPC error shape
      if (body?.json?.message) message = body.json.message
      else if (body?.message) message = body.message
    } catch {
      /* fall through — use a non-JSON error message instead */
    }

    if (!message) {
      throw new Error(buildNonJsonResponseError(url, res.status, text))
    }

    throw new Error(`${message} (HTTP ${res.status} from ${url})`)
  }

  let body: {json?: GiteaTokenResponse} | GiteaTokenResponse
  try {
    body = JSON.parse(text) as {json?: GiteaTokenResponse} | GiteaTokenResponse
  } catch {
    throw new Error(buildNonJsonResponseError(url, res.status, text))
  }

  const data = (body as {json?: GiteaTokenResponse}).json ?? (body as GiteaTokenResponse)
  return data
}

const SNIPPET_LIMIT = 120

/**
 * Build the error thrown when a mint response body is not JSON. Includes the
 * URL, the HTTP status, and a short body snippet so callers can tell at a
 * glance whether the server returned an HTML login page, a 404, or 5xx
 * boilerplate.
 */
const buildNonJsonResponseError = (url: string, status: number, body: string): string => {
  const trimmed = body.trim()
  if (trimmed.length === 0) {
    return `Expected JSON from ${url} but got HTTP ${status} with an empty body — not valid JSON.`
  }

  const snippet = trimmed.length > SNIPPET_LIMIT ? `${trimmed.slice(0, SNIPPET_LIMIT)}…` : trimmed
  return `Expected JSON from ${url} but got HTTP ${status} with non-JSON body (not valid JSON): ${snippet}`
}

/**
 * Mint a Gitea read token, store it, and return the entry.
 */
export const mintAndStoreGiteaReadToken = async (workspaceId: string, orgSlug: string): Promise<GiteaTokenEntry> => {
  const data = await mintGiteaToken(workspaceId, orgSlug, 'read', 'pull')
  const entry: GiteaTokenEntry = {
    token: data.token,
    repoUrl: data.repoUrl,
    expiresAt: data.expiresAt,
    workspaceSlug: data.workspaceSlug,
  }
  await saveGiteaToken(workspaceId, entry)
  return entry
}
