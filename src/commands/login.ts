import {select} from '@inquirer/prompts'
import {Flags} from '@oclif/core'
import * as childProcess from 'node:child_process'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getDomain} from '../util/domain-urls.js'
import {
  createCodeVerifier,
  exchangeCodeForTokens,
  generateAuthUrl,
  introspectToken,
  startCallbackServer,
} from '../util/oauth-client.js'
import {loadAuthConfig, saveAuthConfig, saveTokens} from '../util/token-storage.js'

export default class Login extends BaseCommand {
  static description = 'Log in to Quonfig using OAuth'

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --profile myprofile']

  static flags = {
    profile: Flags.string({
      char: 'p',
      description: 'Profile name to create or update (defaults to "default")',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Login)
    const profileName = flags.profile || 'default'

    this.log('Starting local callback server...')

    const domain = getDomain()

    // Generate PKCE code verifier
    const codeVerifier = createCodeVerifier()

    // Start the callback server and get the port immediately
    const {port, waitForCallback, close} = await startCallbackServer()

    // Now we have the port, generate the auth URL and open the browser
    const authUrl = generateAuthUrl(port, codeVerifier, domain)
    this.verboseLog(`Using domain: ${domain}`)
    this.verboseLog(`Auth URL: ${authUrl}`)
    this.log('Opening browser for authentication...')

    const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    childProcess.exec(`${opener} "${authUrl}"`)

    // Wait for the callback
    const code = await waitForCallback()

    this.verboseLog('Exchanging authorization code for tokens...')
    const tokenResponse = await exchangeCodeForTokens(code, port, codeVerifier, domain)

    // Decode JWT to extract email
    const jwtParts = tokenResponse.access_token.split('.')
    const payload = JSON.parse(Buffer.from(jwtParts[1], 'base64').toString('utf8'))
    const userEmail = payload.email

    // Display the JWT in verbose mode
    if (this.isVerbose) {
      this.verboseLog('\n=== Decoded JWT Payload ===')
      this.verboseLog(JSON.stringify(payload, null, 2))
      this.verboseLog('===========================\n')
    }

    // Save tokens
    await saveTokens({
      accessToken: tokenResponse.access_token,
      expiresAt: Date.now() + tokenResponse.expires_in * 1000,
      refreshToken: tokenResponse.refresh_token,
    })

    this.log('Fetching available workspaces...')
    this.verboseLog(`Introspecting token at domain: ${domain}`)
    const introspection = await introspectToken(tokenResponse.access_token, domain, this.isVerbose)

    // Flatten workspaces from all organizations, keeping org info
    const allWorkspaces = introspection.organizations.flatMap((org) =>
      org.workspaces.map((ws) => ({
        ...ws,
        organizationName: org.name,
      })),
    )

    if (allWorkspaces.length === 0) {
      close()
      return this.err('No workspaces found for this user')
    }

    // Let user select a workspace
    let selectedWorkspace: string

    if (allWorkspaces.length === 1) {
      selectedWorkspace = allWorkspaces[0].id
      this.log(`Using workspace: ${allWorkspaces[0].organizationName} - ${allWorkspaces[0].name}`)
    } else {
      selectedWorkspace = await select({
        choices: allWorkspaces.map((ws) => ({
          name: `${ws.organizationName} - ${ws.name}`,
          value: ws.id,
        })),
        message: 'Select a workspace:',
      })
    }

    // Get or create config with profile
    const existingConfig = await loadAuthConfig()

    const selectedWorkspaceInfo = allWorkspaces.find((ws) => ws.id === selectedWorkspace)
    const workspaceName = selectedWorkspaceInfo
      ? `${selectedWorkspaceInfo.organizationName} - ${selectedWorkspaceInfo.name}`
      : undefined

    // Save auth config - set default profile if this is the first profile or if we're updating default
    const isFirstProfile = !existingConfig || Object.keys(existingConfig.profiles).length === 0
    const shouldSetDefault = isFirstProfile || profileName === 'default' || !existingConfig?.defaultProfile

    await saveAuthConfig({
      defaultProfile: shouldSetDefault ? profileName : existingConfig?.defaultProfile,
      profiles: {
        ...existingConfig?.profiles,
        [profileName]: {
          workspace: selectedWorkspace,
          workspaceName,
        },
      },
    })

    this.log(`\nProfile '${profileName}' configured.`)
    if (shouldSetDefault) {
      this.log(`Set as default profile.`)
    }

    close()

    const selectedWorkspaceName = allWorkspaces.find((ws) => ws.id === selectedWorkspace)?.name

    this.log(`\nSuccessfully logged in!`)
    if (userEmail) {
      this.log(`Logged in as: ${userEmail}`)
    }
    this.log(`Active workspace: ${selectedWorkspaceName}`)

    return {
      activeWorkspace: selectedWorkspace,
      success: true,
      workspaces: allWorkspaces.map((ws) => ({id: ws.id, name: ws.name})),
    }
  }
}
