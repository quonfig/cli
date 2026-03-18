import {select} from '@inquirer/prompts'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getDomain} from '../util/domain-urls.js'
import {introspectToken} from '../util/oauth-client.js'
import {getActiveProfile, loadAuthConfig, loadTokens, saveAuthConfig} from '../util/token-storage.js'

export default class Workspace extends BaseCommand {
  static description = 'Switch active workspace or display current workspace'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    const authConfig = await loadAuthConfig()
    const tokens = await loadTokens()

    if (!authConfig || !tokens?.accessToken) {
      return this.err('Not logged in. Please run `qfg login` first.')
    }

    const domain = getDomain()

    // Fetch current workspaces
    const introspection = await introspectToken(tokens.accessToken, domain, this.isVerbose)
    const allWorkspaces = introspection.organizations.flatMap((org) =>
      org.workspaces.map((ws) => ({
        ...ws,
        organizationName: org.name,
      })),
    )

    if (allWorkspaces.length === 0) {
      return this.err('No workspaces found for this user')
    }

    // Get the active profile
    const activeProfile = getActiveProfile()
    const profile = authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']

    if (!profile) {
      return this.err('No active profile found. Please run `qfg login` first.')
    }

    const currentWorkspace = profile.workspace
    const currentWorkspaceInfo = allWorkspaces.find((ws) => ws.id === currentWorkspace)
    const currentWorkspaceName = currentWorkspaceInfo
      ? `${currentWorkspaceInfo.organizationName} - ${currentWorkspaceInfo.name}`
      : profile.workspaceName || 'None'

    // If there's only one workspace, just display it
    if (allWorkspaces.length === 1) {
      this.log(`Current workspace (profile: ${activeProfile}): ${currentWorkspaceName}`)
      this.log('\nYou only have access to one workspace.')
      return {
        activeWorkspace: currentWorkspace,
        profile: activeProfile,
        workspaces: allWorkspaces.map((ws) => ({id: ws.id, name: ws.name})),
      }
    }

    // Show current workspace
    this.log(`Current workspace (profile: ${activeProfile}): ${currentWorkspaceName}\n`)

    // Let user select a new workspace
    const newWorkspace = await select({
      choices: allWorkspaces.map((ws) => ({
        name: `${ws.organizationName} - ${ws.name}`,
        value: ws.id,
      })),
      message: 'Select a workspace:',
    })

    const newWorkspaceInfo = allWorkspaces.find((ws) => ws.id === newWorkspace)
    const newWorkspaceName = newWorkspaceInfo
      ? `${newWorkspaceInfo.organizationName} - ${newWorkspaceInfo.name}`
      : newWorkspace

    // Update the active profile's workspace
    await saveAuthConfig({
      ...authConfig,
      profiles: {
        ...authConfig.profiles,
        [activeProfile]: {
          workspace: newWorkspace,
          workspaceName: newWorkspaceName,
        },
      },
    })

    this.log(`\nSwitched to workspace: ${newWorkspaceName}`)

    return {
      activeWorkspace: newWorkspace,
      previousWorkspace: currentWorkspace,
      profile: activeProfile,
      success: true,
    }
  }
}
