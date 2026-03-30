import {HttpResponse, http, passthrough} from 'msw'
import {setupServer} from 'msw/node'

import {CannedResponses, getCannedResponse} from '../test-helper.js'

const cannedResponses: CannedResponses = {
  'https://api.goatsofquonfig.com/api/v2/config/assign-variant': [
    [
      {configKey: 'feature-flag.simple', variant: {type: 'bool', value: true}},
      {response: {message: '', newId: '17002327855857830'}},
      200,
    ],
    [
      {configKey: 'my-double-key', variant: {type: 'double', value: 42.1}},
      {response: {message: '', newId: '17002327855857830'}},
      200,
    ],
    [
      {configKey: 'my-string-list-key', variant: {type: 'string_list', value: ['a', 'b', 'c', 'd']}},
      {response: {message: '', newId: '17002327855857830'}},
      200,
    ],
    [
      {configKey: 'my-double-key', variant: {type: 'double', value: 'pumpkin'}},
      {
        _embedded: {
          errors: [
            {
              message:
                'Failed to convert argument [configVariantAssignmentRequest] for value [null] due to: Cannot deserialize value of type `long` from String "pumpkin": not a valid `long` value\n at [Source: UNKNOWN; byte offset: #UNKNOWN] (through reference chain: cloud.prefab.server.models.ConfigVariantAssignmentRequestDTO["variant"])',
              path: '/configVariantAssignmentRequest',
            },
          ],
        },
        _links: {self: {href: '/api/v2/config/assign-variant', templated: false}},
        message: 'Bad Request',
      },
      400,
    ],
  ],
  'https://api.goatsofquonfig.com/api/v2/config/remove-variant': [
    [{configKey: 'jeffreys.test.key.reforge'}, {message: '', newId: '17545727831235982'}, 200],
  ],
}

// GET /all-config-types/v1/metadata - list all configs
const metadataHandler = http.get('https://api.goatsofquonfig.com/all-config-types/v1/metadata', () =>
  HttpResponse.json({
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
  }),
)

// GET /environments/v1 - list environments
const environmentsHandler = http.get('https://api.goatsofquonfig.com/environments/v1', () =>
  HttpResponse.json({
    environments: [
      {id: '5', name: 'Development'},
      {id: '143', name: 'Production'},
      {id: '144', name: 'Staging'},
    ],
  }),
)

// POST /internal/ops/v1/assign-variant - set override
const assignVariantHandler = http.post(
  'https://api.goatsofquonfig.com/internal/ops/v1/assign-variant',
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

// POST /internal/ops/v1/remove-variant - remove override
const removeVariantHandler = http.post(
  'https://api.goatsofquonfig.com/internal/ops/v1/remove-variant',
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
  http.get('https://api.goatsofquonfig.com/api/v2/configs/0', () => passthrough()),
  http.post('https://api.goatsofquonfig.com/api/v2/*', async ({request}) =>
    getCannedResponse(request, cannedResponses).catch(console.error),
  ),
)
