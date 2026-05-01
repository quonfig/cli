import type {BaseCommand} from '../index.js'

import {getApiUrl} from './domain-urls.js'
import {getValidAccessToken, resolveDefaultOrgId} from './get-valid-token.js'
import {tryParseWorkspacePin} from './quonfig-json.js'
import {
  type AuthConfig,
  findOrgIdBySlug,
  getActiveProfile,
  loadAuthConfig,
  loadTokens,
  saveAuthConfig,
} from './token-storage.js'

const UUID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

const BARE_SLUG_ENV_MIGRATION_MESSAGE =
  'QUONFIG_WORKSPACE must be in org/workspace form (e.g. acme/foo). ' +
  'Bare workspace slugs are no longer accepted. Update your .env and run `qfg login` if you have not yet migrated.'

/**
 * Resolve the target workspace UUID for commands that don't extend APICommand
 * (e.g. pull, push — which talk to Gitea, not the oRPC API, but still need to
 * know which workspace to mint a Gitea token for).
 *
 * Handles all three auth paths in the same order as util/get-client.ts:
 *   1. QUONFIG_API_KEY + QUONFIG_WORKSPACE (or --workspace flag) — CI/headless.
 *   2. OAuth profile — the default interactive path.
 *
 * Mirrors the error messages from get-client.ts so behavior feels identical
 * whether you're hitting the API directly or going through Gitea.
 */
export async function resolveWorkspaceUuid(command: BaseCommand, flagOverride?: string): Promise<string> {
  const override = flagOverride ?? process.env.QUONFIG_WORKSPACE
  const apiKey = process.env.QUONFIG_API_KEY

  if (apiKey && apiKey.length > 0) {
    if (!override) {
      command.error(
        'QUONFIG_API_KEY is set but QUONFIG_WORKSPACE is not. Set QUONFIG_WORKSPACE=<workspace-slug> or pass --workspace=<slug>. (UUIDs also work.)',
        {exit: 1},
      )
    }

    if (UUID_PATTERN.test(override)) {
      command.verboseLog('ApiKey auth', {source: 'uuid', workspaceId: override})
      return override
    }

    // Slug — resolve via the server since there's no local auth config in CI mode.
    // API-key path short-circuits before consulting the orgId.
    const jwt = await getValidAccessToken('', command.verboseLog)
    let res: Response
    try {
      res = await fetch(`${getApiUrl()}/api/v1/userWorkspaces/list`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({json: {}}),
      })
    } catch (error) {
      command.error(
        `Failed to resolve workspace slug "${override}": ${error instanceof Error ? error.message : String(error)}`,
        {exit: 1},
      )
    }

    if (!res.ok) {
      command.error(
        `Failed to resolve workspace slug "${override}" (HTTP ${res.status}). Check that QUONFIG_API_KEY is valid.`,
        {exit: 1},
      )
    }

    type WorkspaceEntry = {workspaceId: string; workspaceSlug: string}
    const body = (await res.json()) as {json?: WorkspaceEntry[]}
    const entries = body.json ?? (body as unknown as WorkspaceEntry[]) ?? []
    const match = entries.find((w) => w.workspaceSlug === override)
    if (!match) {
      const available = entries.map((w) => w.workspaceSlug).join(', ') || '(none)'
      command.error(`No workspace with slug "${override}" is accessible with this API key. Available: ${available}.`, {
        exit: 1,
      })
    }

    command.verboseLog('ApiKey auth', {source: 'slug', slug: override, workspaceId: match.workspaceId})
    return match.workspaceId
  }

  // OAuth path with an explicit override → must be in org/ws form. Parse,
  // look up the workosOrgId for that org slug in the local token store, and
  // resolve the workspaceSlug *within that org*. Bare slug is rejected with
  // a migration message (the API-key branch above is the one exception).
  if (override) {
    return resolveOrgScopedWorkspace(command, override)
  }

  // No override → fall back to the saved default profile, recovering the
  // auth config from tokens if the config file is absent.
  let authConfig = await loadAuthConfig()
  if (!authConfig) {
    // Auth config can be missing while tokens.json still holds a valid
    // refresh_token — e.g. after the domain-scoped config split (commit
    // 0f8bee6) or a partial login that wrote tokens but never the config
    // (qfg-2qj). getValidAccessToken already knows how to refresh, so try
    // that path before declaring "Not logged in".
    const store = await loadTokens()
    const tokens = store ? Object.values(store.tokensByOrg)[0] : undefined
    if (!tokens?.refresh_token) {
      command.error('Not logged in. Run `qfg login` first (or set QUONFIG_API_KEY for CI).', {exit: 401})
    }

    authConfig = await recoverAuthConfigFromTokens(command)
  }

  const activeProfile = getActiveProfile()
  const profileData = authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']
  if (!profileData?.workspace) {
    command.error(
      'No active workspace. Run `qfg login` / `qfg workspace switch`, or set QUONFIG_API_KEY + QUONFIG_WORKSPACE.',
      {exit: 1},
    )
  }

  return profileData.workspace
}

/**
 * OAuth-mode resolver for an explicit `<org-slug>/<workspace-slug>` override.
 *
 * 1. Parse the override; bare slug → migration error.
 * 2. Look up workosOrgId via the token store's org_slug index. If the user
 *    hasn't logged in to that org, error with `qfg login` instructions.
 * 3. Mint/refresh an org-scoped JWT for that org, call /userWorkspaces/list,
 *    and pick the entry whose (workosOrgId, workspaceSlug) matches.
 */
async function resolveOrgScopedWorkspace(command: BaseCommand, override: string): Promise<string> {
  const pin = tryParseWorkspacePin(override)
  if (!pin) {
    command.error(BARE_SLUG_ENV_MIGRATION_MESSAGE, {exit: 1})
  }

  const {orgSlug, workspaceSlug} = pin
  const store = await loadTokens()
  if (!store) {
    command.error('Not logged in. Run `qfg login` first (or set QUONFIG_API_KEY for CI).', {exit: 401})
  }

  const workosOrgId = findOrgIdBySlug(store, orgSlug)
  if (!workosOrgId) {
    command.error(`No token found for org \`${orgSlug}\`. Run \`qfg login\` to add this org.`, {exit: 401})
  }

  let jwt: string
  try {
    jwt = await getValidAccessToken(workosOrgId, command.verboseLog)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    command.error(`Session expired for org ${orgSlug}: ${detail}. Run \`qfg login\` to re-authenticate.`, {exit: 401})
  }

  type WorkspaceEntry = {organizationName?: string; workosOrgId?: string; workspaceId: string; workspaceSlug: string}

  let res: Response
  try {
    res = await fetch(`${getApiUrl()}/api/v1/userWorkspaces/list`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({json: {}}),
    })
  } catch (error) {
    command.error(
      `Failed to resolve workspace "${override}": ${error instanceof Error ? error.message : String(error)}`,
      {exit: 1},
    )
  }

  if (!res.ok) {
    command.error(`Failed to resolve workspace "${override}" (HTTP ${res.status}).`, {exit: 1})
  }

  const body = (await res.json()) as {json?: WorkspaceEntry[]}
  const entries = (body.json ?? body) as unknown as WorkspaceEntry[]
  const candidates = Array.isArray(entries) ? entries : []
  const match = candidates.find((w) => w.workosOrgId === workosOrgId && w.workspaceSlug === workspaceSlug)
  if (!match) {
    const inOrg = candidates.filter((w) => w.workosOrgId === workosOrgId).map((w) => w.workspaceSlug)
    const available = inOrg.length > 0 ? inOrg.join(', ') : '(none)'
    command.error(
      `Workspace "${workspaceSlug}" not found in org "${orgSlug}". Available: ${available}.`,
      {exit: 1},
    )
  }

  command.verboseLog('OAuth workspace lookup', {orgSlug, workspaceSlug, workosOrgId, workspaceId: match.workspaceId})
  return match.workspaceId
}

/**
 * Best-effort rebuild of the on-disk auth config from a working refresh_token.
 * Calls /api/v1/userWorkspaces/list to discover the user's workspaces, persists
 * the first one as the default profile, and returns the recovered config.
 *
 * Bails to command.error on any failure (refresh, network, no workspaces) with
 * a message that points the user at `qfg login`.
 */
async function recoverAuthConfigFromTokens(command: BaseCommand): Promise<AuthConfig> {
  let jwt: string
  try {
    // TODO(qfg-kr7.5): pick the orgId resolved from the workspace address.
    const orgId = await resolveDefaultOrgId()
    jwt = await getValidAccessToken(orgId, command.verboseLog)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    command.error(`Tokens found but refresh failed: ${detail}. Run \`qfg login\` to repopulate.`, {exit: 401})
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
      `Tokens found but failed to fetch workspaces: ${error instanceof Error ? error.message : String(error)}. Run \`qfg login\` to repopulate.`,
      {exit: 401},
    )
  }

  if (!res.ok) {
    command.error(`Tokens found but workspace list returned HTTP ${res.status}. Run \`qfg login\` to repopulate.`, {
      exit: 401,
    })
  }

  const body = (await res.json()) as {json?: WorkspaceEntry[]}
  const entries = (body.json ?? body) as unknown as WorkspaceEntry[]
  const candidates = Array.isArray(entries) ? entries : []
  if (candidates.length === 0) {
    command.error('Tokens found but no workspace profile on disk. Run `qfg login` to repopulate.', {exit: 401})
  }

  const match = candidates[0]
  const recovered: AuthConfig = {
    defaultProfile: 'default',
    profiles: {
      default: {
        workspace: match.workspaceId,
        workspaceName: match.workspaceSlug,
        workspaceSlug: match.workspaceSlug,
        organizationName: match.organizationName,
      },
    },
  }

  await saveAuthConfig(recovered)
  command.verboseLog('resolve-workspace: recovered auth config from tokens', {
    workspaceId: match.workspaceId,
    workspaceSlug: match.workspaceSlug,
    candidateCount: candidates.length,
  })
  return recovered
}
