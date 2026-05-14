/**
 * LaunchDarkly REST API client — Phase-1 config snapshot.
 *
 * LaunchDarkly has no bulk "export everything" endpoint, so the fetcher
 * stitches per-resource calls: environments, context-kinds, flags (full
 * per-env targeting via `?summary=0&env=`), and segments (per environment).
 *
 * Auth is a raw API token in the `Authorization` header — no `Bearer` prefix.
 * Rate limiting is a per-account rolling 10-second window with an unpublished
 * limit, so we program against the headers: back off on 429 using
 * `X-Ratelimit-Reset` (epoch-ms), pre-throttle on `X-Ratelimit-Global-Remaining`.
 */

import type {
  LDContextKindsResponse,
  LDEnvironmentsResponse,
  LDFlag,
  LDFlagsResponse,
  LDSegment,
  LDSegmentsResponse,
  LDSnapshot,
} from './types.js'

const PROD_BASE_URL = 'https://app.launchdarkly.com/api/v2'
const PAGE_LIMIT = 20
/** Below this many remaining requests we pre-throttle to avoid a 429 storm. */
const RATE_LIMIT_FLOOR = 5
/** Fallback wait when a 429 carries no usable reset header. */
const DEFAULT_BACKOFF_MS = 2000
/** Hard cap on retries for a single request before we give up. */
const MAX_RETRIES = 6

let baseUrl = PROD_BASE_URL

export function setLaunchDarklyBaseUrl(url: string): void {
  baseUrl = url
}

export function selectLaunchDarklyBaseUrl(): string {
  return process.env.LAUNCHDARKLY_API_URL ?? PROD_BASE_URL
}

export function applyLaunchDarklyBaseUrl(): void {
  baseUrl = selectLaunchDarklyBaseUrl()
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

export class LaunchDarklyApiError extends Error {
  public readonly status: number

  constructor(status: number, statusText: string, url: string, body: string) {
    super(`LaunchDarkly API request failed: ${status} ${statusText} — ${url}\n${body}`)
    this.name = 'LaunchDarklyApiError'
    this.status = status
  }
}

/** Wait derived from a 429 response's rate-limit headers. */
function backoffMsFromHeaders(headers: Headers): number {
  const reset = headers.get('X-Ratelimit-Reset')
  if (reset) {
    const resetMs = Number(reset)
    if (Number.isFinite(resetMs)) {
      // Header is an absolute epoch-ms timestamp; wait until then (clamped ≥ 0).
      return Math.max(0, resetMs - Date.now())
    }
  }

  return DEFAULT_BACKOFF_MS
}

/**
 * Single GET with header auth, 429 backoff against `X-Ratelimit-Reset`, and a
 * pre-throttle when `X-Ratelimit-Global-Remaining` runs low. Non-429 errors
 * throw immediately — only rate limiting is retried.
 */
async function apiFetch(path: string, apiKey: string): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: apiKey,
      },
    })

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        // eslint-disable-next-line no-await-in-loop
        const body = await res.text().catch(() => '(no body)')
        throw new LaunchDarklyApiError(429, res.statusText, url, body)
      }

      // eslint-disable-next-line no-await-in-loop
      await sleepImpl(backoffMsFromHeaders(res.headers))
      continue
    }

    if (!res.ok) {
      // eslint-disable-next-line no-await-in-loop
      const body = await res.text().catch(() => '(no body)')
      throw new LaunchDarklyApiError(res.status, res.statusText, url, body)
    }

    // Pre-throttle: if the account-wide budget is nearly spent, pause briefly
    // before the next call rather than walking straight into a 429.
    const remaining = res.headers.get('X-Ratelimit-Global-Remaining')
    if (remaining !== null && Number(remaining) <= RATE_LIMIT_FLOOR) {
      // eslint-disable-next-line no-await-in-loop
      await sleepImpl(backoffMsFromHeaders(res.headers))
    }

    return res.json()
  }

  // Unreachable — the loop either returns or throws.
  throw new LaunchDarklyApiError(429, 'Too Many Requests', url, 'retries exhausted')
}

/**
 * Walks an offset-paginated collection endpoint. LaunchDarkly returns a
 * `_links.next.href` while more pages remain; we stop when it is absent or a
 * short page is returned.
 */
async function paginate<TItem, TResponse extends {_links?: {next?: {href: string}}; items: TItem[]}>(
  firstPath: string,
  apiKey: string,
): Promise<TItem[]> {
  const collected: TItem[] = []
  let path: string | undefined = firstPath
  const seen = new Set<string>()

  while (path && !seen.has(path)) {
    seen.add(path)
    // eslint-disable-next-line no-await-in-loop
    const page = (await apiFetch(path, apiKey)) as TResponse
    if (Array.isArray(page.items)) collected.push(...page.items)

    const next = page._links?.next?.href
    // `next.href` is server-relative ("/api/v2/..."); strip the shared prefix
    // so it composes with our configurable base URL.
    path = next ? next.replace(/^\/api\/v2/, '') : undefined
    if (page.items.length < PAGE_LIMIT) break
  }

  return collected
}

/** Probe used by `validateAuth` — a cheap authenticated call that 401s on a bad token. */
export async function fetchProjectEnvironments(apiKey: string, projectKey: string): Promise<string[]> {
  const items = await paginate<{key: string; name: string}, LDEnvironmentsResponse>(
    `/projects/${encodeURIComponent(projectKey)}/environments?limit=${PAGE_LIMIT}`,
    apiKey,
  )
  return items.map((e) => e.key)
}

export async function fetchContextKinds(apiKey: string, projectKey: string): Promise<string[]> {
  const data = (await apiFetch(
    `/projects/${encodeURIComponent(projectKey)}/context-kinds`,
    apiKey,
  )) as LDContextKindsResponse
  return Array.isArray(data.items) ? data.items.map((k) => k.key) : []
}

/**
 * Full per-environment flag targeting. `?summary=0` plus repeated `?env=`
 * returns rules, clauses, targets, fallthrough, offVariation, prerequisites
 * and rollouts for every named environment in one response — there is no
 * "all environments" wildcard, so env keys are templated in explicitly.
 */
export async function fetchFlags(apiKey: string, projectKey: string, envKeys: string[]): Promise<LDFlag[]> {
  const params = new URLSearchParams({limit: String(PAGE_LIMIT), summary: '0'})
  for (const env of envKeys) params.append('env', env)
  return paginate<LDFlag, LDFlagsResponse>(`/flags/${encodeURIComponent(projectKey)}?${params}`, apiKey)
}

/** Segments are a per-environment resource — caller loops env keys and de-dupes. */
export async function fetchSegmentsForEnv(apiKey: string, projectKey: string, envKey: string): Promise<LDSegment[]> {
  return paginate<LDSegment, LDSegmentsResponse>(
    `/segments/${encodeURIComponent(projectKey)}/${encodeURIComponent(envKey)}?limit=${PAGE_LIMIT}`,
    apiKey,
  )
}

/**
 * Stitches the whole Phase-1 snapshot: environments → context-kinds → flags
 * (one call, all envs) → segments (per env, de-duplicated by key). This is the
 * ~60-call "fast, lossless for current state" path; it always re-fetches
 * everything (decision D2 — we do not trust the LD audit cursor for deltas).
 */
export async function fetchSnapshot(apiKey: string, projectKey: string): Promise<LDSnapshot> {
  const environments = await fetchProjectEnvironments(apiKey, projectKey)
  const contextKinds = await fetchContextKinds(apiKey, projectKey)
  const flags = await fetchFlags(apiKey, projectKey, environments)

  const segmentsByKey = new Map<string, LDSegment>()
  for (const envKey of environments) {
    // eslint-disable-next-line no-await-in-loop
    const segs = await fetchSegmentsForEnv(apiKey, projectKey, envKey)
    for (const seg of segs) {
      // First env to define a segment wins; LD segments are per-env but the
      // key is stable, and v1 imports one shell per key (plan §5.4).
      if (!segmentsByKey.has(seg.key)) segmentsByKey.set(seg.key, seg)
    }
  }

  return {
    contextKinds,
    environments,
    flags,
    segments: [...segmentsByKey.values()],
  }
}
