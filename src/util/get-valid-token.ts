/**
 * Returns a valid (non-expired) WorkOS access token for the given org,
 * refreshing if needed. Throws if no token for that org is on disk or if
 * refresh fails.
 *
 * If `QUONFIG_API_KEY` is set in the environment (non-empty), it is used
 * directly as a bearer token and no disk reads/writes or refresh calls
 * are made. This is the non-interactive (CI) path; `workosOrgId` is
 * ignored because API keys are workspace-scoped.
 */

import {authenticateWithOrg, decodeJWT} from './oauth-client.js'
import {getTokenForOrg, loadTokens, saveTokens} from './token-storage.js'

type Logger = (msg: string, data?: unknown) => void
const noopLog: Logger = () => {}

/**
 * Transitional helper: pick a default workosOrgId from the token store.
 * Returns '' if no store exists (fine for the QUONFIG_API_KEY short-circuit
 * path, which ignores the orgId argument).
 *
 * TODO(qfg-kr7.5/7/8/9): callers should pass through the workosOrgId resolved
 * from the workspace address (org-slug/workspace-slug parsing). This helper
 * is the stopgap until each caller's resolution lands in its own bead.
 */
export async function resolveDefaultOrgId(): Promise<string> {
  const store = await loadTokens()
  if (!store) return ''
  if (store.defaultOrgId && store.tokensByOrg[store.defaultOrgId]) return store.defaultOrgId
  return Object.keys(store.tokensByOrg)[0] ?? ''
}

export async function getValidAccessToken(workosOrgId: string, log: Logger = noopLog): Promise<string> {
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

  const store = await loadTokens()
  const tokens = store ? getTokenForOrg(store, workosOrgId) : undefined
  log('getValidAccessToken: loaded tokens', {
    workosOrgId,
    hasStore: Boolean(store),
    hasAccessToken: Boolean(tokens?.access_token),
    hasRefreshToken: Boolean(tokens?.refresh_token),
    expiresAt: tokens?.expires_at,
  })
  if (!store || !tokens?.access_token) {
    throw new Error(`No token for org ${workosOrgId}. Run \`qfg login\` to mint one.`)
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

  log('getValidAccessToken: expiry check', {workosOrgId, expired, expirySource, now: Date.now()})

  if (!expired) {
    return tokens.access_token
  }

  if (!tokens.refresh_token) {
    throw new Error(
      `Session expired for org ${workosOrgId} (no refresh_token on disk). Run \`qfg login\` to re-authenticate.`,
    )
  }

  log('getValidAccessToken: access token expired, calling WorkOS refresh', {workosOrgId})
  let refreshed
  try {
    // authenticateWithOrg passes organization_id so the new access token is
    // org-scoped and carries the user's permissions[] for that org. Refreshing
    // without organization_id would mint a user-scoped token (the qfg-kr7
    // root cause) that fails every write path.
    refreshed = await authenticateWithOrg(tokens.refresh_token, workosOrgId)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log('getValidAccessToken: refresh FAILED', {workosOrgId, detail})
    throw new Error(`Token refresh failed for org ${workosOrgId}: ${detail}`)
  }

  log('getValidAccessToken: refresh succeeded', {
    workosOrgId,
    gotNewRefreshToken: Boolean(refreshed.refresh_token),
  })

  store.tokensByOrg[workosOrgId] = {
    ...tokens,
    access_token: refreshed.access_token,
    expires_at: refreshed.expires_at,
    refresh_token: refreshed.refresh_token,
    user_email: refreshed.user_email ?? tokens.user_email,
    user_id: refreshed.user_id ?? tokens.user_id,
  }
  await saveTokens(store)
  log('getValidAccessToken: refreshed tokens saved', {workosOrgId, newExpiresAt: refreshed.expires_at})

  return refreshed.access_token
}
