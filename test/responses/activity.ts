import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * Mock responses for activity command tests.
 *
 * The server's activity router returns plain objects; the oRPC HTTP transport
 * wraps them in `{json: ...}`. We mirror that envelope so the CLI's apiClient
 * sees the same shape it would see in production.
 */

export const knownConfigKey = 'my.flag'
export const knownConfigType = 'feature_flag'
export const deletedKey = 'tombstoned.flag'
export const unknownKey = 'never.existed'
export const restoreOnlyDeletedKey = 'soft-deleted.flag'

const FEED_ITEMS = [
  {
    sha: 'aaaaaaaaaaaaaaaa',
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    date: '2026-04-30T10:00:00.000Z',
    action: 'updated',
    configType: 'feature_flag',
    configKey: 'my.flag',
    messages: [{scope: 'rule', message: 'Updated default rule from false to true'}],
  },
  {
    sha: 'bbbbbbbbbbbbbbbb',
    authorName: '',
    authorEmail: 'gitea-bot@quonfig.com',
    date: '2026-04-29T08:30:00.000Z',
    action: 'created',
    configType: 'config',
    configKey: 'request.timeout',
    messages: [{scope: 'config', message: 'Created config "request.timeout"'}],
  },
  {
    sha: 'ccccccccccccccccc',
    authorName: 'Bob',
    authorEmail: 'bob@example.com',
    date: '2026-04-28T07:00:00.000Z',
    action: 'restored',
    configType: 'feature_flag',
    configKey: 'soft-deleted.flag',
    messages: [{scope: 'flag', message: 'Restored flag "soft-deleted.flag"'}],
  },
]

const RICH_HISTORY_ITEMS = [
  {
    sha: 'aaaaaaaaaaaaaaaa',
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    date: '2026-04-30T10:00:00.000Z',
    action: 'updated',
    messages: [{scope: 'rule', message: 'Updated default rule from false to true'}],
  },
  {
    sha: 'ddddddddddddddddd',
    authorName: 'Carol',
    authorEmail: 'carol@example.com',
    date: '2026-04-25T09:00:00.000Z',
    action: 'restored',
    messages: [{scope: 'flag', message: 'Restored flag "my.flag"'}],
  },
  {
    sha: 'eeeeeeeeeeeeeeeee',
    authorName: 'Carol',
    authorEmail: 'carol@example.com',
    date: '2026-04-24T09:00:00.000Z',
    action: 'created',
    messages: [{scope: 'flag', message: 'Created flag "my.flag"'}],
  },
]

const DELETED_ITEMS = [
  {
    configType: 'feature_flag',
    configKey: 'tombstoned.flag',
    deletedBy: 'Alice',
    deletedAt: '2026-04-30T10:00:00.000Z',
  },
  {
    configType: 'config',
    configKey: 'gone.config',
    deletedBy: 'Bob',
    deletedAt: '2026-04-29T08:30:00.000Z',
  },
]

const METADATA_LIST_RESPONSE = {
  configs: [
    {
      key: knownConfigKey,
      type: 'feature_flag',
      valueType: 'bool',
      version: 'aaaaaaaaaaaaaaaa',
      id: 1,
      name: 'My Flag',
      description: '',
    },
    {
      key: 'request.timeout',
      type: 'config',
      valueType: 'int',
      version: 'bbbbbbbbbbbbbbbb',
      id: 2,
      name: 'Request Timeout',
      description: '',
    },
  ],
}

export const feedRequests: Array<Record<string, unknown>> = []
export const richHistoryRequests: Array<Record<string, unknown>> = []
export const restoreRequests: Array<Record<string, unknown>> = []
export const deletionForKeyRequests: Array<Record<string, unknown>> = []

const feedHandler = http.post(`${getApiBase()}/api/v1/activity/getWorkspaceFeed`, async ({request}) => {
  const body = (await request.json()) as {json?: Record<string, unknown>}
  feedRequests.push(body?.json ?? {})
  return HttpResponse.json({json: FEED_ITEMS})
})

const richHistoryHandler = http.post(`${getApiBase()}/api/v1/activity/getRichHistory`, async ({request}) => {
  const body = (await request.json()) as {json?: Record<string, unknown>}
  const input = (body?.json as Record<string, unknown>) ?? {}
  richHistoryRequests.push(input)
  if (input.configKey === knownConfigKey) {
    return HttpResponse.json({json: RICH_HISTORY_ITEMS})
  }
  return HttpResponse.json({json: []})
})

const deletedHandler = http.post(`${getApiBase()}/api/v1/activity/getDeletedItems`, () =>
  HttpResponse.json({json: DELETED_ITEMS}),
)

const metadataListHandler = http.post(`${getApiBase()}/api/v1/metadata/list`, () =>
  HttpResponse.json({json: METADATA_LIST_RESPONSE}),
)

const deletionForKeyHandler = http.post(`${getApiBase()}/api/v1/activity/getDeletionForKey`, async ({request}) => {
  const body = (await request.json()) as {json?: Record<string, unknown>}
  const input = (body?.json as Record<string, unknown>) ?? {}
  deletionForKeyRequests.push(input)
  if (input.configKey === restoreOnlyDeletedKey) {
    return HttpResponse.json({
      json: {
        configType: 'feature_flag',
        configKey: restoreOnlyDeletedKey,
        deletedBy: 'Bob',
        deletedAt: '2026-04-28T07:00:00.000Z',
        commitSha: 'ccccccccccccccccc',
      },
    })
  }
  // Not deleted (or never existed) → null
  return HttpResponse.json({json: null})
})

const restoreHandler = http.post(`${getApiBase()}/api/v1/activity/restoreItem`, async ({request}) => {
  const body = (await request.json()) as {json?: Record<string, unknown>}
  restoreRequests.push((body?.json as Record<string, unknown>) ?? {})
  return HttpResponse.json({
    json: {
      configType: 'feature_flag',
      configKey: restoreOnlyDeletedKey,
      commitSha: 'ffffffffffffffff',
    },
  })
})

export const server = setupServer(
  feedHandler,
  richHistoryHandler,
  deletedHandler,
  metadataListHandler,
  deletionForKeyHandler,
  restoreHandler,
)

export {DELETED_ITEMS, FEED_ITEMS, METADATA_LIST_RESPONSE, RICH_HISTORY_ITEMS}
