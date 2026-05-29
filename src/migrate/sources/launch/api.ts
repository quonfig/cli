import type {LaunchChangeEntry, LaunchChangeHistoryResponse, LaunchProjectEnvironmentsResponse} from './types.js'

const PROD_BASE_URL = 'https://api.reforge.com'
const STAGING_BASE_URL = 'https://api.goatsofreforge.com'
const PAGE_LIMIT = 50

/**
 * Hard cap on retries for a single request before we give up. Mirrors the
 * launchdarkly/flagsmith adapters.
 */
const MAX_RETRIES = 6
/** Fallback wait when a response carries no usable backoff header. */
const DEFAULT_BACKOFF_MS = 2000
/**
 * Politeness pause between history pages. On a large account this endpoint is
 * walked for hundreds of sequential pages; a small fixed delay keeps us from
 * tripping a rate limit. (Reforge sends no rate-budget headers to pre-throttle
 * against, unlike LaunchDarkly/Flagsmith.)
 */
const INTER_PAGE_THROTTLE_MS = 300

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

/** Real timer-backed sleep — swapped out in tests so MSW runs don't actually wait. */
function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Test seam: a no-op sleep is swapped in so MSW tests don't actually wait. */
let sleepImpl: (ms: number) => Promise<void> = timerSleep

export function __setSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn
}

export function __resetSleepForTests(): void {
  sleepImpl = timerSleep
}

/**
 * Only transient errors are retried: 429 (throttling) and 5xx (availability).
 *
 * A 403 is NOT retried. It is either a genuine authorization failure (a bad or
 * under-scoped key) or a hard edge/WAF block — neither clears by waiting, so
 * retrying just burns the whole backoff budget (~2 min) before surfacing the
 * same error. Fail fast with a clear message instead. (Observed: Reforge's
 * edge WAF blocked change-history cursors whose flag key contained certain
 * substrings; that is a server-side rule, fixed upstream, not something the
 * client can retry past.)
 */
function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504
}

/**
 * Exponential backoff with jitter: ~2s, 4s, 8s … clamped to 60s, ±20% jitter
 * so concurrent/retried requests don't resynchronize into the next block. A
 * standard `Retry-After` header, if present, raises (never lowers) the wait.
 */
function backoffMs(headers: Headers, attempt: number): number {
  let wait = Math.min(60_000, DEFAULT_BACKOFF_MS * 2 ** attempt)

  const retryAfter = headers.get('Retry-After')
  if (retryAfter !== null) {
    const sec = Number(retryAfter)
    if (Number.isFinite(sec)) wait = Math.max(wait, sec * 1000)
  }

  // ±20% jitter. Math.random is fine here (not a deterministic-replay context).
  const jitter = wait * 0.2 * (Math.random() * 2 - 1)
  return Math.min(60_000, Math.max(0, Math.round(wait + jitter)))
}

/** Trim a (potentially large HTML) error body so the thrown message stays readable. */
function truncateBody(body: string): string {
  const flat = body.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat
}

/**
 * Single GET with HTTP Basic auth, retrying transient errors (429, 5xx) with
 * exponential backoff. 403 and other non-ok statuses throw immediately — only
 * throttling/availability errors are retried.
 */
async function apiFetch(path: string, apiKey: string): Promise<unknown> {
  const url = `${baseUrl}${path}`
  const token = makeToken(apiKey)

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${token}`,
      },
    })

    if (res.ok) return res.json()

    const retryable = isRetryable(res.status)

    if (retryable && attempt < MAX_RETRIES) {
      // eslint-disable-next-line no-await-in-loop
      await sleepImpl(backoffMs(res.headers, attempt))
      continue
    }

    // eslint-disable-next-line no-await-in-loop
    const body = await res.text().catch(() => '(no body)')
    const hint = retryable ? ` (gave up after ${MAX_RETRIES + 1} attempts)` : ''
    throw new Error(`Launch API request failed: ${res.status} ${res.statusText}${hint} — ${url}\n${truncateBody(body)}`)
  }

  // Unreachable — the loop either returns or throws.
  throw new Error(`Launch API request failed: retries exhausted — ${url}`)
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

export async function fetchAllChangeHistory(
  apiKey: string,
  sinceEpochMs?: number,
  onProgress?: (fetched: number) => void,
): Promise<LaunchChangeEntry[]> {
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

    // Report cumulative progress after each page — pagination is silent and
    // can run for many pages (50 changes/page) on a large account.
    onProgress?.(collected.length)

    if (done || !page.cursor || seenCursors.has(page.cursor)) break
    seenCursors.add(page.cursor)
    cursor = page.cursor

    // Smooth the request burst so we don't trip Reforge's edge rate-limit in
    // the first place (it has no rate-budget headers to pre-throttle against).
    // eslint-disable-next-line no-await-in-loop
    await sleepImpl(INTER_PAGE_THROTTLE_MS)
  }

  return collected.reverse()
}
