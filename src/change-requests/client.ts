/**
 * HTTP client for the internal change-request routes (qfg-5bjew.15). Same
 * transport and auth as `configs.gitPush` (config-push-client.ts): POST
 * `${apiUrl}/api/v1/changeRequests/<route>` with `{json: input}` and a
 * Bearer token (WorkOS JWT, or `QUONFIG_API_KEY`).
 */

import type {
  ChangeRequestCloseResult,
  ChangeRequestDetail,
  ChangeRequestMergeResult,
  ChangeRequestSummary,
} from './types.js'

import {getApiUrl} from '../util/domain-urls.js'
import {getValidAccessTokenForOrgSlug} from '../util/get-valid-token.js'

/** A non-2xx answer from a change-request route, with the oRPC error fields. */
export class ChangeRequestApiError extends Error {
  code: string | undefined
  data: Record<string, unknown> | undefined
  status: number

  constructor(status: number, message: string, code?: string, data?: unknown) {
    super(message)
    this.name = 'ChangeRequestApiError'
    this.status = status
    this.code = code
    this.data = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined
  }
}

type Route = 'close' | 'get' | 'list' | 'merge'

export async function postChangeRequestRoute<T>(
  route: Route,
  input: Record<string, unknown>,
  orgSlug: string,
): Promise<T> {
  const accessToken = await getValidAccessTokenForOrgSlug(orgSlug)
  const res = await fetch(`${getApiUrl()}/api/v1/changeRequests/${route}`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({json: input}),
  })

  const text = await res.text().catch(() => '')
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }

  const unwrapped =
    body && typeof body === 'object' && 'json' in (body as Record<string, unknown>)
      ? (body as {json: unknown}).json
      : body

  if (res.ok) return unwrapped as T

  const err = (unwrapped && typeof unwrapped === 'object' ? unwrapped : {}) as {
    code?: unknown
    data?: unknown
    message?: unknown
  }
  const message = typeof err.message === 'string' && err.message ? err.message : text || `HTTP ${res.status}`
  throw new ChangeRequestApiError(res.status, message, typeof err.code === 'string' ? err.code : undefined, err.data)
}

export interface ListInput {
  limit?: number
  mine?: boolean
  status?: 'all' | 'closed' | 'merged' | 'open'
  workspaceId: string
}

export const listChangeRequests = (input: ListInput, orgSlug: string) =>
  postChangeRequestRoute<{changeRequests: ChangeRequestSummary[]}>('list', {...input}, orgSlug)

export const getChangeRequest = (
  input: {branch: string; workspaceId: string} | {number: number; workspaceId: string},
  orgSlug: string,
) => postChangeRequestRoute<ChangeRequestDetail>('get', {...input}, orgSlug)

export const mergeChangeRequest = (
  input: {expectedHeadSha: string; number: number; workspaceId: string},
  orgSlug: string,
) => postChangeRequestRoute<ChangeRequestMergeResult>('merge', {...input}, orgSlug)

export const closeChangeRequest = (input: {note?: string; number: number; workspaceId: string}, orgSlug: string) =>
  postChangeRequestRoute<ChangeRequestCloseResult>('close', {...input}, orgSlug)
