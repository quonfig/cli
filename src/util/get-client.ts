import type {JsonObj, RequestResult} from '../result.js'

import {APICommand} from '../index.js'
import {Client} from '@quonfig/node'
import {getApiUrl} from '../util/domain-urls.js'
import jsonMaybe from '../util/json-maybe.js'
import {decodeJWT, refreshAccessToken} from '../util/oauth-client.js'
import {getActiveProfile, loadAuthConfig, loadTokens, saveTokens} from '../util/token-storage.js'
import version from '../version.js'

let clientInstance: Client | undefined
let cachedWorkspaceId: string | undefined

export const resetClientCache = () => {
  clientInstance = undefined
  cachedWorkspaceId = undefined
}

const getClient = async (command: APICommand, sdkKey?: string, profile?: string) => {
  // If client exists, still set workspaceId on command if available
  if (clientInstance) {
    if (cachedWorkspaceId) {
      command.workspaceId = cachedWorkspaceId
    }
    return clientInstance
  }

  let jwt: string | undefined
  let workspaceId: string | undefined

  // If no SDK key provided, use WorkOS OAuth tokens
  if (!sdkKey) {
    const authConfig = await loadAuthConfig()
    let tokens = await loadTokens()

    command.verboseLog('OAuth auth', {
      hasAuthConfig: Boolean(authConfig),
      hasAccessToken: Boolean(tokens?.accessToken),
    })

    if (!authConfig || !tokens?.accessToken) {
      command.error('No authentication found. Please run `qfg login`.', {exit: 401})
    }

    // Check if token is expired and refresh if needed.
    // Prefer the JWT's actual exp claim over the stored expiresAt.
    let tokenExpired = tokens.expiresAt ? tokens.expiresAt < Date.now() : false
    try {
      const payload = decodeJWT(tokens.accessToken)
      if (typeof payload.exp === 'number') {
        tokenExpired = payload.exp * 1000 < Date.now()
      }
    } catch {
      // If we can't decode, fall back to stored expiresAt
    }

    if (tokenExpired && tokens.refreshToken) {
      command.verboseLog('Token expired, refreshing...')
      try {
        const refreshed = await refreshAccessToken(tokens.refreshToken)
        // Use the JWT's actual exp claim for expiry, not a hardcoded duration
        let expiresAt = Date.now() + 300 * 1000 // fallback: 5 minutes
        try {
          const payload = decodeJWT(refreshed.access_token)
          if (typeof payload.exp === 'number') {
            expiresAt = payload.exp * 1000 // convert seconds to ms
          }
        } catch {
          // Use fallback
        }
        tokens = {
          ...tokens,
          accessToken: refreshed.access_token,
          expiresAt,
          refreshToken: refreshed.refresh_token,
        }
        await saveTokens(tokens)
        command.verboseLog('Token refreshed successfully')
      } catch (error) {
        command.error('Session expired. Please run `qfg login` to re-authenticate.', {exit: 401})
      }
    }

    // Get the active profile to find the workspace
    const activeProfile = getActiveProfile(profile)
    const profileData =
      authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']

    command.verboseLog('Profile lookup', {
      activeProfile,
      hasProfileData: Boolean(profileData),
      workspaceId: profileData?.workspace,
    })

    if (profileData) {
      workspaceId = profileData.workspace
    }

    // Use the WorkOS access token directly as the JWT
    jwt = tokens.accessToken

    // If still no JWT, user needs to login
    if (!jwt) {
      command.error('No authentication found. Please run `qfg login`.', {exit: 401})
    }
  }

  // Store workspaceId on the command for use in building URLs and cache it
  if (workspaceId) {
    command.workspaceId = workspaceId
    cachedWorkspaceId = workspaceId
  }

  clientInstance = new Client({
    jwt,
    sdkKey,
    apiUrl: getApiUrl(),
    clientIdentifier: `cli-${version}`,
    log: command.verboseLog,
  })

  return clientInstance
}

export const unwrapRequest = async (command: APICommand, promise: Promise<Response>): Promise<RequestResult> => {
  const request = await promise

  if (request.status.toString().startsWith('2')) {
    const json = (await request.json()) as JsonObj
    command.verboseLog('ApiClient', {response: json})

    return {json, ok: true, status: request.status}
  }

  // Handle 403 with a user-friendly message
  if (request.status === 403) {
    return {
      error: {error: 'You do not have permission to perform this action. Please check your workspace permissions.'},
      ok: false,
      status: request.status,
    }
  }

  const error = jsonMaybe(await request.text())

  if (typeof error === 'string') {
    return {error: {error}, ok: false, status: request.status}
  }

  return {error, ok: false, status: request.status}
}

export default getClient
