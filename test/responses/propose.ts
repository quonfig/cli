import {HttpResponse, http} from 'msw'

import {getApiBase} from '../test-domain-helper.js'

/**
 * Mock `changeRequests.propose` and `changeRequests.get` for the
 * `--propose` / `--cr` tests (qfg-5bjew.37). Response shape copied from
 * app-quonfig src/lib/api/change-request-propose.server.ts at origin/main
 * 0f27b82 (`ProposeChangesResult`). Add these to a command's own mock server
 * with `server.use(...proposeHandlers())`.
 */

export const PROPOSE_WS = 'workspace-123'
export const CR_HEAD_SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'

export const proposeCaptured: {get: any[]; propose: any[]} = {get: [], propose: []}

export const resetProposeCaptured = () => {
  proposeCaptured.get.length = 0
  proposeCaptured.propose.length = 0
}

export const proposeResult = (number = 9, over: Record<string, unknown> = {}) => ({
  changeRequest: {
    number,
    url: `/workspaces/${PROPOSE_WS}/change-requests/${number}`,
    status: 'open',
    branch: `cr/${number}`,
    headSha: CR_HEAD_SHA,
    changes: [{type: 'flag', key: 'feature-flag.simple', summary: ['Development: fallback false -> true']}],
    ...over,
  },
  applied: false,
  message: `Opened change request #${number}. NOT LIVE: nothing changes until someone with rights merges it.`,
})

const route = (name: string) => `${getApiBase()}/api/v1/changeRequests/${name}`

export const orpcErr = (status: number, code: string, message: string, data?: unknown) =>
  HttpResponse.json({json: {defined: false, code, status, message, data}}, {status})

/** A change request detail for `--cr`, with optional files already in it. */
export const crDetail = (files: {after: null | string; path: string}[] = [], over: Record<string, unknown> = {}) => ({
  number: 7,
  url: `/workspaces/${PROPOSE_WS}/change-requests/7`,
  title: 'earlier proposal',
  status: 'open',
  branch: 'cr/7',
  headSha: CR_HEAD_SHA,
  baseSha: 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e',
  proposer: {label: 'Agent', email: null, channel: 'cli'},
  proposedByCaller: true,
  createdAt: '2026-11-18T10:00:00.000Z',
  updatedAt: '2026-11-18T10:00:00.000Z',
  merged: null,
  closed: null,
  description: null,
  mainSha: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
  mergeBase: 'ba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e',
  files: files.map((f) => ({
    path: f.path,
    kind: f.after === null ? 'delete' : 'modify',
    beforeOid: '1'.repeat(40),
    afterOid: f.after === null ? null : '2'.repeat(40),
    before: '{}',
    after: f.after,
  })),
  filesSource: 'main',
  mergeable: true,
  blockedBy: null,
  conflicts: [],
  callerCanMerge: false,
  callerDenials: [],
  callerCanClose: true,
  ...over,
})

export function proposeHandlers(
  opts: {
    detail?: ReturnType<typeof crDetail>
    propose?: (body: any) => Response
  } = {},
) {
  return [
    http.post(route('propose'), async ({request}) => {
      const body = (await request.json()) as {json: any}
      proposeCaptured.propose.push(body.json)
      if (opts.propose) return opts.propose(body.json)
      return HttpResponse.json({json: proposeResult(body.json.changeRequest ?? 9)})
    }),
    http.post(route('get'), async ({request}) => {
      const body = (await request.json()) as {json: any}
      proposeCaptured.get.push(body.json)
      if (body.json.number === 404) return orpcErr(404, 'NOT_FOUND', 'change request #404 not found')
      return HttpResponse.json({json: opts.detail ?? crDetail()})
    }),
  ]
}
