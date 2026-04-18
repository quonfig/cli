import type {LaunchChangeEntry, LaunchChangeHistoryResponse, LaunchProjectEnvironmentsResponse} from './types.js'

const PROD_BASE_URL = 'https://api.reforge.com'
const STAGING_BASE_URL = 'https://api.goatsofreforge.com'
const PAGE_LIMIT = 50

let baseUrl = PROD_BASE_URL

export function setLaunchBaseUrl(url: string): void {
  baseUrl = url
}

export function selectLaunchBaseUrl(staging: boolean): string {
  return process.env.LAUNCH_API_URL ?? (staging ? STAGING_BASE_URL : PROD_BASE_URL)
}

export function applyLaunchBaseUrl(staging: boolean): void {
  baseUrl = selectLaunchBaseUrl(staging)
}

function makeToken(apiKey: string): string {
  return Buffer.from(`authuser:${apiKey}`).toString('base64')
}

async function apiFetch(path: string, apiKey: string): Promise<unknown> {
  const url = `${baseUrl}${path}`
  const token = makeToken(apiKey)

  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${token}`,
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '(no body)')
    throw new Error(`Launch API request failed: ${res.status} ${res.statusText} — ${url}\n${body}`)
  }

  return res.json()
}

export async function fetchEnvironments(apiKey: string): Promise<Record<string, string>> {
  const data = (await apiFetch('/api/v1/project-environments', apiKey)) as LaunchProjectEnvironmentsResponse
  const envMap: Record<string, string> = {}
  for (const env of data.envs) {
    envMap[String(env.id)] = env.name
  }

  return envMap
}

export async function fetchChangeHistoryPage(apiKey: string, cursor?: string): Promise<LaunchChangeHistoryResponse> {
  const params = new URLSearchParams({
    expands: 'changedBy',
    includeNewVersion: 'true',
    includeSummary: 'true',
    limit: String(PAGE_LIMIT),
  })

  if (cursor) {
    params.set('cursor', cursor)
  }

  return (await apiFetch(`/api/v1/change-history?${params}`, apiKey)) as LaunchChangeHistoryResponse
}

export async function fetchAllChangeHistory(apiKey: string, sinceEpochMs?: number): Promise<LaunchChangeEntry[]> {
  const collected: LaunchChangeEntry[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let done = false

  while (!done) {
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchChangeHistoryPage(apiKey, cursor)
    if (page.changes.length === 0) break

    for (const change of page.changes) {
      if (sinceEpochMs !== undefined && change.changedAt <= sinceEpochMs) {
        done = true
        break
      }

      collected.push(change)
    }

    if (done || !page.cursor || seenCursors.has(page.cursor)) break
    seenCursors.add(page.cursor)
    cursor = page.cursor
  }

  return collected.reverse()
}
