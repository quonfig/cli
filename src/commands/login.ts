import {Flags} from '@oclif/core'
import {select} from '@inquirer/prompts'

import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {decodeJWT, pollForToken, requestDeviceCode} from '../util/oauth-client.js'
import {getApiUrl} from '../util/domain-urls.js'
import {loadAuthConfig, saveAuthConfig, saveTokens} from '../util/token-storage.js'

export default class Login extends BaseCommand {
  static description = 'Log in to Quonfig via WorkOS device authorization'

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

    // Step 1: Request device code from WorkOS
    this.verboseLog('Requesting device authorization code...')
    const deviceAuth = await requestDeviceCode()

    // Step 2: Display code and URL to user
    this.log(`\nTo authenticate, visit:\n`)
    this.log(`  ${deviceAuth.verification_uri_complete}\n`)
    this.log(`Or go to ${deviceAuth.verification_uri} and enter code: ${deviceAuth.user_code}\n`)
    this.log('Waiting for authentication...')

    // Step 3: Poll for token
    const tokenResponse = await pollForToken(
      deviceAuth.device_code,
      deviceAuth.interval,
      deviceAuth.expires_in,
      this.isVerbose,
    )

    const user = tokenResponse.user
    const userEmail = user.email

    // Decode JWT to inspect claims
    if (this.isVerbose) {
      const payload = decodeJWT(tokenResponse.access_token)
      this.verboseLog('\n=== Decoded JWT Payload ===')
      this.verboseLog(JSON.stringify(payload, null, 2))
      this.verboseLog('===========================\n')
    }

    // Extract org_id from JWT (WorkOS scopes the token to the selected org)
    const jwtPayload = decodeJWT(tokenResponse.access_token)
    const orgId = (jwtPayload.org_id as string) || user.organization_id

    // Use the JWT's actual exp claim for expiry
    let expiresAt = Date.now() + 300 * 1000 // fallback: 5 minutes
    if (typeof jwtPayload.exp === 'number') {
      expiresAt = (jwtPayload.exp as number) * 1000
    }

    // Save tokens
    await saveTokens({
      accessToken: tokenResponse.access_token,
      expiresAt,
      refreshToken: tokenResponse.refresh_token,
      userEmail,
      userId: user.id,
    })

    // Resolve org_id → workspace UUID via the API
    let workspaceId: string | undefined
    let workspaceName: string | undefined
    let workspaceSlug: string | undefined
    let organizationName: string | undefined
    let organizationId: string | undefined
    let multipleWorkspacesAvailable = false
    try {
      const apiUrl = getApiUrl()
      this.verboseLog('Resolving workspace...', {apiUrl, orgId})
      const res = await fetch(`${apiUrl}/api/v1/userWorkspaces/list`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${tokenResponse.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({json: {}}),
      })

      if (res.ok) {
        type WorkspaceEntry = {workspaceId: string; workspaceSlug: string; workosOrgId: string; organizationName: string}
        const body = await res.json() as {json?: WorkspaceEntry[]}
        const allWorkspaces = (body.json ?? body) as unknown as WorkspaceEntry[]
        const candidates = Array.isArray(allWorkspaces) ? allWorkspaces : []
        multipleWorkspacesAvailable = candidates.length > 1

        let match: WorkspaceEntry | undefined
        if (candidates.length === 1) {
          match = candidates[0]
        } else if (candidates.length > 1) {
          const chosen = await select({
            choices: candidates.map((w) => ({name: `${w.organizationName} / ${w.workspaceSlug}`, value: w.workspaceId})),
            message: 'Select workspace:',
          })
          match = candidates.find((w) => w.workspaceId === chosen)
        }

        if (match) {
          workspaceId = match.workspaceId
          workspaceName = match.workspaceSlug
          workspaceSlug = match.workspaceSlug
          organizationName = match.organizationName
          organizationId = match.workosOrgId
          this.verboseLog('Resolved workspace', {workspaceId, workspaceName, workspaceSlug, organizationName})
        }
      } else {
        this.verboseLog('Failed to resolve workspace', {status: res.status})
      }
    } catch (error) {
      this.verboseLog('Failed to resolve workspace', {error: String(error)})
    }

    // Get or create config with profile
    const existingConfig = await loadAuthConfig()

    // Save auth config
    const isFirstProfile = !existingConfig || Object.keys(existingConfig.profiles).length === 0
    const shouldSetDefault = isFirstProfile || profileName === 'default' || !existingConfig?.defaultProfile

    await saveAuthConfig({
      defaultProfile: shouldSetDefault ? profileName : existingConfig?.defaultProfile,
      profiles: {
        ...existingConfig?.profiles,
        [profileName]: {
          workspace: workspaceId || orgId || 'unknown',
          workspaceName: workspaceName || (orgId ? `org:${orgId}` : undefined),
          workspaceSlug,
          organizationName,
        },
      },
    })

    this.log('\nSuccessfully logged in!')
    if (userEmail) {
      this.log(`Logged in as: ${userEmail}`)
    }

    if (workspaceName) {
      const orgPrefix = organizationName ? `${organizationName} / ` : ''
      this.log(`Workspace:    ${orgPrefix}${workspaceName}`)
      if (workspaceId) {
        this.log(`              (${workspaceId})`)
      }
    } else if (orgId) {
      this.log(`Organization: ${orgId}`)
    }

    if (multipleWorkspacesAvailable) {
      this.log(`\nTo switch workspaces: qfg workspace switch`)
    }

    return {
      email: userEmail,
      organizationId: organizationId || orgId,
      organizationName,
      success: true,
      userId: user.id,
      workspaceId,
      workspaceSlug,
    }
  }
}
