import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

/**
 * Mock responses for sdk-key command tests
 */

const environmentsResponse = [
  {id: 'env-prod-uuid', name: 'production', active: true},
  {id: 'env-staging-uuid', name: 'staging', active: true},
]

const sdkKeysListResponse = [
  {
    id: 'key-uuid-1',
    environmentId: 'env-prod-uuid',
    environmentName: 'production',
    keyType: 'backend',
    createdByUserName: 'Alice',
    createdByUserEmail: 'alice@example.com',
    createdAt: '2026-01-15T10:00:00.000Z',
  },
  {
    id: 'key-uuid-2',
    environmentId: 'env-staging-uuid',
    environmentName: 'staging',
    keyType: 'frontend',
    createdByUserName: null,
    createdByUserEmail: null,
    createdAt: '2026-02-20T12:00:00.000Z',
  },
]

const createdKeyResponse = {
  id: 'key-uuid-new',
  environmentId: 'env-prod-uuid',
  environmentName: 'production',
  keyType: 'backend',
  createdByUserName: null,
  createdByUserEmail: null,
  createdAt: '2026-04-11T00:00:00.000Z',
  rawKey: 'qf_sk_production_abcd1234',
}

const listHandler = http.post('https://app.quonfig.com/api/v1/sdkKeys/list', () =>
  HttpResponse.json({json: sdkKeysListResponse}),
)

const environmentsHandler = http.post('https://app.quonfig.com/api/v1/environments/list', () =>
  HttpResponse.json({json: environmentsResponse}),
)

const createHandler = http.post('https://app.quonfig.com/api/v1/sdkKeys/create', () =>
  HttpResponse.json({json: createdKeyResponse}),
)

const deleteHandler = http.post('https://app.quonfig.com/api/v1/sdkKeys/delete', () =>
  HttpResponse.json({json: {ok: true}}),
)

const deleteNotFoundHandler = http.post('https://app.quonfig.com/api/v1/sdkKeys/delete', () =>
  HttpResponse.json({message: 'Not Found'}, {status: 404}),
)

export const server = setupServer(listHandler, environmentsHandler, createHandler, deleteHandler)
export {createdKeyResponse, deleteNotFoundHandler, sdkKeysListResponse}
