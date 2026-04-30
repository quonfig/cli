import {getApiUrl} from './domain-urls.js'
import {getValidAccessToken, resolveDefaultOrgId} from './get-valid-token.js'
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
  scope: 'read' | 'write',
  purpose: 'pull' | 'bootstrap' | 'push',
): Promise<GiteaTokenResponse> => {
  // TODO(qfg-kr7.5): thread workosOrgId through from the resolved workspace address.
  const orgId = await resolveDefaultOrgId()
  const accessToken = await getValidAccessToken(orgId)

  const apiUrl = getApiUrl()
  const res = await fetch(`${apiUrl}/api/v1/gitea/token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({json: {scope, workspaceId, purpose}}),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let message = `HTTP ${res.status}`
    try {
      const body = JSON.parse(text)
      // oRPC error shape
      if (body?.json?.message) message = body.json.message
      else if (body?.message) message = body.message
    } catch {
      /* use raw text */
    }
    throw new Error(message || text)
  }

  const body = (await res.json()) as {json?: GiteaTokenResponse} | GiteaTokenResponse
  const data = (body as {json?: GiteaTokenResponse}).json ?? (body as GiteaTokenResponse)
  return data
}

/**
 * Mint a Gitea read token, store it, and return the entry.
 */
export const mintAndStoreGiteaReadToken = async (workspaceId: string): Promise<GiteaTokenEntry> => {
  const data = await mintGiteaToken(workspaceId, 'read', 'pull')
  const entry: GiteaTokenEntry = {
    token: data.token,
    repoUrl: data.repoUrl,
    expiresAt: data.expiresAt,
    workspaceSlug: data.workspaceSlug,
  }
  await saveGiteaToken(workspaceId, entry)
  return entry
}
