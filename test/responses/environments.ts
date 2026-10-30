import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

// Mock responses for `qfg environments` (qfg-r3a47).
const environmentsResponse = [
  {id: 'env-staging-uuid', name: 'staging', active: true, protected: false},
  {id: 'env-prod-uuid', name: 'production', active: true, protected: true},
  {id: 'env-old-uuid', name: 'old', active: false, deletedAt: 1_700_000_000_000},
  {id: 'env-dev-uuid', name: 'development', active: true, protected: false},
]

export const server = setupServer(
  http.post(`${getApiBase()}/api/v1/environments/list`, () => HttpResponse.json({json: environmentsResponse})),
)
