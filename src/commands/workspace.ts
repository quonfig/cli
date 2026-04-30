import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getApiUrl} from '../util/domain-urls.js'
import {getValidAccessToken} from '../util/get-valid-token.js'
import {getActiveProfile, loadAuthConfig} from '../util/token-storage.js'

const UUID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i

type WorkspaceEntry = {
  workspaceId: string
  workspaceSlug: string
  organizationName?: string
}

export default class Workspace extends BaseCommand {
  static description = 'Show the current workspace'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    // API-key mode: resolve the workspace from QUONFIG_WORKSPACE via the server
    // so we show the workspace the key is actually scoped to, not whatever
    // the local OAuth config happens to point at.
    if (process.env.QUONFIG_API_KEY) {
      return this.runApiKeyMode()
    }

    const authConfig = await loadAuthConfig()

    if (!authConfig || Object.keys(authConfig.profiles).length === 0) {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    const activeProfileName = getActiveProfile()
    const profile =
      authConfig.profiles[activeProfileName] || authConfig.profiles[authConfig.defaultProfile || 'default']

    if (!profile) {
      return this.err('No workspace configured. Run `qfg login` first.')
    }

    const workspaceSlug = profile.workspaceSlug || profile.workspaceName || profile.workspace
    const orgLine = profile.organizationName ? `${profile.organizationName} / ` : ''

    this.log(`Workspace:    ${orgLine}${workspaceSlug}`)
    this.log(`ID:           ${profile.workspace}`)
    this.log(`\nTo switch:    qfg workspace switch`)
    this.log(`To pin in a project, add to .env:`)
    this.log(`  QUONFIG_WORKSPACE=${workspaceSlug}`)

    return {
      organizationName: profile.organizationName,
      workspace: profile.workspace,
      workspaceSlug,
    }
  }

  private async runApiKeyMode(): Promise<JsonObj | void> {
    const override = process.env.QUONFIG_WORKSPACE
    if (!override) {
      return this.err(
        'QUONFIG_API_KEY is set but QUONFIG_WORKSPACE is not. Set QUONFIG_WORKSPACE=<workspace-slug> (UUIDs also work).',
      )
    }

    // getValidAccessToken short-circuits when QUONFIG_API_KEY is set, so the
    // orgId argument is ignored on this path.
    let jwt: string
    try {
      jwt = await getValidAccessToken('')
    } catch (error) {
      return this.err(error instanceof Error ? error.message : String(error))
    }

    let entries: WorkspaceEntry[] = []
    try {
      const res = await fetch(`${getApiUrl()}/api/v1/userWorkspaces/list`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json'},
        body: JSON.stringify({json: {}}),
      })
      if (!res.ok) {
        return this.err(`Failed to resolve workspace (HTTP ${res.status}). Check that QUONFIG_API_KEY is valid.`)
      }
      const body = (await res.json()) as {json?: WorkspaceEntry[]}
      entries = body.json ?? (body as unknown as WorkspaceEntry[]) ?? []
    } catch (error) {
      return this.err(
        `Failed to resolve workspace "${override}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const match = UUID_PATTERN.test(override)
      ? entries.find((w) => w.workspaceId === override)
      : entries.find((w) => w.workspaceSlug === override)

    if (!match) {
      const available = entries.map((w) => w.workspaceSlug).join(', ') || '(none)'
      return this.err(`Workspace "${override}" not accessible with this API key. Available: ${available}.`)
    }

    const orgLine = match.organizationName ? `${match.organizationName} / ` : ''
    this.log(`Workspace:    ${orgLine}${match.workspaceSlug}  (API key mode)`)
    this.log(`ID:           ${match.workspaceId}`)
    this.log(`Source:       QUONFIG_API_KEY + QUONFIG_WORKSPACE=${override}`)

    return {
      organizationName: match.organizationName,
      workspace: match.workspaceId,
      workspaceSlug: match.workspaceSlug,
    }
  }
}
