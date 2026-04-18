/**
 * Returns a valid (non-expired) WorkOS access token, refreshing if needed.
 * Throws if not logged in or if refresh fails.
 */

import {decodeJWT, refreshAccessToken} from './oauth-client.js'
import {loadTokens, saveTokens} from './token-storage.js'

export async function getValidAccessToken(): Promise<string> {
  const tokens = await loadTokens()
  if (!tokens?.accessToken) {
    throw new Error('Not authenticated. Please run `qfg login` first.')
  }

  // Check expiry using the JWT's exp claim, falling back to stored expiresAt
  let expired = tokens.expiresAt ? tokens.expiresAt < Date.now() : false
  try {
    const payload = decodeJWT(tokens.accessToken)
    if (typeof payload.exp === 'number') {
      expired = payload.exp * 1000 < Date.now()
    }
  } catch {
    /* use stored expiresAt */
  }

  if (!expired) {
    return tokens.accessToken
  }

  if (!tokens.refreshToken) {
    throw new Error('Session expired. Please run `qfg login` to re-authenticate.')
  }

  const refreshed = await refreshAccessToken(tokens.refreshToken)

  let expiresAt = Date.now() + 300 * 1000
  try {
    const payload = decodeJWT(refreshed.access_token)
    if (typeof payload.exp === 'number') {
      expiresAt = payload.exp * 1000
    }
  } catch {
    /* use fallback */
  }

  const updated = {
    ...tokens,
    accessToken: refreshed.access_token,
    expiresAt,
    refreshToken: refreshed.refresh_token,
  }
  await saveTokens(updated)

  return refreshed.access_token
}
