import {select} from '@inquirer/prompts'

import type {JsonObj} from '../../result.js'

import {BaseCommand} from '../../index.js'
import {getApiUrl} from '../../util/domain-urls.js'
import {getValidAccessToken} from '../../util/get-valid-token.js'
import {loadAuthConfig, saveAuthConfig} from '../../util/token-storage.js'

export default class WorkspaceSwitch extends BaseCommand {
  static description = 'Switch to a different workspace'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    // Get a valid token — refresh silently if needed, error if not logged in
    let accessToken: string
    try {
      accessToken = await getValidAccessToken()
    } catch {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    const authConfig = await loadAuthConfig()
    if (!authConfig) {
      return this.err('Not logged in. Run `qfg login` first.')
    }

    // Fetch all workspaces the user has access to
    const apiUrl = getApiUrl()
    type WorkspaceEntry = {workspaceId: string; workspaceSlug: string; workosOrgId: string; organizationName: string}
    let candidates: WorkspaceEntry[] = []

    try {
      const res = await fetch(`${apiUrl}/api/v1/userWorkspaces/list`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({json: {}}),
      })

      if (!res.ok) {
        return this.err(`Failed to fetch workspaces (${res.status}). Try \`qfg login\` to re-authenticate.`)
      }

      const body = (await res.json()) as {json?: WorkspaceEntry[]}
      const all = (body.json ?? body) as unknown as WorkspaceEntry[]
      candidates = Array.isArray(all) ? all : []
    } catch (error) {
      return this.err(`Failed to fetch workspaces: ${String(error)}`)
    }

    if (candidates.length === 0) {
      return this.err('No workspaces found for your account.')
    }

    // Pick workspace
    let match: WorkspaceEntry
    if (candidates.length === 1) {
      match = candidates[0]
      this.log(`Only one workspace available: ${match.organizationName} / ${match.workspaceSlug}`)
    } else {
      const chosen = await select({
        choices: candidates.map((w) => ({
          name: `${w.organizationName} / ${w.workspaceSlug}`,
          value: w.workspaceId,
        })),
        message: 'Select workspace:',
      })
      const found = candidates.find((w) => w.workspaceId === chosen)
      if (!found) return this.err('No workspace selected.')
      match = found
    }

    // Save as the default profile
    const defaultProfile = authConfig.defaultProfile || 'default'
    await saveAuthConfig({
      ...authConfig,
      profiles: {
        ...authConfig.profiles,
        [defaultProfile]: {
          workspace: match.workspaceId,
          workspaceName: match.workspaceSlug,
          workspaceSlug: match.workspaceSlug,
          organizationName: match.organizationName,
        },
      },
    })

    this.log(`\nSwitched to: ${match.organizationName} / ${match.workspaceSlug}`)
    this.log(`\nTo use this workspace in a project, add to your .env:`)
    this.log(`  QUONFIG_WORKSPACE=${match.workspaceSlug}`)

    return {
      organizationName: match.organizationName,
      success: true,
      workspaceId: match.workspaceId,
      workspaceSlug: match.workspaceSlug,
    }
  }
}
