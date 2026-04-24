import type {BaseCommand} from '../index.js'

import {getApiUrl} from './domain-urls.js'
import {getValidAccessToken} from './get-valid-token.js'
import {
  getActiveProfile,
  loadAuthConfig,
  resolveWorkspaceId as resolveOAuthWorkspaceId,
} from './token-storage.js'

const UUID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

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
    const jwt = await getValidAccessToken(command.verboseLog)
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
      command.error(
        `No workspace with slug "${override}" is accessible with this API key. Available: ${available}.`,
        {exit: 1},
      )
    }

    command.verboseLog('ApiKey auth', {source: 'slug', slug: override, workspaceId: match.workspaceId})
    return match.workspaceId
  }

  // OAuth path.
  const authConfig = await loadAuthConfig()
  if (!authConfig) {
    command.error('Not logged in. Run `qfg login` first (or set QUONFIG_API_KEY for CI).', {exit: 401})
  }

  if (override) {
    const resolved = resolveOAuthWorkspaceId(authConfig, override)
    if (resolved) return resolved

    // Fall back to treating the override as a profile name.
    const profileData = authConfig.profiles[override]
    if (profileData?.workspace) return profileData.workspace

    command.error(
      `Workspace "${override}" not found. Run \`qfg workspace switch\` to pick one.`,
      {exit: 1},
    )
  }

  const activeProfile = getActiveProfile()
  const profileData =
    authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']
  if (!profileData?.workspace) {
    command.error(
      'No active workspace. Run `qfg login` / `qfg workspace switch`, or set QUONFIG_API_KEY + QUONFIG_WORKSPACE.',
      {exit: 1},
    )
  }

  return profileData.workspace
}
