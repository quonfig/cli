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
  const filename = domain !== 'quonfig.com' ? `tokens-${domain.replaceAll('.', '-')}.json` : 'tokens.json'
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
    }
  }
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
  await fs.promises.writeFile(getTokenFile(options), JSON.stringify(tokens, null, 2), 'utf8')
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

    configContent += '\n\n'
  }

  await fs.promises.writeFile(getConfigFile(options), configContent, 'utf8')
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

    // Parse profiles
    const profileRegex = /\[profile\s+(\w+)]\s*\n\s*workspace\s*=\s*([^\s#]+)(?:\s*#\s*(.+))?/g
    let match

    while ((match = profileRegex.exec(data)) !== null) {
      const profileName = match[1]
      const workspace = match[2]
      const workspaceName = match[3]?.trim()

      config.profiles[profileName] = {
        workspace,
        workspaceName,
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
