import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * Mock `changeRequests.list/get/merge/close` (app-quonfig
 * src/lib/orpc/routes/change-requests.ts, qfg-5bjew.15). Shapes copied from
 * change-requests-handler.ts at origin/main 7558963. oRPC wraps bodies in
 * `{json: ...}`; errors are `{json: {code, status, message, data}}`.
 */

export const WS = 'workspace-123'
export const HEAD_SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
export const BASE_SHA = 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e'
export const MAIN_SHA = 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111'
export const MERGE_SHA = 'beefcafe11111111111111111111111111111111'

export const summary = (over: Record<string, unknown> = {}) => ({
  number: 7,
  url: `/workspaces/${WS}/change-requests/7`,
  title: 'cr smoke',
  status: 'open',
  branch: 'cr-smoke',
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
  proposer: {label: 'Dana Kim', email: 'dana@quonfig.test', channel: 'cli'},
  proposedByCaller: false,
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T11:00:00.000Z',
  merged: null,
  closed: null,
  ...over,
})

export const detail = (over: Record<string, unknown> = {}) => ({
  ...summary(),
  description: 'Turns the thing on.',
  mainSha: MAIN_SHA,
  mergeBase: BASE_SHA,
  files: [
    {
      path: 'feature-flags/checkout.json',
      kind: 'modify',
      beforeOid: '1'.repeat(40),
      afterOid: '2'.repeat(40),
      before: '{\n  "key": "checkout",\n  "value": false\n}\n',
      after: '{\n  "key": "checkout",\n  "value": true\n}\n',
    },
  ],
  filesSource: 'main',
  mergeable: true,
  blockedBy: null,
  conflicts: [],
  callerCanMerge: true,
  callerDenials: [],
  callerCanClose: true,
  ...over,
})

export const captured: {list: any[]; get: any[]; merge: any[]; close: any[]} = {list: [], get: [], merge: [], close: []}

export const resetCaptured = () => {
  captured.list.length = 0
  captured.get.length = 0
  captured.merge.length = 0
  captured.close.length = 0
}

export const orpcError = (status: number, code: string, message: string, data?: unknown) =>
  HttpResponse.json({json: {defined: false, code, status, message, data}}, {status})

const base = () => `${getApiBase()}/api/v1/changeRequests`

export const handlers = {
  list: http.post(`${base()}/list`, async ({request}) => {
    const body = (await request.json()) as {json: Record<string, unknown>}
    captured.list.push(body.json)
    return HttpResponse.json({
      json: {changeRequests: [summary(), summary({number: 5, title: 'older', branch: 'b5', status: 'open'})]},
    })
  }),
  get: http.post(`${base()}/get`, async ({request}) => {
    const body = (await request.json()) as {json: Record<string, unknown>}
    captured.get.push(body.json)
    if (body.json.number === 404 || body.json.branch === 'nope') {
      return orpcError(404, 'NOT_FOUND', 'change request #404 not found')
    }
    return HttpResponse.json({json: detail()})
  }),
  merge: http.post(`${base()}/merge`, async ({request}) => {
    const body = (await request.json()) as {json: Record<string, unknown>}
    captured.merge.push(body.json)
    return HttpResponse.json({
      json: {
        number: 7,
        url: `/workspaces/${WS}/change-requests/7`,
        mergeCommitSha: MERGE_SHA,
        mergedAt: '2026-11-13T12:00:00.000Z',
        selfMerged: false,
      },
    })
  }),
  close: http.post(`${base()}/close`, async ({request}) => {
    const body = (await request.json()) as {json: Record<string, unknown>}
    captured.close.push(body.json)
    return HttpResponse.json({
      json: {
        number: 7,
        url: `/workspaces/${WS}/change-requests/7`,
        status: 'closed',
        closedAt: '2026-11-13T12:00:00.000Z',
        branchDeleted: true,
      },
    })
  }),
}

export const server = setupServer(handlers.list, handlers.get, handlers.merge, handlers.close)
