import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {decodeJWT} from '../util/oauth-client.js'
import {getActiveProfile, loadAuthConfig, loadTokens} from '../util/token-storage.js'

export default class Whoami extends BaseCommand {
  static description = 'Display information about the currently logged in user'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    const authConfig = await loadAuthConfig()
    const tokens = await loadTokens()

    if (!authConfig || !tokens?.accessToken) {
      this.log('Not logged in. Use `qfg login` to authenticate.')
      return {
        loggedIn: false,
      }
    }

    // Get email from stored user info or decode JWT
    let userEmail = tokens.userEmail
    let orgId: string | undefined

    if (!userEmail) {
      try {
        const payload = decodeJWT(tokens.accessToken)
        userEmail = payload.email as string
        orgId = payload.org_id as string
      } catch {
        // If we can't decode the token, continue without email
      }
    }

    // Get the active profile
    const activeProfile = getActiveProfile()
    const profile = authConfig.profiles[activeProfile] || authConfig.profiles[authConfig.defaultProfile || 'default']

    if (!profile) {
      this.log('Not logged in. Use `qfg login` to authenticate.')
      return {
        loggedIn: false,
      }
    }

    // Display user information
    this.log(`Logged in as: ${userEmail || 'Unknown'}`)
    this.log(`Active profile: ${activeProfile}`)
    this.log(`Active workspace: ${profile.workspaceName || profile.workspace}`)

    return {
      email: userEmail,
      loggedIn: true,
      organizationId: orgId || profile.workspace,
      profile: activeProfile,
      userId: tokens.userId,
      workspace: profile.workspace,
      workspaceName: profile.workspaceName,
    }
  }
}
