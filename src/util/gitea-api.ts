import {getApiUrl} from './domain-urls.js'
import {getValidAccessToken} from './get-valid-token.js'
import {GiteaTokenEntry, saveGiteaToken} from './gitea-token-storage.js'

export interface GiteaTokenResponse {
  token: string
  repoUrl: string
  expiresAt: string | null
}

export const mintGiteaToken = async (
  workspaceId: string,
  scope: 'read' | 'write',
  purpose: 'pull' | 'bootstrap',
): Promise<GiteaTokenResponse> => {
  const accessToken = await getValidAccessToken()

  const apiUrl = getApiUrl()
  const res = await fetch(`${apiUrl}/api/v1/gitea/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
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
    } catch { /* use raw text */ }
    throw new Error(message || text)
  }

  const body = await res.json() as {json?: GiteaTokenResponse} | GiteaTokenResponse
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
  }
  await saveGiteaToken(workspaceId, entry)
  return entry
}
