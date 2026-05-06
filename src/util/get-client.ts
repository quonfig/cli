import type {JsonObj, RequestResult} from '../result.js'

import {APICommand} from '../index.js'
import {Client} from '@quonfig/node'
import {getApiUrl} from '../util/domain-urls.js'
import jsonMaybe from '../util/json-maybe.js'
import {tryParseWorkspacePin} from '../util/quonfig-json.js'
import {findOrgIdBySlug, getActiveProfile, loadAuthConfig, loadTokens} from '../util/token-storage.js'
import {getValidAccessToken, getValidAccessTokenForOrgSlug} from '../util/get-valid-token.js'
import version from '../version.js'

const BARE_SLUG_ENV_MIGRATION_MESSAGE =
  'QUONFIG_WORKSPACE must be in org/workspace form (e.g. acme/foo). ' +
  'Bare workspace slugs are no longer accepted. Update your .env and run `qfg login` if you have not yet migrated.'

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
    // when QUONFIG_API_KEY is set, so this never touches disk and orgId is ignored.
    try {
      jwt = await getValidAccessToken('', command.verboseLog)
    } catch (error) {
      command.error(error instanceof Error ? error.message : String(error), {exit: 1})
    }

    const workspaceOverride = profile ?? process.env.QUONFIG_WORKSPACE
    if (!workspaceOverride) {
      command.error(
        'QUONFIG_API_KEY is set but QUONFIG_WORKSPACE is not. Set QUONFIG_WORKSPACE=<workspace-slug> (UUIDs also work).',
        {exit: 1},
      )
    }

    const uuidPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
    if (uuidPattern.test(workspaceOverride)) {
      workspaceId = workspaceOverride
      command.verboseLog('ApiKey auth', {source: 'uuid', workspaceId})
    } else {
      // Slug — resolve via the server since there's no local auth config in CI mode.
      type WorkspaceEntry = {workspaceId: string; workspaceSlug: string}
      let res: Response
      try {
        res = await fetch(`${getApiUrl()}/api/v1/userWorkspaces/list`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({json: {}}),
        })
      } catch (error) {
        command.error(
          `Failed to resolve workspace slug "${workspaceOverride}": ${error instanceof Error ? error.message : String(error)}`,
          {exit: 1},
        )
      }

      if (!res.ok) {
        command.error(
          `Failed to resolve workspace slug "${workspaceOverride}" (HTTP ${res.status}). Check that QUONFIG_API_KEY is valid.`,
          {exit: 1},
        )
      }

      const body = (await res.json()) as {json?: WorkspaceEntry[]}
      const entries = body.json ?? (body as unknown as WorkspaceEntry[]) ?? []
      const match = entries.find((w) => w.workspaceSlug === workspaceOverride)
      if (!match) {
        const available = entries.map((w) => w.workspaceSlug).join(', ') || '(none)'
        command.error(
          `No workspace with slug "${workspaceOverride}" is accessible with this API key. Available: ${available}.`,
          {exit: 1},
        )
      }

      workspaceId = match.workspaceId
      command.verboseLog('ApiKey auth', {source: 'slug', slug: workspaceOverride, workspaceId})
    }
  } else {
    // OAuth path: --workspace/QUONFIG_WORKSPACE must be in `org/ws` form so we
    // can mint the org-scoped JWT for the right org and resolve the workspace
    // slug *within that org*. No override → use the saved default profile.
    const workspaceSlugOverride = profile ?? process.env.QUONFIG_WORKSPACE
    const profileNameOverride = process.env.QUONFIG_PROFILE

    const store = await loadTokens()
    if (!store || Object.keys(store.tokensByOrg).length === 0) {
      command.error('No authentication found. Please run `qfg login`.', {exit: 401})
    }

    if (workspaceSlugOverride) {
      const pin = tryParseWorkspacePin(workspaceSlugOverride)
      if (!pin) {
        command.error(BARE_SLUG_ENV_MIGRATION_MESSAGE, {exit: 1})
      }

      const {orgSlug, workspaceSlug} = pin
      const orgId = findOrgIdBySlug(store, orgSlug)
      if (!orgId) {
        command.error(`No token found for org \`${orgSlug}\`. Run \`qfg login\` to add this org.`, {exit: 401})
      }

      try {
        jwt = await getValidAccessToken(orgId, command.verboseLog)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        command.error(`Session expired for org ${orgSlug}: ${detail}. Run \`qfg login\` to re-authenticate.`, {
          exit: 401,
        })
      }

      type WorkspaceEntry = {
        organizationName?: string
        workosOrgId?: string
        workspaceId: string
        workspaceSlug: string
      }
      let res: Response
      try {
        res = await fetch(`${getApiUrl()}/api/v1/userWorkspaces/list`, {
          method: 'POST',
          headers: {Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json'},
          body: JSON.stringify({json: {}}),
        })
      } catch (error) {
        command.error(
          `Failed to resolve workspace "${workspaceSlugOverride}": ${error instanceof Error ? error.message : String(error)}`,
          {exit: 1},
        )
      }

      if (!res.ok) {
        command.error(`Failed to resolve workspace "${workspaceSlugOverride}" (HTTP ${res.status}).`, {exit: 1})
      }

      const body = (await res.json()) as {json?: WorkspaceEntry[]}
      const entries = (body.json ?? body) as unknown as WorkspaceEntry[]
      const candidates = Array.isArray(entries) ? entries : []
      const match = candidates.find((w) => w.workosOrgId === orgId && w.workspaceSlug === workspaceSlug)
      if (!match) {
        const inOrg = candidates.filter((w) => w.workosOrgId === orgId).map((w) => w.workspaceSlug)
        const available = inOrg.length > 0 ? inOrg.join(', ') : '(none)'
        command.error(`Workspace "${workspaceSlug}" not found in org "${orgSlug}". Available: ${available}.`, {exit: 1})
      }

      workspaceId = match.workspaceId
      command.verboseLog('Workspace lookup', {source: 'org/ws', orgSlug, workspaceSlug, orgId, workspaceId})
    } else {
      const authConfig = await loadAuthConfig()
      if (!authConfig) {
        command.error('No authentication found. Please run `qfg login`.', {exit: 401})
      }

      command.verboseLog('OAuth auth', {hasAuthConfig: true})

      const activeProfile = getActiveProfile(profileNameOverride)
      const profileData =
        authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']

      command.verboseLog('Workspace lookup', {
        source: 'default-profile',
        activeProfile,
        hasProfileData: Boolean(profileData),
        workspaceId: profileData?.workspace,
      })

      if (!profileData?.organizationSlug) {
        command.error(
          'Saved profile is missing organization_slug. Run `qfg login` to refresh, or `qfg workspace switch <org>/<ws>`.',
          {exit: 1},
        )
      }

      try {
        jwt = await getValidAccessTokenForOrgSlug(profileData.organizationSlug, command.verboseLog)
        command.verboseLog('Token valid (or refreshed)')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        command.error(`Session expired. Please run \`qfg login\` to re-authenticate. (${detail})`, {exit: 401})
      }

      workspaceId = profileData.workspace
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
