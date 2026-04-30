import {getDomain} from './domain-urls.js'
import type {TokenSet} from './token-storage.js'

const WORKOS_BASE_URL = 'https://api.workos.com'

// WorkOS Client IDs for the CLI (public client — no secret needed)
const WORKOS_CLIENT_ID_PRODUCTION = 'client_01KKCCWMNB2K8HYQZQ96G1MXE0'
const WORKOS_CLIENT_ID_STAGING = 'client_01KKCCWM4K87JS0MKS8PHZ0ZY1'

const getClientId = (): string => {
  if (process.env.CLI_WORKOS_CLIENT_ID) {
    return process.env.CLI_WORKOS_CLIENT_ID
  }

  const domain = getDomain()
  if (domain === 'quonfig-staging.com') {
    return WORKOS_CLIENT_ID_STAGING
  }

  return WORKOS_CLIENT_ID_PRODUCTION
}

// --- Device Code Flow Types ---

export interface DeviceCodeResponse {
  device_code: string
  expires_in: number
  interval: number
  user_code: string
  verification_uri: string
  verification_uri_complete: string
}

export interface WorkOSUser {
  email: string
  email_verified: boolean
  first_name: string | null
  id: string
  last_name: string | null
  organization_id?: string
}

export interface DeviceTokenResponse {
  access_token: string
  authentication_method: string
  refresh_token: string
  user: WorkOSUser
}

export interface TokenRefreshResponse {
  access_token: string
  refresh_token: string
}

// --- Device Code Flow ---

export const requestDeviceCode = async (): Promise<DeviceCodeResponse> => {
  const response = await fetch(`${WORKOS_BASE_URL}/user_management/authorize/device`, {
    body: new URLSearchParams({
      client_id: getClientId(),
    }),
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    method: 'POST',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to request device code: ${errorText}`)
  }

  return response.json()
}

export const pollForToken = async (
  deviceCode: string,
  interval: number,
  expiresIn: number,
  verbose?: boolean,
): Promise<DeviceTokenResponse> => {
  const deadline = Date.now() + expiresIn * 1000
  let pollInterval = interval * 1000

  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, pollInterval)
    })

    if (verbose) {
      console.error('[pollForToken] Polling for device authorization...')
    }

    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(`${WORKOS_BASE_URL}/user_management/authenticate`, {
      body: new URLSearchParams({
        client_id: getClientId(),
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      method: 'POST',
    })

    if (response.ok) {
      return response.json()
    }

    // eslint-disable-next-line no-await-in-loop
    const error = (await response.json().catch(() => ({}))) as Record<string, string>
    const errorCode = error.error || error.code

    if (errorCode === 'authorization_pending') {
      continue
    }

    if (errorCode === 'slow_down') {
      pollInterval += 1000
      continue
    }

    if (errorCode === 'access_denied') {
      throw new Error('Authorization was denied by the user.')
    }

    if (errorCode === 'expired_token') {
      throw new Error('Device code expired. Please try logging in again.')
    }

    throw new Error(`Authentication failed: ${JSON.stringify(error)}`)
  }

  throw new Error('Device code expired. Please try logging in again.')
}

// --- Token Refresh ---

export const refreshAccessToken = async (refreshToken: string): Promise<TokenRefreshResponse> => {
  const response = await fetch(`${WORKOS_BASE_URL}/user_management/authenticate`, {
    body: new URLSearchParams({
      client_id: getClientId(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    method: 'POST',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to refresh token: ${errorText}`)
  }

  return response.json()
}

// --- Org-Scoped Authentication ---

// WorkOS access tokens are org-scoped: there is no single token that authorizes
// work across two orgs. Exchange a refresh_token for a per-org TokenSet so the
// CLI can hold one token per organization the user belongs to.
export const authenticateWithOrg = async (refreshToken: string, organizationId: string): Promise<TokenSet> => {
  const response = await fetch(`${WORKOS_BASE_URL}/user_management/authenticate`, {
    body: new URLSearchParams({
      client_id: getClientId(),
      grant_type: 'refresh_token',
      organization_id: organizationId,
      refresh_token: refreshToken,
    }),
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    method: 'POST',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to authenticate with org ${organizationId}: ${errorText}`)
  }

  const data = (await response.json()) as {
    access_token: string
    refresh_token: string
    user?: {email?: string; id?: string}
  }

  const payload = decodeJWT(data.access_token)
  const expiresAt = typeof payload.exp === 'number' ? (payload.exp as number) * 1000 : Date.now() + 300 * 1000

  return {
    access_token: data.access_token,
    expires_at: expiresAt,
    refresh_token: data.refresh_token,
    user_email: data.user?.email,
    user_id: data.user?.id,
  }
}

// --- JWT Utilities ---

export const decodeJWT = (token: string): Record<string, unknown> => {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format')
  }

  return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
}
