import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * Mock responses for `qfg contexts search` (qfg-dpzk.2).
 *
 * The server's contexts.searchKeys procedure returns
 * `{contexts: [{key, name, email?}]}` (the same shape as public GET
 * /v1/contexts): `name` is the context's own name property or null, and
 * `email` is present only when the context has one. The oRPC HTTP transport
 * wraps it in `{json: ...}`.
 */

export const CONTEXT_MATCHES = [
  {email: 'ops@formhealth.example', key: 'org_formhealth', name: 'Form Health'},
  {email: 'eu@formhealth.example', key: 'org_formhealth_eu', name: null},
  {key: 'org_formhealth_bare', name: null},
]

/** Queries the mock answers with an empty result. */
export const unknownQuery = 'nobody-by-this-name'
/** Queries the mock answers with a 503. */
export const failingQuery = 'clickhouse-down'

export const searchKeysRequests: Array<Record<string, unknown>> = []

const searchKeysHandler = http.post(`${getApiBase()}/api/v1/contexts/searchKeys`, async ({request}) => {
  const body = (await request.json()) as {json?: Record<string, unknown>}
  const input = body?.json ?? {}
  searchKeysRequests.push(input)
  if (input.query === failingQuery) {
    return HttpResponse.json({json: {code: 'INTERNAL_SERVER_ERROR', message: 'ClickHouse unavailable'}}, {status: 500})
  }
  if (input.query === unknownQuery) {
    return HttpResponse.json({json: {contexts: []}})
  }
  return HttpResponse.json({json: {contexts: CONTEXT_MATCHES}})
})

export const server = setupServer(searchKeysHandler)
