/**
 * Flagsmith REST API client — Phase-1 config snapshot.
 *
 * Flagsmith has no bulk-export endpoint, so the fetcher stitches per-resource
 * calls: project → environments → features → per-env featurestates → segments
 * → feature-segments (priority) → edge identities → edge identity overrides
 * → tags.
 *
 * Auth is `Authorization: Api-Key <token>` — note the `Api-Key` prefix (not
 * `Bearer`, and not bare-token like LaunchDarkly). Rate-limiting headers are
 * unpublished; we program against the response: back off on 429 using
 * `Retry-After` (standard) or `X-RateLimit-Reset` (Flagsmith's variant), and
 * step the inter-request throttle up briefly when we hit one (mirrors the
 * Phase-2 generator's empirical backoff loop). On any non-429 error we throw
 * immediately — only rate limiting is retried.
 *
 * Pagination is standard Django REST `{count, next, previous, results}` with
 * absolute `next` URLs. Edge-identities listing is the one exception: it uses
 * `{results, last_evaluated_key}` cursor pagination via a query-string param.
 */

import type {
  FlagsmithEdgeIdentity,
  FlagsmithEdgeIdentityListResponse,
  FlagsmithEdgeIdentityOverride,
  FlagsmithEnvironment,
  FlagsmithFeature,
  FlagsmithFeatureSegment,
  FlagsmithFeatureState,
  FlagsmithFeatureStateBundle,
  FlagsmithFeatureWithStates,
  FlagsmithPaginated,
  FlagsmithProject,
  FlagsmithSegment,
  FlagsmithSnapshot,
  FlagsmithTag,
} from './types.js'

const PROD_BASE_URL = 'https://api.flagsmith.com/api/v1'
/** Page size for Django REST endpoints that accept `page_size`. Conservative for memory + 429 risk. */
const PAGE_LIMIT = 100
/** Fallback wait when a 429 carries no usable headers. Mirrors the Phase-2 generator's base. */
const DEFAULT_BACKOFF_MS = 2000
/** Hard cap on retries per request before we give up. */
const MAX_RETRIES = 6

let baseUrl = PROD_BASE_URL

export function setFlagsmithBaseUrl(url: string): void {
  baseUrl = url
}

export function selectFlagsmithBaseUrl(): string {
  return process.env.FLAGSMITH_API_URL ?? PROD_BASE_URL
}

export function applyFlagsmithBaseUrl(): void {
  baseUrl = selectFlagsmithBaseUrl()
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

export class FlagsmithApiError extends Error {
  public readonly status: number

  constructor(status: number, statusText: string, url: string, body: string) {
    super(`Flagsmith API request failed: ${status} ${statusText} — ${url}\n${body}`)
    this.name = 'FlagsmithApiError'
    this.status = status
  }
}

/**
 * Compute the wait derived from a 429 response's headers.
 *
 * Flagsmith honours the standard `Retry-After` (seconds) and also sometimes
 * sends `X-RateLimit-Reset` — which the Phase-2 generator observed as either
 * seconds-from-now OR an epoch-ms timestamp. Heuristic: > 10^10 means
 * epoch-ms. We bump the wait UP for either signal (never down) so a tight
 * 429 storm doesn't burn through the retry budget faster than the API wants.
 */
function backoffMsFromHeaders(headers: Headers, attempt: number): number {
  // Exponential base: 2s, 4s, 8s, 16s, 32s, 60s (clamped).
  let wait = Math.min(60_000, 2000 * 2 ** attempt)

  const retryAfter = headers.get('Retry-After')
  if (retryAfter !== null) {
    const sec = Number(retryAfter)
    if (Number.isFinite(sec)) wait = Math.max(wait, sec * 1000)
  }

  const reset = headers.get('X-RateLimit-Reset') ?? headers.get('X-Ratelimit-Reset')
  if (reset !== null) {
    const n = Number(reset)
    if (Number.isFinite(n)) {
      // > 10^10 ⇒ epoch ms; ≤ 10^10 ⇒ seconds-from-now.
      const ms = n > 1e10 ? Math.max(0, n - Date.now()) : n * 1000
      wait = Math.max(wait, ms + 500)
    }
  }

  return Math.min(60_000, wait)
}

/**
 * Single GET with `Api-Key` auth, 429 backoff against `Retry-After` /
 * `X-RateLimit-Reset`, and an exponential fallback. Non-429 errors throw
 * immediately — only rate limiting is retried.
 */
export async function apiFetch(path: string, apiKey: string): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Api-Key ${apiKey}`,
      },
    })

    if (res.status === 429) {
      if (attempt === MAX_RETRIES) {
        // eslint-disable-next-line no-await-in-loop
        const body = await res.text().catch(() => '(no body)')
        throw new FlagsmithApiError(429, res.statusText, url, body)
      }

      // eslint-disable-next-line no-await-in-loop
      await sleepImpl(backoffMsFromHeaders(res.headers, attempt) || DEFAULT_BACKOFF_MS)
      continue
    }

    if (!res.ok) {
      // eslint-disable-next-line no-await-in-loop
      const body = await res.text().catch(() => '(no body)')
      throw new FlagsmithApiError(res.status, res.statusText, url, body)
    }

    return res.json()
  }

  // Unreachable — the loop either returns or throws.
  throw new FlagsmithApiError(429, 'Too Many Requests', url, 'retries exhausted')
}

/**
 * Walks a Django-REST paginated collection. The first page is fetched at
 * `firstPath`; subsequent pages follow the absolute `next` URL until null.
 * Flagsmith's `next` is a full `https://api.flagsmith.com/...` URL; `apiFetch`
 * treats absolute URLs as-is, so this works under the configurable base URL
 * for tests (we strip the production host off so the test base URL applies).
 */
async function paginate<T>(firstPath: string, apiKey: string): Promise<T[]> {
  const collected: T[] = []
  let nextPath: string | undefined = firstPath
  const seen = new Set<string>()

  while (nextPath && !seen.has(nextPath)) {
    seen.add(nextPath)
    // eslint-disable-next-line no-await-in-loop
    const page = (await apiFetch(nextPath, apiKey)) as FlagsmithPaginated<T>
    if (Array.isArray(page.results)) collected.push(...page.results)
    nextPath = page.next ? rewriteNextUrl(page.next) : undefined
  }

  return collected
}

/**
 * Flagsmith's `next` field is the full production URL. For tests we point at
 * `https://flagsmith.test/api/v1` via setFlagsmithBaseUrl; strip the prod
 * host so the next-page fetch goes through the test server too.
 */
function rewriteNextUrl(next: string): string {
  if (baseUrl === PROD_BASE_URL) return next
  if (next.startsWith(PROD_BASE_URL)) return baseUrl + next.slice(PROD_BASE_URL.length)
  return next
}

/** `GET /projects/{id}/` — used as the cheap auth probe AND as a source of `use_edge_identities`. */
export async function fetchProject(apiKey: string, projectId: number | string): Promise<FlagsmithProject> {
  return apiFetch(`/projects/${encodeURIComponent(String(projectId))}/`, apiKey) as Promise<FlagsmithProject>
}

/** `GET /environments/?project={id}` — paginated env list. */
export async function fetchEnvironments(apiKey: string, projectId: number | string): Promise<FlagsmithEnvironment[]> {
  const qs = new URLSearchParams({page_size: String(PAGE_LIMIT), project: String(projectId)})
  return paginate<FlagsmithEnvironment>(`/environments/?${qs}`, apiKey)
}

/**
 * `GET /projects/{pk}/features/` — paginated feature list. Each result
 * includes inline `multivariate_options[]` which we sort ASC by id (API6) so
 * downstream code sees variations in definition order, not the reverse order
 * the API returns.
 */
export async function fetchFeatures(apiKey: string, projectId: number | string): Promise<FlagsmithFeature[]> {
  const qs = new URLSearchParams({page_size: String(PAGE_LIMIT)})
  const features = await paginate<FlagsmithFeature>(
    `/projects/${encodeURIComponent(String(projectId))}/features/?${qs}`,
    apiKey,
  )
  for (const feature of features) {
    if (Array.isArray(feature.multivariate_options) && feature.multivariate_options.length > 1) {
      feature.multivariate_options = [...feature.multivariate_options].sort((a, b) => a.id - b.id)
    }
  }

  return features
}

/**
 * `GET /features/featurestates/?environment={env_id}` — per-env featurestates.
 *
 * This is the unified listing that returns BOTH env-default rows
 * (`feature_segment == null && identity == null`) AND segment-override rows
 * (`feature_segment != null`). The plan §4.1 suggests
 * `/environments/{api_key}/featurestates/`, but empirically on v2-versioned
 * envs that endpoint silently omits segment-override rows. The
 * `/features/featurestates/?environment=` path is the only read endpoint that
 * returns both on a v2 env, so we use it uniformly across v1 and v2 envs.
 *
 * Identity overrides are NOT in this listing on edge-enabled projects — see
 * `fetchEdgeIdentityOverrides`.
 */
export async function fetchEnvFeatureStates(apiKey: string, envId: number): Promise<FlagsmithFeatureState[]> {
  const qs = new URLSearchParams({environment: String(envId), page_size: String(PAGE_LIMIT)})
  return paginate<FlagsmithFeatureState>(`/features/featurestates/?${qs}`, apiKey)
}

/** `GET /projects/{pk}/segments/` — project-scoped segment pool. */
export async function fetchSegments(apiKey: string, projectId: number | string): Promise<FlagsmithSegment[]> {
  const qs = new URLSearchParams({page_size: String(PAGE_LIMIT)})
  return paginate<FlagsmithSegment>(`/projects/${encodeURIComponent(String(projectId))}/segments/?${qs}`, apiKey)
}

/**
 * `GET /features/feature-segments/?environment={env_id}&feature={feature_id}` —
 * the per-env, per-feature segment priority list. Required by the converter
 * to order the segment-override rules (Quonfig is a strict first-match list).
 *
 * The endpoint REJECTS calls without `feature` (`{feature: ["This field is
 * required."]}`), so we have to walk every feature × env combo. This is N×E
 * calls in the worst case — acceptable for the corpus (~110 features × 2 envs
 * = ~220 calls) and roughly the same order as fetchEnvFeatureStates.
 */
export async function fetchFeatureSegments(
  apiKey: string,
  envId: number,
  featureId: number,
): Promise<FlagsmithFeatureSegment[]> {
  const qs = new URLSearchParams({
    environment: String(envId),
    feature: String(featureId),
    page_size: String(PAGE_LIMIT),
  })
  return paginate<FlagsmithFeatureSegment>(`/features/feature-segments/?${qs}`, apiKey)
}

/**
 * `GET /environments/{api_key}/edge-identities/` — paginated edge-identity
 * listing. Pagination here is CURSOR-based (`last_evaluated_key`) not page
 * numbers — the Flagsmith dynamo-backed edge store can't offset-paginate.
 *
 * The fetcher uses this only to surface identifiers for the report; the
 * actual identity-override featurestates come from
 * `fetchEdgeIdentityOverrides`, which is a one-call-per-env shortcut.
 */
export async function fetchEdgeIdentities(apiKey: string, envApiKey: string): Promise<FlagsmithEdgeIdentity[]> {
  const collected: FlagsmithEdgeIdentity[] = []
  let cursor: null | string = null
  const seen = new Set<string>()
  for (;;) {
    const qs = new URLSearchParams({page_size: String(PAGE_LIMIT)})
    if (cursor !== null) qs.set('last_evaluated_key', cursor)
    // eslint-disable-next-line no-await-in-loop
    const page = (await apiFetch(
      `/environments/${encodeURIComponent(envApiKey)}/edge-identities/?${qs}`,
      apiKey,
    )) as FlagsmithEdgeIdentityListResponse
    if (Array.isArray(page.results)) collected.push(...page.results)
    if (!page.last_evaluated_key || seen.has(page.last_evaluated_key)) break
    seen.add(page.last_evaluated_key)
    cursor = page.last_evaluated_key
  }

  return collected
}

/**
 * `GET /environments/{api_key}/edge-identity-overrides` — every identity
 * override in the env, flat. Each row is `{identifier, identity_uuid,
 * feature_state}` so we can index by feature without walking N identities.
 *
 * Note: the path has NO trailing slash (unlike most Flagsmith paths). This
 * endpoint does not paginate in the verified shape — it returns
 * `{results: [...]}` directly.
 */
export async function fetchEdgeIdentityOverrides(
  apiKey: string,
  envApiKey: string,
): Promise<FlagsmithEdgeIdentityOverride[]> {
  const data = (await apiFetch(`/environments/${encodeURIComponent(envApiKey)}/edge-identity-overrides`, apiKey)) as {
    results?: FlagsmithEdgeIdentityOverride[]
  }
  return Array.isArray(data.results) ? data.results : []
}

/** `GET /projects/{pk}/tags/` — project-scoped tag pool. */
export async function fetchTags(apiKey: string, projectId: number | string): Promise<FlagsmithTag[]> {
  const qs = new URLSearchParams({page_size: String(PAGE_LIMIT)})
  return paginate<FlagsmithTag>(`/projects/${encodeURIComponent(String(projectId))}/tags/?${qs}`, apiKey)
}

/**
 * Stitch the whole Phase-1 snapshot: project → environments → features →
 * per-env featurestates (split into env-default + segment-overrides) → segments
 * → feature-segments (per env, per feature with segment overrides) → edge
 * identity overrides → tags.
 *
 * Walk count grows as 1 (project) + 1 (envs) + 1 (segments) + 1 (tags) + E ×
 * (1 featurestates + 1 edge-id-overrides + S features-with-segov ×
 * feature-segments). For the 110-feature, 2-env, 5 features-with-segov live
 * corpus: ~1 + 1 + 1 + 1 + 2 × (1 + 1 + 5) = ~17 calls. The featurestates
 * endpoint is paginated under 100/page so larger projects multiply that
 * featurestates leg.
 *
 * `sinceEpochMs` is currently unused — decision D2 says Phase 1 is always a
 * full re-snapshot. It survives in the signature so reporting (Epic 5) can
 * compute "what's new since last run" against the same snapshot.
 */
export async function fetchSnapshot(apiKey: string, projectId: number | string): Promise<FlagsmithSnapshot> {
  const project = await fetchProject(apiKey, projectId)
  const environments = await fetchEnvironments(apiKey, projectId)
  const features = await fetchFeatures(apiKey, projectId)
  const segments = await fetchSegments(apiKey, projectId)
  const tags = await fetchTags(apiKey, projectId)

  // Index featurestates by env_api_key, then by feature_id. We split each env's
  // featurestate listing into env-default rows (feature_segment == null) and
  // segment-override rows (feature_segment != null) up-front so the per-feature
  // bundle assembly below is a lookup, not a scan.
  const fsByEnvByFeature = new Map<
    string,
    Map<number, {default: FlagsmithFeatureState | null; segment_overrides: FlagsmithFeatureState[]}>
  >()
  for (const env of environments) {
    // eslint-disable-next-line no-await-in-loop
    const featureStates = await fetchEnvFeatureStates(apiKey, env.id)
    const perFeature = new Map<
      number,
      {default: FlagsmithFeatureState | null; segment_overrides: FlagsmithFeatureState[]}
    >()
    for (const fs of featureStates) {
      const bucket = perFeature.get(fs.feature) ?? {default: null, segment_overrides: []}
      if (fs.feature_segment === null) {
        bucket.default = fs
      } else {
        bucket.segment_overrides.push(fs)
      }

      perFeature.set(fs.feature, bucket)
    }

    fsByEnvByFeature.set(env.api_key, perFeature)
  }

  // Edge-identity overrides indexed by env_api_key → feature_id.
  const idovByEnvByFeature = new Map<string, Map<number, FlagsmithEdgeIdentityOverride[]>>()
  if (project.use_edge_identities) {
    for (const env of environments) {
      // eslint-disable-next-line no-await-in-loop
      const overrides = await fetchEdgeIdentityOverrides(apiKey, env.api_key)
      const byFeature = new Map<number, FlagsmithEdgeIdentityOverride[]>()
      for (const ov of overrides) {
        const list = byFeature.get(ov.feature_state.feature) ?? []
        list.push(ov)
        byFeature.set(ov.feature_state.feature, list)
      }

      idovByEnvByFeature.set(env.api_key, byFeature)
    }
  }

  // feature-segments listing (per env, per feature) for priority. Only fetched
  // for features that actually have segment-override featurestates in this env
  // — saves N×E calls on the common case where most features have no segovs.
  const fsegByEnvByFeature = new Map<string, Map<number, FlagsmithFeatureSegment[]>>()
  for (const env of environments) {
    const perFeature = fsByEnvByFeature.get(env.api_key) ?? new Map()
    const featuresWithSegov: number[] = []
    for (const [featureId, bucket] of perFeature) {
      if (bucket.segment_overrides.length > 0) featuresWithSegov.push(featureId)
    }

    const byFeature = new Map<number, FlagsmithFeatureSegment[]>()
    for (const featureId of featuresWithSegov) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await fetchFeatureSegments(apiKey, env.id, featureId)
      byFeature.set(featureId, rows)
    }

    fsegByEnvByFeature.set(env.api_key, byFeature)
  }

  // Stitch the per-feature bundles together.
  const stitched: FlagsmithFeatureWithStates[] = features.map((feature) =>
    stitchFeatureBundle(feature, environments, fsByEnvByFeature, idovByEnvByFeature, fsegByEnvByFeature),
  )

  return {environments, features: stitched, project, segments, tags}
}

/**
 * For one feature, assemble its per-env bundle. Sorts segment-override
 * featurestates by their `feature_segment` priority (ASC) using the
 * feature-segments lookup, so the converter sees them in evaluation order.
 */
function stitchFeatureBundle(
  feature: FlagsmithFeature,
  environments: FlagsmithEnvironment[],
  fsByEnvByFeature: Map<
    string,
    Map<number, {default: FlagsmithFeatureState | null; segment_overrides: FlagsmithFeatureState[]}>
  >,
  idovByEnvByFeature: Map<string, Map<number, FlagsmithEdgeIdentityOverride[]>>,
  fsegByEnvByFeature: Map<string, Map<number, FlagsmithFeatureSegment[]>>,
): FlagsmithFeatureWithStates {
  const featurestates_by_env: Record<string, FlagsmithFeatureStateBundle> = {}
  const feature_segments_by_env: Record<string, FlagsmithFeatureSegment[]> = {}

  for (const env of environments) {
    const perFeature = fsByEnvByFeature.get(env.api_key) ?? new Map()
    const bucket = perFeature.get(feature.id) ?? {default: null, segment_overrides: []}
    const idov = idovByEnvByFeature.get(env.api_key)?.get(feature.id) ?? []
    const fseg = fsegByEnvByFeature.get(env.api_key)?.get(feature.id) ?? []

    // Sort segment-override featurestates by priority ASC, using the
    // feature_segments table. Each fs.feature_segment is either a number ID or
    // an inline {id, priority, ...} object — handle both.
    const priorityById = new Map<number, number>()
    for (const fs of fseg) priorityById.set(fs.id, fs.priority)
    const sortedSegov = [...bucket.segment_overrides].sort((a, b) => {
      const pa = priorityFor(a, priorityById)
      const pb = priorityFor(b, priorityById)
      return pa - pb
    })

    featurestates_by_env[env.api_key] = {
      default: bucket.default,
      identity_overrides: idov,
      segment_overrides: sortedSegov,
    }
    feature_segments_by_env[env.api_key] = fseg
  }

  return {feature, feature_segments_by_env, featurestates_by_env}
}

/**
 * Resolve a segment-override featurestate's priority. `feature_segment` on the
 * row comes as either a numeric ID (legacy endpoint) or an inline `{id,
 * priority, ...}` object (the `/features/featurestates/` endpoint we use).
 * Fall back to a huge number so an unresolved row sorts last instead of NaN.
 */
function priorityFor(fs: FlagsmithFeatureState, priorityById: Map<number, number>): number {
  const fsRef = fs.feature_segment
  if (fsRef === null || fsRef === undefined) return Number.MAX_SAFE_INTEGER
  if (typeof fsRef === 'object' && typeof fsRef.priority === 'number') return fsRef.priority
  if (typeof fsRef === 'number') {
    const p = priorityById.get(fsRef)
    if (typeof p === 'number') return p
  }

  return Number.MAX_SAFE_INTEGER
}
