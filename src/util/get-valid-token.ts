/**
 * Returns a valid (non-expired) WorkOS access token, refreshing if needed.
 * Throws if not logged in or if refresh fails.
 *
 * If `QUONFIG_API_KEY` is set in the environment (non-empty), it is used
 * directly as a bearer token and no disk reads/writes or refresh calls
 * are made. This is the non-interactive (CI) path.
 */

import {getDomain} from './domain-urls.js'
import {decodeJWT, refreshAccessToken} from './oauth-client.js'
import {loadTokens, saveTokens} from './token-storage.js'

type Logger = (msg: string, data?: unknown) => void
const noopLog: Logger = () => {}

export async function getValidAccessToken(log: Logger = noopLog): Promise<string> {
  const envKey = process.env.QUONFIG_API_KEY
  if (envKey && envKey.length > 0) {
    if (!envKey.startsWith('qf_uk_')) {
      throw new Error(
        `QUONFIG_API_KEY must start with "qf_uk_" (got "${envKey.slice(0, 8)}..."). Generate one from the web UI under Settings → API Keys.`,
      )
    }

    log('getValidAccessToken: using QUONFIG_API_KEY (CI path)')
    return envKey
  }

  // TODO(qfg-kr7.6): take a workosOrgId argument and pick the matching token entry.
  // For now, use the defaultOrgId (or the first available org) as a stopgap.
  const store = await loadTokens()
  const orgId = store?.defaultOrgId ?? (store ? Object.keys(store.tokensByOrg)[0] : undefined)
  const tokens = store && orgId ? store.tokensByOrg[orgId] : undefined
  log('getValidAccessToken: loaded tokens', {
    domain: getDomain(),
    hasAccessToken: Boolean(tokens?.access_token),
    hasRefreshToken: Boolean(tokens?.refresh_token),
    expiresAt: tokens?.expires_at,
  })
  if (!tokens?.access_token || !store || !orgId) {
    throw new Error('Not authenticated. Please run `qfg login` first.')
  }

  // Check expiry using the JWT's exp claim, falling back to stored expires_at
  let expired = tokens.expires_at ? tokens.expires_at < Date.now() : false
  let expirySource: 'stored' | 'jwt' = 'stored'
  try {
    const payload = decodeJWT(tokens.access_token)
    if (typeof payload.exp === 'number') {
      expired = payload.exp * 1000 < Date.now()
      expirySource = 'jwt'
    }
  } catch {
    /* use stored expires_at */
  }

  log('getValidAccessToken: expiry check', {expired, expirySource, now: Date.now()})

  if (!expired) {
    return tokens.access_token
  }

  if (!tokens.refresh_token) {
    throw new Error('Session expired (no refresh_token on disk). Please run `qfg login` to re-authenticate.')
  }

  log('getValidAccessToken: access token expired, calling WorkOS refresh')
  let refreshed
  try {
    refreshed = await refreshAccessToken(tokens.refresh_token)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log('getValidAccessToken: refresh FAILED', {detail})
    throw new Error(`Token refresh failed: ${detail}`)
  }

  log('getValidAccessToken: refresh succeeded', {
    gotNewRefreshToken: Boolean(refreshed.refresh_token),
  })

  let expiresAt = Date.now() + 300 * 1000
  try {
    const payload = decodeJWT(refreshed.access_token)
    if (typeof payload.exp === 'number') {
      expiresAt = payload.exp * 1000
    }
  } catch {
    /* use fallback */
  }

  store.tokensByOrg[orgId] = {
    ...tokens,
    access_token: refreshed.access_token,
    expires_at: expiresAt,
    refresh_token: refreshed.refresh_token,
  }
  await saveTokens(store)
  log('getValidAccessToken: refreshed tokens saved', {newExpiresAt: expiresAt})

  return refreshed.access_token
}
