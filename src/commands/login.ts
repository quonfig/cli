import {Flags} from '@oclif/core'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {getApiUrl} from '../util/domain-urls.js'
import {orchestrateMultiOrgLogin} from '../util/login-orchestrator.js'
import {decodeJWT, pollForToken, requestDeviceCode} from '../util/oauth-client.js'
import {openBrowser} from '../util/open-browser.js'
import {
  getAuthConfigFilePath,
  getTokenFilePath,
  loadAuthConfig,
  saveAuthConfig,
  saveTokens,
} from '../util/token-storage.js'

type WorkspaceEntry = {
  workspaceId: string
  workspaceSlug: string
  workosOrgId: string
  organizationSlug?: string
  organizationName?: string
}

export default class Login extends BaseCommand {
  static description = 'Log in to Quonfig via WorkOS device authorization (mints one token per org)'

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --profile myprofile']

  static flags = {
    profile: Flags.string({
      char: 'p',
      description: 'Profile name to save credentials under (advanced; defaults to "default")',
      hidden: true,
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {flags} = await this.parse(Login)
    const profileName = flags.profile || 'default'

    if (process.env.QUONFIG_API_KEY && process.env.QUONFIG_API_KEY.length > 0) {
      this.log('Note: QUONFIG_API_KEY is set — runtime will prefer it over the login session.')
    }

    // Step 1: Request device code from WorkOS
    this.verboseLog('Requesting device authorization code...')
    const deviceAuth = await requestDeviceCode()

    // Step 2: Display code and URL to user
    this.log(`\nTo authenticate, visit:\n`)
    this.log(`  ${deviceAuth.verification_uri_complete}\n`)
    this.log(`Or go to ${deviceAuth.verification_uri} and enter code: ${deviceAuth.user_code}\n`)

    // Listen for Enter to open the URL in the user's browser. Runs alongside
    // token polling so the user can also paste the URL manually.
    const stdinIsTTY = Boolean(process.stdin.isTTY)
    let browserOpened = false
    const onEnter = (chunk: Buffer): void => {
      if (browserOpened) return
      if (!chunk.toString().match(/[\r\n]/)) return
      browserOpened = true
      openBrowser(deviceAuth.verification_uri_complete)
      this.log('Opening browser...')
    }

    if (stdinIsTTY) {
      this.log('Press Enter to open the URL in your browser, or open it manually.')
      process.stdin.on('data', onEnter)
      process.stdin.resume()
    }
    this.log('Waiting for authentication...')

    // Step 3: Poll for token
    let tokenResponse
    try {
      tokenResponse = await pollForToken(
        deviceAuth.device_code,
        deviceAuth.interval,
        deviceAuth.expires_in,
        this.isVerbose,
      )
    } finally {
      if (stdinIsTTY) {
        process.stdin.off('data', onEnter)
        process.stdin.pause()
      }
    }

    if (this.isVerbose) {
      const payload = decodeJWT(tokenResponse.access_token)
      this.verboseLog('\n=== Decoded JWT Payload ===')
      this.verboseLog(JSON.stringify(payload, null, 2))
      this.verboseLog('===========================\n')
    }

    // Step 4: Multi-org orchestration — fetch /me/organizations, mint one
    // org-scoped TokenSet per org in parallel, build the per-org TokenStore.
    const apiUrl = getApiUrl()
    let result
    try {
      result = await orchestrateMultiOrgLogin({
        apiUrl,
        initialAccessToken: tokenResponse.access_token,
        initialRefreshToken: tokenResponse.refresh_token,
        user: tokenResponse.user,
      })
    } catch (error) {
      return this.err(`Login failed: ${(error as Error).message}`)
    }

    if (result.skippedOrgSlugs.length > 0) {
      this.log(
        `\nNote: you belong to ${result.organizations.length} orgs; minting tokens for the first 10 alphabetically. ` +
          `Skipped: ${result.skippedOrgSlugs.join(', ')}.`,
      )
    }

    // Step 5: Persist token store.
    this.verboseLog('Saving tokens to', getTokenFilePath())
    let tokensPath: string
    try {
      tokensPath = await saveTokens(result.tokenStore)
    } catch (error) {
      return this.err(`Login failed: could not save tokens. ${(error as Error).message}`)
    }

    this.verboseLog('Tokens saved at', tokensPath)

    // Step 6: Pick a default workspace from the default org for the saved
    // profile. The default org is the only one for single-org users, or the
    // first slug alphabetically for multi-org users (no interactive prompt).
    let defaultWorkspace: WorkspaceEntry | undefined
    try {
      const defaultToken = result.tokenStore.tokensByOrg[result.defaultOrgId]
      const res = await fetch(`${apiUrl}/api/v1/userWorkspaces/list`, {
        body: JSON.stringify({json: {}}),
        headers: {
          Authorization: `Bearer ${defaultToken.access_token}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
      })

      if (res.ok) {
        const body = (await res.json()) as {json?: WorkspaceEntry[]}
        const list = (body.json ?? body) as unknown as WorkspaceEntry[]
        const candidates = (Array.isArray(list) ? list : []).filter(
          (w) => w.workosOrgId === result.defaultOrgId,
        )
        candidates.sort((a, b) => a.workspaceSlug.localeCompare(b.workspaceSlug))
        defaultWorkspace = candidates[0]
      } else {
        this.verboseLog('userWorkspaces/list non-OK', {status: res.status})
      }
    } catch (error) {
      this.verboseLog('userWorkspaces/list failed', {error: String(error)})
    }

    // Step 7: Save auth config with the picked workspace.
    const existingConfig = await loadAuthConfig()
    const isFirstProfile = !existingConfig || Object.keys(existingConfig.profiles).length === 0
    const shouldSetDefault = isFirstProfile || profileName === 'default' || !existingConfig?.defaultProfile

    this.verboseLog('Saving auth config to', getAuthConfigFilePath())
    let configPath: string
    try {
      configPath = await saveAuthConfig({
        defaultProfile: shouldSetDefault ? profileName : existingConfig?.defaultProfile,
        profiles: {
          ...existingConfig?.profiles,
          [profileName]: {
            organizationName: result.defaultOrg.name,
            organizationSlug: result.defaultOrg.slug,
            workspace: defaultWorkspace?.workspaceId ?? result.defaultOrgId,
            workspaceName: defaultWorkspace?.workspaceSlug,
            workspaceSlug: defaultWorkspace?.workspaceSlug,
          },
        },
      })
    } catch (error) {
      return this.err(`Login failed: could not save auth config. ${(error as Error).message}`)
    }

    this.verboseLog('Auth config saved at', configPath)

    // Step 8: User-facing summary.
    this.log('\nSuccessfully logged in!')
    if (result.email) this.log(`Logged in as: ${result.email}`)
    this.log(`Tokens stored for orgs: ${result.mintedOrgSlugs.join(', ')}`)

    if (defaultWorkspace) {
      const pin = `${result.defaultOrg.slug}/${defaultWorkspace.workspaceSlug}`
      this.log(`Default workspace: ${pin}  (${defaultWorkspace.workspaceId})`)
      this.log(`\nTo pin a project to this workspace, add to your .env:`)
      this.log(`  QUONFIG_WORKSPACE=${pin}`)
      if (result.organizations.length > 1) {
        this.log(`\nYou belong to multiple orgs. To switch: qfg workspace switch`)
      }
    } else {
      this.log(
        `\nNo workspaces found in ${result.defaultOrg.slug}. Create one with: qfg workspace create <slug> --org ${result.defaultOrg.slug}`,
      )
    }

    return {
      defaultOrg: {
        organizationName: result.defaultOrg.name,
        organizationSlug: result.defaultOrg.slug,
        workosOrgId: result.defaultOrgId,
      },
      email: result.email,
      mintedOrgSlugs: result.mintedOrgSlugs,
      organizationId: result.defaultOrgId,
      organizationName: result.defaultOrg.name,
      skippedOrgSlugs: result.skippedOrgSlugs,
      success: true,
      userId: result.userId,
      workspaceId: defaultWorkspace?.workspaceId,
      workspaceSlug: defaultWorkspace?.workspaceSlug,
    }
  }
}
