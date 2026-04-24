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
      id: 'staging',
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
    {
      id: 'production',
      rules: [
        {
          criteria: [],
          value: {
            provided: {
              source: 'ENV_VAR',
              lookup: 'QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY_PROD',
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
        commitSha: 'abc001',
        environments: [],
        default: {rules: [{criteria: [], value: {type: 'bool', value: false}}]},
      },
    })
  }

  if (key === 'jeffreys.test.key.reforge') {
    return HttpResponse.json({
      json: {
        key: 'jeffreys.test.key.reforge',
        type: 'config',
        valueType: 'string',
        commitSha: 'abc002',
        environments: [],
        default: {rules: [{criteria: [], value: {type: 'string', value: 'default value'}}]},
      },
    })
  }

  if (key === 'jeffreys.test.int') {
    return HttpResponse.json({
      json: {
        key: 'jeffreys.test.int',
        type: 'config',
        valueType: 'int',
        commitSha: 'abc003',
        environments: [],
        default: {rules: [{criteria: [], value: {type: 'int', value: 42}}]},
      },
    })
  }

  if (key === 'test.json') {
    return HttpResponse.json({
      json: {
        key: 'test.json',
        type: 'config',
        valueType: 'json',
        commitSha: 'abc004',
        environments: [],
        default: {rules: [{criteria: [], value: {type: 'json', value: {test: 'data'}}}]},
      },
    })
  }

  if (key === 'robocop-secret') {
    return HttpResponse.json({
      json: {
        key: 'robocop-secret',
        type: 'config',
        valueType: 'string',
        commitSha: 'abc005',
        environments: [],
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

// POST /api/v1/configs/update — update a config via oRPC
const configsUpdateHandler = http.post('https://app.quonfig.com/api/v1/configs/update', async ({request}) => {
  const body = (await request.json()) as any
  if (!body?.json?.configKey) {
    return HttpResponse.json({json: {error: 'Missing configKey'}}, {status: 400})
  }
  return HttpResponse.json({json: {success: true, key: body.json.configKey}})
})

// POST /api/v1/flags/update — update a flag via oRPC
const flagsUpdateHandler = http.post('https://app.quonfig.com/api/v1/flags/update', async ({request}) => {
  const body = (await request.json()) as any
  if (!body?.json?.flagKey) {
    return HttpResponse.json({json: {error: 'Missing flagKey'}}, {status: 400})
  }
  return HttpResponse.json({json: {success: true, key: body.json.flagKey}})
})

// POST /api/v1/logLevels/update — update a log-level via oRPC
const logLevelsUpdateHandler = http.post('https://app.quonfig.com/api/v1/logLevels/update', async ({request}) => {
  const body = (await request.json()) as any
  if (!body?.json?.logLevelKey) {
    return HttpResponse.json({json: {error: 'Missing logLevelKey'}}, {status: 400})
  }
  return HttpResponse.json({json: {success: true, key: body.json.logLevelKey}})
})

export const server = setupServer(
  metadataHandler,
  environmentsHandler,
  getByKeyHandler,
  configsUpdateHandler,
  flagsUpdateHandler,
  logLevelsUpdateHandler,
)
