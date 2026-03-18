import {select} from '@inquirer/prompts'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {loadAuthConfig, saveAuthConfig} from '../util/token-storage.js'

export default class Profile extends BaseCommand {
  static description = 'Manage profiles and set default profile'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    const authConfig = await loadAuthConfig()

    if (!authConfig || Object.keys(authConfig.profiles).length === 0) {
      return this.err('Not logged in. Please run `qfg login` first.')
    }

    const currentDefault = authConfig.defaultProfile || 'default'

    // If only one profile, just show it
    if (Object.keys(authConfig.profiles).length === 1) {
      const profileName = Object.keys(authConfig.profiles)[0]
      const profile = authConfig.profiles[profileName]
      this.log(`Current default profile: ${profileName}`)
      this.log(`Workspace: ${profile.workspaceName || profile.workspace}`)
      this.log('\nYou only have one profile.')
      return {
        defaultProfile: profileName,
        profiles: Object.keys(authConfig.profiles),
      }
    }

    // Show current default
    this.log(`Current default profile: ${currentDefault}\n`)

    // Let user select a new default profile
    const newDefault = await select({
      choices: Object.entries(authConfig.profiles).map(([name, profile]) => ({
        name: `${name} (${profile.workspaceName || profile.workspace})`,
        value: name,
      })),
      message: 'Select default profile:',
    })

    // Update the default profile
    await saveAuthConfig({
      ...authConfig,
      defaultProfile: newDefault,
    })

    this.log(`\nDefault profile set to: ${newDefault}`)

    return {
      defaultProfile: newDefault,
      previousDefault: currentDefault,
      success: true,
    }
  }
}
