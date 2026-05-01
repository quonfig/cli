import * as fs from 'node:fs'
import * as path from 'node:path'

import {getDomain} from './domain-urls.js'
import {getQuonfigConfigHome} from './quonfig-home.js'

export interface TokenStorageOptions {
  quonfigDir?: string
}

const getQuonfigDir = (options?: TokenStorageOptions) => options?.quonfigDir || getQuonfigConfigHome()
const getTokenFile = (options?: TokenStorageOptions) => {
  const domain = getDomain()
  const filename = domain === 'quonfig.com' ? 'tokens.json' : `tokens-${domain.replaceAll('.', '-')}.json`
  return path.join(getQuonfigDir(options), filename)
}
const getConfigFile = (options?: TokenStorageOptions) => {
  const domain = getDomain()
  const filename = domain === 'quonfig.com' ? 'config' : `config-${domain.replaceAll('.', '-')}`
  return path.join(getQuonfigDir(options), filename)
}

export interface TokenSet {
  access_token: string
  expires_at: number
  refresh_token: string
  user_email?: string
  user_id?: string
  /**
   * Human-readable org slug (e.g. "acme") — populated by the per-org login
   * flow so the CLI can resolve `acme/foo`-form workspace addresses against
   * the local store without round-tripping `me.organizations`. See
   * project/plans/multi-org-cli-auth.md (qfg-kr7).
   */
  org_slug?: string
  /** Org display name for `qfg whoami` / `qfg workspace`. */
  org_name?: string
}

export interface TokenStore {
  defaultOrgId?: string
  tokensByOrg: {[workosOrgId: string]: TokenSet}
}

export const getTokenForOrg = (store: TokenStore, workosOrgId: string): TokenSet | undefined =>
  store.tokensByOrg[workosOrgId]

/**
 * Find the workosOrgId in the per-org token store whose TokenSet has the
 * given org_slug. Returns undefined when no matching slug is present (either
 * because the user has never logged in to that org, or because tokens were
 * minted by a pre-qfg-kr7 login flow that didn't persist org_slug).
 */
export const findOrgIdBySlug = (store: TokenStore, orgSlug: string): string | undefined => {
  for (const [orgId, tokens] of Object.entries(store.tokensByOrg)) {
    if (tokens.org_slug === orgSlug) return orgId
  }
  return undefined
}

export interface AuthConfig {
  defaultProfile?: string
  profiles: {
    [profileName: string]: {
      workspace: string
      workspaceName?: string
      workspaceSlug?: string
      organizationName?: string
      /**
       * WorkOS organization UUID for the saved workspace. Persisted by
       * `qfg workspace switch` (qfg-kr7.9) so other commands can pick the
       * matching per-org token without round-tripping `me.organizations`.
       */
      workosOrgId?: string
      /** Org URL slug — used when rendering the org/ws pin form. */
      organizationSlug?: string
    }
  }
}

/**
 * Find a workspace ID by slug across all saved profiles.
 * Used to resolve QUONFIG_WORKSPACE and --workspace flag values.
 */
export const resolveWorkspaceId = (config: AuthConfig, slug: string): string | undefined => {
  for (const profile of Object.values(config.profiles)) {
    if (profile.workspaceSlug === slug || profile.workspaceName === slug) {
      return profile.workspace
    }
  }

  return undefined
}

const ensureQuonfigDir = async (options?: TokenStorageOptions) => {
  const quonfigDir = getQuonfigDir(options)
  try {
    await fs.promises.access(quonfigDir, fs.constants.F_OK)
  } catch {
    await fs.promises.mkdir(quonfigDir, {recursive: true})
  }
}

export const getTokenFilePath = (options?: TokenStorageOptions): string => getTokenFile(options)
export const getAuthConfigFilePath = (options?: TokenStorageOptions): string => getConfigFile(options)

const verifyWritten = async (filePath: string, label: string): Promise<void> => {
  let stat
  try {
    stat = await fs.promises.stat(filePath)
  } catch (error) {
    throw new Error(
      `Failed to persist ${label} to ${filePath}: file is missing after write (${(error as Error).message}). ` +
        `This can happen if a concurrent process (e.g. npm install -g) clobbered the install. Re-run after it finishes.`,
    )
  }

  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Failed to persist ${label} to ${filePath}: file is empty or not a regular file after write.`)
  }
}

export const saveTokens = async (store: TokenStore, options?: TokenStorageOptions): Promise<string> => {
  await ensureQuonfigDir(options)
  const targetFile = getTokenFile(options)
  const tmpFile = `${targetFile}.tmp`
  await fs.promises.writeFile(tmpFile, JSON.stringify(store, null, 2), {encoding: 'utf8', mode: 0o600})
  await fs.promises.rename(tmpFile, targetFile)
  await verifyWritten(targetFile, 'tokens')
  // Round-trip parse to confirm the file on disk is the JSON we just wrote.
  try {
    const onDisk = await fs.promises.readFile(targetFile, 'utf8')
    JSON.parse(onDisk)
  } catch (error) {
    throw new Error(`Failed to verify tokens at ${targetFile}: ${(error as Error).message}`)
  }

  return targetFile
}

const isTokenStore = (value: unknown): value is TokenStore =>
  typeof value === 'object' && value !== null && 'tokensByOrg' in (value as Record<string, unknown>)

export const loadTokens = async (options?: TokenStorageOptions): Promise<TokenStore | null> => {
  let data: string
  try {
    data = await fs.promises.readFile(getTokenFile(options), 'utf8')
  } catch {
    return null
  }

  const parsed = JSON.parse(data) as unknown
  if (!isTokenStore(parsed)) {
    throw new Error('Token store format has changed. Run `qfg login` to re-authenticate.')
  }

  return parsed
}

export const saveAuthConfig = async (config: AuthConfig, options?: TokenStorageOptions): Promise<string> => {
  await ensureQuonfigDir(options)

  let configContent = ''

  // Write default profile if specified
  if (config.defaultProfile) {
    configContent += `default_profile = ${config.defaultProfile}\n\n`
  }

  // Write each profile
  for (const [profileName, profileData] of Object.entries(config.profiles)) {
    configContent += `[profile ${profileName}]\n`
    configContent += `workspace = ${profileData.workspace}`
    if (profileData.workspaceName) {
      configContent += ` # ${profileData.workspaceName}`
    }

    configContent += '\n'
    if (profileData.workspaceSlug) {
      configContent += `workspace_slug = ${profileData.workspaceSlug}\n`
    }

    if (profileData.organizationName) {
      configContent += `organization_name = ${profileData.organizationName}\n`
    }

    if (profileData.organizationSlug) {
      configContent += `organization_slug = ${profileData.organizationSlug}\n`
    }

    if (profileData.workosOrgId) {
      configContent += `workos_org_id = ${profileData.workosOrgId}\n`
    }

    configContent += '\n'
  }

  const configTarget = getConfigFile(options)
  const configTmp = `${configTarget}.tmp`
  await fs.promises.writeFile(configTmp, configContent, {encoding: 'utf8', mode: 0o600})
  await fs.promises.rename(configTmp, configTarget)
  await verifyWritten(configTarget, 'auth config')
  return configTarget
}

export const loadAuthConfig = async (options?: TokenStorageOptions): Promise<AuthConfig | null> => {
  try {
    const data = await fs.promises.readFile(getConfigFile(options), 'utf8')

    const config: AuthConfig = {
      profiles: {},
    }

    // Parse default profile
    const defaultMatch = data.match(/default_profile\s*=\s*(.+)/)
    if (defaultMatch && defaultMatch[1]) {
      config.defaultProfile = defaultMatch[1].trim()
    }

    // Parse profiles — each block starts with [profile name] and contains key=value lines
    const profileBlockRegex = /\[profile\s+(\w+)]\s*\n((?:[^[]*\n?)*)/g
    let match

    while ((match = profileBlockRegex.exec(data)) !== null) {
      const profileName = match[1]
      const block = match[2]

      const workspaceMatch = block.match(/workspace\s*=\s*([^\s#]+)(?:\s*#\s*(.+))?/)
      const slugMatch = block.match(/workspace_slug\s*=\s*(\S+)/)
      const orgMatch = block.match(/organization_name\s*=\s*(.+)/)
      const orgSlugMatch = block.match(/organization_slug\s*=\s*(\S+)/)
      const workosOrgIdMatch = block.match(/workos_org_id\s*=\s*(\S+)/)

      if (!workspaceMatch) continue

      config.profiles[profileName] = {
        workspace: workspaceMatch[1],
        workspaceName: workspaceMatch[2]?.trim(),
        workspaceSlug: slugMatch?.[1]?.trim(),
        organizationName: orgMatch?.[1]?.trim(),
        organizationSlug: orgSlugMatch?.[1]?.trim(),
        workosOrgId: workosOrgIdMatch?.[1]?.trim(),
      }
    }

    return Object.keys(config.profiles).length > 0 ? config : null
  } catch {
    return null
  }
}

export const getActiveProfile = (profileArg?: string): string => profileArg || process.env.QUONFIG_PROFILE || 'default'

export const clearAuth = async (options?: TokenStorageOptions): Promise<void> => {
  try {
    await fs.promises.unlink(getTokenFile(options))
  } catch {
    // Ignore if file doesn't exist
  }

  try {
    await fs.promises.unlink(getConfigFile(options))
  } catch {
    // Ignore if file doesn't exist
  }
}
