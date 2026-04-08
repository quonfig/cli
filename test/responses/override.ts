import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'


/**
 * Mock responses for override command tests
 * Uses oRPC API endpoints via https://app.quonfig.com
 */

// POST /api/v1/metadata/list - list all configs (oRPC wrapped)
const metadataHandler = http.post('https://app.quonfig.com/api/v1/metadata/list', () =>
  HttpResponse.json({
    json: {
      configs: [
        {
          description: 'A simple boolean feature flag',
          id: 1001,
          key: 'feature-flag.simple',
          name: 'Simple Feature Flag',
          type: 'feature_flag',
          valueType: 'bool',
          version: 1,
        },
        {
          description: 'A test double config',
          id: 1002,
          key: 'my-double-key',
          name: 'My Double Key',
          type: 'config',
          valueType: 'double',
          version: 1,
        },
        {
          description: 'A test string list config',
          id: 1003,
          key: 'my-string-list-key',
          name: 'My String List Key',
          type: 'config',
          valueType: 'string_list',
          version: 1,
        },
        {
          description: 'A test string config',
          id: 1004,
          key: 'jeffreys.test.key.reforge',
          name: "Jeffrey's Test Key",
          type: 'config',
          valueType: 'string',
          version: 2,
        },
      ],
    },
  }),
)

// POST /api/v1/environments/list - list environments (oRPC wrapped)
const environmentsHandler = http.post('https://app.quonfig.com/api/v1/environments/list', () =>
  HttpResponse.json({
    json: [
      {id: '5', name: 'Development'},
      {id: '143', name: 'Production'},
      {id: '144', name: 'Staging'},
    ],
  }),
)

// POST /internal/ops/v1/assign-variant - set override (NOT oRPC, no json wrapper)
const assignVariantHandler = http.post(
  'https://app.quonfig.com/internal/ops/v1/assign-variant',
  async ({request}) => {
    const body = (await request.json()) as any

    // Check for invalid double value (NaN becomes null when JSON stringified)
    if (body.configKey === 'my-double-key' && body.variant?.type === 'double' && body.variant?.value === null) {
      return HttpResponse.json({error: 'Invalid double value'}, {status: 400})
    }

    return HttpResponse.json({
      success: true,
      newVersionId: (body.currentVersionId || 1) + 1,
    })
  },
)

// POST /internal/ops/v1/remove-variant - remove override (NOT oRPC, no json wrapper)
const removeVariantHandler = http.post(
  'https://app.quonfig.com/internal/ops/v1/remove-variant',
  async ({request}) => {
    const body = (await request.json()) as any

    // Check if config has an override (jeffreys.test.key.reforge does, my-double-key doesn't)
    if (body.configKey === 'my-double-key') {
      return HttpResponse.json({message: 'No override found for my-double-key'}, {status: 404})
    }

    return HttpResponse.json({
      success: true,
      newVersionId: (body.currentVersionId || 1) + 1,
    })
  },
)

export const server = setupServer(
  metadataHandler,
  environmentsHandler,
  assignVariantHandler,
  removeVariantHandler,
)
