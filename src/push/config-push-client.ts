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

import type {
  ConfigPushInput,
  ConfigPushResult,
  GitPushInput,
  GitPushResult,
  PushDenial,
  SuggestedRecovery,
} from './run-push.js'

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

/**
 * Pack-push wire client for `configs.gitPush` (qfg-7429.4). Mirrors
 * `callConfigsPush` shape — same oRPC `{json: ...}` envelope, same
 * status-to-tagged-union mapping. Two differences:
 *
 *   - The pack is base64-encoded so the JSON envelope stays text-safe;
 *     the server-side handler (`git-push-handler.ts`) decodes it via
 *     `Buffer.from(input.pack, 'base64')`.
 *   - 403 denials carry `{commitSha, path, reason, requiredPermission}`
 *     plus an optional `suggestedRecovery` block for the GitHub-fork
 *     dead-end UX (see §6 of the design plan and qfg-7429.5 for the
 *     polished renderer).
 */
export const callConfigsGitPush = async (input: GitPushInput, orgSlug: string): Promise<GitPushResult> => {
  const accessToken = await getValidAccessTokenForOrgSlug(orgSlug)
  const apiUrl = getApiUrl()

  const wirePayload = {
    workspaceId: input.workspaceId,
    targetRef: input.targetRef,
    expectedSha: input.expectedSha,
    newSha: input.newSha,
    pack: Buffer.from(input.pack).toString('base64'),
    hasUpstreamRemote: input.hasUpstreamRemote,
  }

  const res = await fetch(`${apiUrl}/api/v1/configs/gitPush`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({json: wirePayload}),
  })

  if (res.ok) {
    const body = (await res.json()) as OrpcEnvelope<{commitSha: string; ref: string}>
    const commitSha = body.json?.commitSha
    const ref = body.json?.ref
    if (!commitSha || !ref) {
      throw new Error(`configs.gitPush returned 200 but missing commitSha/ref (body=${JSON.stringify(body)})`)
    }
    return {kind: 'success', commitSha, ref}
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
    const denials = extractGitPushDenials(parsed?.data)
    if (denials.length > 0) {
      const suggestedRecovery = extractSuggestedRecovery(parsed?.data)
      return suggestedRecovery ? {kind: 'denied', denials, suggestedRecovery} : {kind: 'denied', denials}
    }
  }

  if (res.status === 409) {
    return {kind: 'conflict', message}
  }

  if (res.status === 400) {
    return {kind: 'bad-request', message}
  }

  throw new Error(`configs.gitPush failed (HTTP ${res.status}): ${message}`)
}

function extractGitPushDenials(
  data: unknown,
): GitPushResult extends infer R ? (R extends {denials: infer D} ? D : never) : never {
  // Narrowing helper: the gitPush handler's denial shape extends the
  // bare-path denial with `commitSha`. Other fields parsed identically.
  if (!data || typeof data !== 'object') return [] as never
  const denials = (data as {denials?: unknown}).denials
  if (!Array.isArray(denials)) return [] as never
  const out: {commitSha: string; path: string; reason: string; requiredPermission: string}[] = []
  for (const raw of denials) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as {
      commitSha?: unknown
      path?: unknown
      reason?: unknown
      requiredPermission?: unknown
    }
    if (typeof r.commitSha !== 'string' || typeof r.path !== 'string' || typeof r.requiredPermission !== 'string')
      continue
    out.push({
      commitSha: r.commitSha,
      path: r.path,
      reason: typeof r.reason === 'string' ? r.reason : `Missing required permission: ${r.requiredPermission}`,
      requiredPermission: r.requiredPermission,
    })
  }
  return out as never
}

function extractSuggestedRecovery(data: unknown): SuggestedRecovery | undefined {
  if (!data || typeof data !== 'object') return undefined
  const sr = (data as {suggestedRecovery?: unknown}).suggestedRecovery
  if (!sr || typeof sr !== 'object') return undefined
  const r = sr as {kind?: unknown; offendingCommitSha?: unknown; message?: unknown}
  if (r.kind !== 'revert-upstream' || typeof r.offendingCommitSha !== 'string' || typeof r.message !== 'string') {
    return undefined
  }
  return {kind: 'revert-upstream', offendingCommitSha: r.offendingCommitSha, message: r.message}
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
