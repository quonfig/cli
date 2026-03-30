import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getActiveProfile, loadAuthConfig} from '../util/token-storage.js'

export default class Workspace extends BaseCommand {
  static description = 'Display current workspace. To switch workspaces, run `qfg login --profile <name>`.'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    const authConfig = await loadAuthConfig()

    if (!authConfig || Object.keys(authConfig.profiles).length === 0) {
      return this.err('Not logged in. Please run `qfg login` first.')
    }

    // Get the active profile
    const activeProfile = getActiveProfile()
    const profile = authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']

    if (!profile) {
      return this.err('No active profile found. Please run `qfg login` first.')
    }

    this.log(`Active profile: ${activeProfile}`)
    this.log(`Workspace: ${profile.workspaceName || profile.workspace}`)

    // Show all profiles if more than one
    const profileNames = Object.keys(authConfig.profiles)
    if (profileNames.length > 1) {
      this.log('\nAll profiles:')
      for (const name of profileNames) {
        const p = authConfig.profiles[name]
        const marker = name === activeProfile ? ' (active)' : ''
        this.log(`  ${name}: ${p.workspaceName || p.workspace}${marker}`)
      }

      this.log('\nTo switch, use: qfg login --profile <name>')
      this.log('To change default: qfg profile')
    }

    return {
      activeProfile,
      profiles: Object.fromEntries(
        profileNames.map((name) => [name, authConfig.profiles[name]]),
      ),
      workspace: profile.workspace,
      workspaceName: profile.workspaceName,
    }
  }
}
