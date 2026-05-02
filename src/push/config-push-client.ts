/**
 * HTTP client for the `configs.push` oRPC procedure (qfg-azk.13).
 *
 * Server-side spec lives at
 * `app-quonfig/src/lib/orpc/routes/config-push-handler.ts`. We translate the
 * oRPC error shape into a tagged union the CLI can pattern-match on:
 *
 *   - 200 → `{kind: 'success', commitSha}`
 *   - 403 with `data.denials` → `{kind: 'denied', denials}`
 *   - 409 → `{kind: 'conflict', message}`
 *   - 400 → `{kind: 'bad-request', message}`
 *   - anything else → throws so runPush surfaces a generic PushFatalError.
 *
 * The auth header is a WorkOS access token (or a `qf_uk_*` API key when
 * `QUONFIG_API_KEY` is set in the environment); see `getValidAccessToken`.
 */

import type {ConfigPushInput, ConfigPushResult, PushDenial} from './run-push.js'

import {getApiUrl} from '../util/domain-urls.js'
import {getValidAccessTokenForOrgSlug} from '../util/get-valid-token.js'

interface OrpcEnvelope<T> {
  json?: T
}

interface OrpcErrorJson {
  code?: string
  data?: unknown
  message?: string
  status?: number
}

export const callConfigsPush = async (input: ConfigPushInput, orgSlug: string): Promise<ConfigPushResult> => {
  const accessToken = await getValidAccessTokenForOrgSlug(orgSlug)
  const apiUrl = getApiUrl()

  const res = await fetch(`${apiUrl}/api/v1/configs/push`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({json: input}),
  })

  if (res.ok) {
    const body = (await res.json()) as OrpcEnvelope<{commitSha: string}>
    const commitSha = body.json?.commitSha
    if (!commitSha) {
      throw new Error(`configs.push returned 200 but no commitSha (body=${JSON.stringify(body)})`)
    }

    return {kind: 'success', commitSha}
  }

  const text = await res.text().catch(() => '')
  let parsed: OrpcErrorJson | undefined
  try {
    const body = JSON.parse(text) as OrpcEnvelope<OrpcErrorJson> | OrpcErrorJson
    parsed = (body as OrpcEnvelope<OrpcErrorJson>).json ?? (body as OrpcErrorJson)
  } catch {
    /* keep parsed undefined */
  }

  const message = parsed?.message ?? text ?? `HTTP ${res.status}`

  if (res.status === 403) {
    const denials = extractDenials(parsed?.data)
    if (denials.length > 0) {
      return {kind: 'denied', denials}
    }
  }

  if (res.status === 409) {
    return {kind: 'conflict', message}
  }

  if (res.status === 400) {
    return {kind: 'bad-request', message}
  }

  throw new Error(`configs.push failed (HTTP ${res.status}): ${message}`)
}

function extractDenials(data: unknown): PushDenial[] {
  if (!data || typeof data !== 'object') return []
  const denials = (data as {denials?: unknown}).denials
  if (!Array.isArray(denials)) return []
  const out: PushDenial[] = []
  for (const raw of denials) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as {path?: unknown; reason?: unknown; requiredPermission?: unknown}
    if (typeof r.path !== 'string' || typeof r.requiredPermission !== 'string') continue
    out.push({
      path: r.path,
      reason: typeof r.reason === 'string' ? r.reason : `Missing required permission: ${r.requiredPermission}`,
      requiredPermission: r.requiredPermission,
    })
  }

  return out
}
