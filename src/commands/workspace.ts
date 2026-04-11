import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getActiveProfile, loadAuthConfig} from '../util/token-storage.js'

export default class Workspace extends BaseCommand {
  static description = 'Show the current workspace'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
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
}
