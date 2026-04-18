import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {getDomain} from './domain-urls.js'

export interface TokenStorageOptions {
  quonfigDir?: string
}

const getQuonfigDir = (options?: TokenStorageOptions) => options?.quonfigDir || path.join(os.homedir(), '.quonfig')
const getTokenFile = (options?: TokenStorageOptions) => {
  const domain = getDomain()
  const filename = domain === 'quonfig.com' ? 'tokens.json' : `tokens-${domain.replaceAll('.', '-')}.json`
  return path.join(getQuonfigDir(options), filename)
}
const getConfigFile = (options?: TokenStorageOptions) => path.join(getQuonfigDir(options), 'config')

export interface TokenData {
  accessToken: string
  expiresAt: number
  refreshToken: string
  userEmail?: string
  userId?: string
}

export interface AuthConfig {
  defaultProfile?: string
  profiles: {
    [profileName: string]: {
      workspace: string
      workspaceName?: string
      workspaceSlug?: string
      organizationName?: string
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

export const saveTokens = async (tokens: TokenData, options?: TokenStorageOptions): Promise<void> => {
  await ensureQuonfigDir(options)
  const targetFile = getTokenFile(options)
  const tmpFile = `${targetFile}.tmp`
  await fs.promises.writeFile(tmpFile, JSON.stringify(tokens, null, 2), {encoding: 'utf8', mode: 0o600})
  await fs.promises.rename(tmpFile, targetFile)
}

export const loadTokens = async (options?: TokenStorageOptions): Promise<TokenData | null> => {
  try {
    const data = await fs.promises.readFile(getTokenFile(options), 'utf8')
    return JSON.parse(data) as TokenData
  } catch {
    return null
  }
}

export const saveAuthConfig = async (config: AuthConfig, options?: TokenStorageOptions): Promise<void> => {
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

    configContent += '\n'
  }

  const configTarget = getConfigFile(options)
  const configTmp = `${configTarget}.tmp`
  await fs.promises.writeFile(configTmp, configContent, {encoding: 'utf8', mode: 0o600})
  await fs.promises.rename(configTmp, configTarget)
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

      if (!workspaceMatch) continue

      config.profiles[profileName] = {
        workspace: workspaceMatch[1],
        workspaceName: workspaceMatch[2]?.trim(),
        workspaceSlug: slugMatch?.[1]?.trim(),
        organizationName: orgMatch?.[1]?.trim(),
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
