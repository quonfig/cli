import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {getDomain} from './domain-urls.js'

const BUFFER_MS = 5 * 60 * 1000 // 5 minutes

const getQuonfigDir = () => path.join(os.homedir(), '.quonfig')

const getGiteaTokenFile = () => {
  const domain = getDomain()
  const filename =
    domain !== 'quonfig.com' ? `gitea-tokens-${domain.replaceAll('.', '-')}.json` : 'gitea-tokens.json'
  return path.join(getQuonfigDir(), filename)
}

export interface GiteaTokenEntry {
  token: string
  repoUrl: string // authenticated clone URL
  expiresAt: string | null
}

type GiteaTokenStore = Record<string, GiteaTokenEntry>

const ensureQuonfigDir = async (): Promise<void> => {
  const dir = getQuonfigDir()
  try {
    await fs.promises.access(dir, fs.constants.F_OK)
  } catch {
    await fs.promises.mkdir(dir, {recursive: true})
  }
}

const loadStore = async (): Promise<GiteaTokenStore> => {
  try {
    const data = await fs.promises.readFile(getGiteaTokenFile(), 'utf8')
    return JSON.parse(data) as GiteaTokenStore
  } catch {
    return {}
  }
}

export const loadGiteaToken = async (workspaceId: string): Promise<GiteaTokenEntry | null> => {
  const store = await loadStore()
  return store[workspaceId] ?? null
}

export const saveGiteaToken = async (workspaceId: string, entry: GiteaTokenEntry): Promise<void> => {
  await ensureQuonfigDir()
  const store = await loadStore()
  store[workspaceId] = entry
  await fs.promises.writeFile(getGiteaTokenFile(), JSON.stringify(store, null, 2), 'utf8')
}

export const isGiteaTokenExpired = (entry: GiteaTokenEntry): boolean => {
  if (!entry.expiresAt) return false
  return new Date(entry.expiresAt).getTime() - BUFFER_MS < Date.now()
}
