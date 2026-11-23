import {getApiUrl} from './domain-urls.js'

/**
 * qfg-oscj0.8: an API key (qf_uk_ or qf_sa_) is bound to exactly one
 * workspace server-side (api_keys.workspace_id), so QUONFIG_WORKSPACE is
 * optional when QUONFIG_API_KEY is set. This asks the server which one.
 *
 * 1. GET /v1/whoami returns the key's workspaceId for both key kinds. The
 *    CLI calls it on the app host at its mount path, /public-api/v1/whoami.
 * 2. userWorkspaces.list (best-effort) turns that id into org/workspace
 *    slugs for labels and the quonfig.json pin. For a qf_sa_ key it holds
 *    one row; for a qf_uk_ key it holds all the user's workspaces, so the
 *    row is picked by id. If it fails, the id alone is still returned.
 *
 * Only a whoami failure is fatal, and its error tells the user to set
 * QUONFIG_WORKSPACE, which still works exactly as before.
 */

export interface InferredKeyWorkspace {
  /** Empty string when the list call could not name the org. */
  orgSlug: string
  workspaceId: string
  workspaceSlug?: string
}

interface InferCommand {
  error(message: string, options: {exit: number}): never
  verboseLog(...args: unknown[]): void
}

const NOT_INFERRED =
  "QUONFIG_API_KEY is set but QUONFIG_WORKSPACE is not, and the key's workspace could not be determined"
const SET_IT = 'Set QUONFIG_WORKSPACE=<org>/<workspace> (e.g. acme/foo). (UUIDs also work.)'

export async function inferApiKeyWorkspace(command: InferCommand, apiKey: string): Promise<InferredKeyWorkspace> {
  let res: Response
  try {
    res = await fetch(`${getApiUrl()}/public-api/v1/whoami`, {
      method: 'GET',
      headers: {Authorization: `Bearer ${apiKey}`},
    })
  } catch (error) {
    command.error(`${NOT_INFERRED} (${error instanceof Error ? error.message : String(error)}). ${SET_IT}`, {exit: 1})
  }

  // A rejected key is the real problem; setting QUONFIG_WORKSPACE would only
  // move the same 401 to the next call.
  if (res.status === 401 || res.status === 403) {
    command.error(
      `QUONFIG_API_KEY was rejected (whoami returned HTTP ${res.status}). Check that the key is valid and not revoked.`,
      {exit: 1},
    )
  }

  if (!res.ok) {
    command.error(`${NOT_INFERRED} (whoami returned HTTP ${res.status}). ${SET_IT}`, {exit: 1})
  }

  const body = (await res.json().catch(() => {})) as {workspaceId?: unknown} | undefined
  const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : ''
  if (!workspaceId) {
    command.error(`${NOT_INFERRED} (whoami returned no workspaceId). ${SET_IT}`, {exit: 1})
  }

  const slugs = await lookupSlugs(command, apiKey, workspaceId)
  command.verboseLog('ApiKey auth', {source: 'inferred-from-key', workspaceId, ...slugs})
  return {workspaceId, orgSlug: slugs.orgSlug ?? '', workspaceSlug: slugs.workspaceSlug}
}

async function lookupSlugs(
  command: InferCommand,
  apiKey: string,
  workspaceId: string,
): Promise<{orgSlug?: string; workspaceSlug?: string}> {
  type WorkspaceEntry = {organizationSlug?: string; workspaceId: string; workspaceSlug: string}
  try {
    const res = await fetch(`${getApiUrl()}/api/v1/userWorkspaces/list`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({json: {}}),
    })
    if (!res.ok) {
      command.verboseLog('infer-api-key-workspace: userWorkspaces/list non-OK', {status: res.status})
      return {}
    }

    const body = (await res.json()) as {json?: WorkspaceEntry[]}
    const entries = (body.json ?? body) as unknown as WorkspaceEntry[]
    const match = Array.isArray(entries) ? entries.find((w) => w.workspaceId === workspaceId) : undefined
    return match ? {orgSlug: match.organizationSlug, workspaceSlug: match.workspaceSlug} : {}
  } catch (error) {
    command.verboseLog('infer-api-key-workspace: userWorkspaces/list failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}
