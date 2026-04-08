import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'


/**
 * Mock responses for set-default command tests
 * Uses oRPC API endpoints via https://app.quonfig.com
 */

// Shared metadata response
const metadataResponse = {
  configs: [
    {
      key: 'feature-flag.simple',
      type: 'feature_flag',
      valueType: 'bool',
      version: 1,
      id: 1001,
      name: 'Simple Feature Flag',
      description: 'A simple boolean feature flag',
    },
    {
      key: 'jeffreys.test.key.reforge',
      type: 'config',
      valueType: 'string',
      version: 2,
      id: 1002,
      name: "Jeffrey's Test Config",
      description: 'A test string config',
    },
    {
      key: 'jeffreys.test.int',
      type: 'config',
      valueType: 'int',
      version: 1,
      id: 1003,
      name: "Jeffrey's Int Config",
      description: 'A test int config',
    },
    {
      key: 'robocop-secret',
      type: 'config',
      valueType: 'string',
      version: 1,
      id: 1004,
      name: 'Robocop Secret',
      description: 'A secret config',
    },
    {
      key: 'test.json',
      type: 'config',
      valueType: 'json',
      version: 1,
      id: 1005,
      name: 'Test JSON',
      description: 'A JSON config',
    },
    {
      key: 'quonfig.secrets.encryption.key',
      type: 'config',
      valueType: 'string',
      version: 1,
      id: 1006,
      name: 'Encryption Key',
      description: 'Encryption key for secrets',
    },
  ],
}

// POST /api/v1/metadata/list - list all configs (oRPC wrapped)
const metadataHandler = http.post('https://app.quonfig.com/api/v1/metadata/list', () =>
  HttpResponse.json({json: metadataResponse}),
)

// POST /api/v1/environments/list - list environments (oRPC wrapped)
const environmentsHandler = http.post('https://app.quonfig.com/api/v1/environments/list', () =>
  HttpResponse.json({
    json: [
      {id: '5', name: 'Development', active: true, protected: false},
      {id: '6', name: 'Staging', active: true, protected: false},
      {id: '7', name: 'Production', active: true, protected: true},
    ],
  }),
)

// Shared encryption key config response
const encryptionKeyResponse = {
  key: 'quonfig.secrets.encryption.key',
  type: 'config',
  valueType: 'string',
  default: {
    rules: [
      {
        criteria: [],
        value: {
          provided: {
            source: 'ENV_VAR',
            lookup: 'QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY',
          },
        },
      },
    ],
  },
  environments: [
    {
      id: 6,
      rules: [
        {
          criteria: [],
          value: {
            provided: {
              source: 'ENV_VAR',
              lookup: 'QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY',
            },
          },
        },
      ],
    },
  ],
}

// POST /api/v1/metadata/getByKey - get config by key (oRPC wrapped)
const getByKeyHandler = http.post('https://app.quonfig.com/api/v1/metadata/getByKey', async ({request}) => {
  const body = (await request.json()) as any
  const key = body?.json?.key

  if (key === 'quonfig.secrets.encryption.key') {
    return HttpResponse.json({json: encryptionKeyResponse})
  }

  if (key === 'feature-flag.simple') {
    return HttpResponse.json({
      json: {
        key: 'feature-flag.simple',
        type: 'feature_flag',
        valueType: 'bool',
        default: {
          rules: [
            {
              criteria: [],
              value: {
                type: 'bool',
                value: false,
              },
            },
          ],
        },
      },
    })
  }

  if (key === 'jeffreys.test.key.reforge') {
    return HttpResponse.json({
      json: {
        key: 'jeffreys.test.key.reforge',
        type: 'config',
        valueType: 'string',
        default: {
          rules: [
            {
              criteria: [],
              value: {
                type: 'string',
                value: 'default value',
              },
            },
          ],
        },
      },
    })
  }

  if (key === 'jeffreys.test.int') {
    return HttpResponse.json({
      json: {
        key: 'jeffreys.test.int',
        type: 'config',
        valueType: 'int',
        default: {
          rules: [
            {
              criteria: [],
              value: {
                type: 'int',
                value: 42,
              },
            },
          ],
        },
      },
    })
  }

  if (key === 'test.json') {
    return HttpResponse.json({
      json: {
        key: 'test.json',
        type: 'config',
        valueType: 'json',
        default: {
          rules: [
            {
              criteria: [],
              value: {
                type: 'json',
                value: {test: 'data'},
              },
            },
          ],
        },
      },
    })
  }

  if (key === 'robocop-secret') {
    return HttpResponse.json({
      json: {
        key: 'robocop-secret',
        type: 'config',
        valueType: 'string',
        default: {
          rules: [
            {
              criteria: [],
              value: {
                type: 'string',
                value: 'encrypted-value-here',
                confidential: true,
                decryptWith: 'quonfig.secrets.encryption.key',
              },
            },
          ],
        },
      },
    })
  }

  return HttpResponse.json({json: {error: 'Not found'}}, {status: 404})
})

// POST /internal/ops/v1/set-default - set default value (NOT oRPC, no json wrapper)
const setDefaultHandler = http.post('https://app.quonfig.com/internal/ops/v1/set-default', async ({request}) => {
  const body = (await request.json()) as any

  // Validate the request (allow environmentId: 0 for default environment)
  if (!body.configKey || body.currentVersionId === undefined) {
    return HttpResponse.json({error: 'Missing required fields'}, {status: 400})
  }

  // Check for invalid boolean values
  if (body.configKey === 'feature-flag.simple' && body.value?.type === 'string') {
    // String value for boolean flag is invalid
    return HttpResponse.json(
      {error: `'${body.value.value}' is not a valid value for feature-flag.simple`},
      {status: 400},
    )
  }

  // Check for invalid int values
  if (body.configKey === 'jeffreys.test.int' && body.value?.type === 'string') {
    // Non-integer value for int config
    return HttpResponse.json({error: `Invalid default value for int: ${body.value.value}`}, {status: 400})
  }

  // Validate encrypted values have correct structure
  if (body.value?.confidential && body.value?.decryptWith) {
    // Encrypted values must have type and value fields
    if (!body.value.type) {
      return HttpResponse.json({error: 'Encrypted values must have a type field'}, {status: 400})
    }
    if (body.value.value === undefined) {
      return HttpResponse.json({error: 'Encrypted values must have a value field'}, {status: 400})
    }
  }

  // Success response
  return HttpResponse.json({
    success: true,
    newVersionId: body.currentVersionId + 1,
  })
})

export const server = setupServer(
  metadataHandler,
  environmentsHandler,
  getByKeyHandler,
  setDefaultHandler,
)
