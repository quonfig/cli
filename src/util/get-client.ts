import type {JsonObj, RequestResult} from '../result.js'

import {APICommand} from '../index.js'
import {Client} from '@quonfig/node'
import {getApiUrl} from '../util/domain-urls.js'
import jsonMaybe from '../util/json-maybe.js'
import {getActiveProfile, loadAuthConfig, loadTokens, resolveWorkspaceId} from '../util/token-storage.js'
import {getValidAccessToken} from '../util/get-valid-token.js'
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

  const apiKey = process.env.QUONFIG_API_KEY

  // Auth precedence: explicit SDK key → QUONFIG_API_KEY env (CI) → WorkOS OAuth tokens.
  if (sdkKey) {
    // No jwt / workspace resolution — SDK-key path talks to api-delivery.
  } else if (apiKey && apiKey.length > 0) {
    // API-key (workspace-scoped bearer) path. getValidAccessToken short-circuits
    // when QUONFIG_API_KEY is set, so this never touches disk.
    try {
      jwt = await getValidAccessToken()
    } catch (error) {
      command.error(error instanceof Error ? error.message : String(error), {exit: 1})
    }

    const workspaceOverride = profile ?? process.env.QUONFIG_WORKSPACE
    if (!workspaceOverride) {
      command.error(
        'QUONFIG_API_KEY is set but no workspace was specified. Set QUONFIG_WORKSPACE=<uuid> or pass --workspace=<uuid>.',
        {exit: 1},
      )
    }

    const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
    if (!uuidPattern.test(workspaceOverride)) {
      command.error(
        `In API-key mode, --workspace / QUONFIG_WORKSPACE must be a UUID (got "${workspaceOverride}"). Slug resolution requires running \`qfg login\` first.`,
        {exit: 1},
      )
    }

    workspaceId = workspaceOverride
    command.verboseLog('ApiKey auth', {workspaceId})
  } else {
    const authConfig = await loadAuthConfig()
    const tokens = await loadTokens()

    command.verboseLog('OAuth auth', {
      hasAuthConfig: Boolean(authConfig),
      hasAccessToken: Boolean(tokens?.accessToken),
    })

    if (!authConfig || !tokens?.accessToken) {
      command.error('No authentication found. Please run `qfg login`.', {exit: 401})
    }

    command.verboseLog('Checking token validity...')
    try {
      jwt = await getValidAccessToken()
      command.verboseLog('Token valid (or refreshed)')
    } catch {
      command.error('Session expired. Please run `qfg login` to re-authenticate.', {exit: 401})
    }

    // Resolve workspace: --workspace/QUONFIG_WORKSPACE (slug) → QUONFIG_PROFILE (profile name) → default
    const workspaceSlugOverride = profile ?? process.env.QUONFIG_WORKSPACE
    const profileNameOverride = process.env.QUONFIG_PROFILE

    if (workspaceSlugOverride) {
      // Try slug resolution first, then fall back to treating it as a profile name
      const resolved = resolveWorkspaceId(authConfig, workspaceSlugOverride)
      if (resolved) {
        workspaceId = resolved
        command.verboseLog('Workspace lookup', {source: 'slug', slug: workspaceSlugOverride, workspaceId})
      } else {
        const profileData = authConfig.profiles[workspaceSlugOverride]
        if (profileData) {
          workspaceId = profileData.workspace
          command.verboseLog('Workspace lookup', {source: 'profile-name', profile: workspaceSlugOverride, workspaceId})
        } else {
          command.error(
            `Workspace '${workspaceSlugOverride}' not found. Run \`qfg workspace switch\` to select and save a workspace.`,
            {exit: 1},
          )
        }
      }
    } else {
      const activeProfile = getActiveProfile(profileNameOverride)
      const profileData =
        authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']

      command.verboseLog('Workspace lookup', {
        source: 'default-profile',
        activeProfile,
        hasProfileData: Boolean(profileData),
        workspaceId: profileData?.workspace,
      })

      if (profileData) {
        workspaceId = profileData.workspace
      }
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
