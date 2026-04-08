import {getApiUrl} from './domain-urls.js'
import {loadTokens} from './token-storage.js'
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
  const tokens = await loadTokens()
  if (!tokens?.accessToken) {
    throw new Error('Not authenticated. Please run `qfg login` first.')
  }

  const apiUrl = getApiUrl()
  const res = await fetch(`${apiUrl}/api/v1/gitea/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({scope, workspaceId, purpose}),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Failed to mint Gitea token (HTTP ${res.status}): ${text}`)
  }

  const data = (await res.json()) as GiteaTokenResponse
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
