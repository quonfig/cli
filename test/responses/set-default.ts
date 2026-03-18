import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {identityHandler, identityHandlerTestDomain} from '../test-auth-helper.js'

/**
 * Mock responses for set-default command tests
 * Uses v1 API endpoints
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

// GET /all-config-types/v1/metadata - list all configs (both domains)
const metadataHandler = http.get('https://api.*/all-config-types/v1/metadata', () =>
  HttpResponse.json(metadataResponse),
)

// Shared environments response
const environmentsResponse = {
  environments: [
    {id: '5', name: 'Development', active: true, protected: false},
    {id: '6', name: 'Staging', active: true, protected: false},
    {id: '7', name: 'Production', active: true, protected: true},
  ],
}

// GET /environments/v1 - list environments (both domains)
const environmentsHandler = http.get('https://api.*/environments/v1', () => HttpResponse.json(environmentsResponse))

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
            lookup: 'REFORGE_INTEGRATION_TEST_ENCRYPTION_KEY',
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
              lookup: 'REFORGE_INTEGRATION_TEST_ENCRYPTION_KEY',
            },
          },
        },
      ],
    },
  ],
}

// GET /all-config-types/v1/config/:key - get encryption key config (both domains)
const encryptionKeyHandler = http.get('https://api.*/all-config-types/v1/config/quonfig.secrets.encryption.key', () =>
  HttpResponse.json(encryptionKeyResponse),
)

// GET /all-config-types/v1/config/feature-flag.simple - get feature flag details (not encrypted)
const featureFlagDetailsHandler = http.get('https://api.*/all-config-types/v1/config/feature-flag.simple', () =>
  HttpResponse.json({
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
  }),
)

// GET /all-config-types/v1/config/jeffreys.test.key.reforge - get string config details (not encrypted)
const jeffreysTestKeyDetailsHandler = http.get(
  'https://api.*/all-config-types/v1/config/jeffreys.test.key.reforge',
  () =>
    HttpResponse.json({
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
    }),
)

// GET /all-config-types/v1/config/jeffreys.test.int - get int config details (not encrypted)
const jeffreysTestIntDetailsHandler = http.get('https://api.*/all-config-types/v1/config/jeffreys.test.int', () =>
  HttpResponse.json({
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
  }),
)

// GET /all-config-types/v1/config/test.json - get json config details (not encrypted)
const testJsonDetailsHandler = http.get('https://api.*/all-config-types/v1/config/test.json', () =>
  HttpResponse.json({
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
  }),
)

// GET /all-config-types/v1/config/robocop-secret - get robocop secret (has encrypted values)
const robocopSecretHandler = http.get('https://api.*/all-config-types/v1/config/robocop-secret', () =>
  HttpResponse.json({
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
  }),
)

// POST /internal/ops/v1/set-default - set default value
const setDefaultHandler = http.post('https://api.*/internal/ops/v1/set-default', async ({request}) => {
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
  identityHandler,
  identityHandlerTestDomain,
  metadataHandler,
  environmentsHandler,
  encryptionKeyHandler,
  featureFlagDetailsHandler,
  jeffreysTestKeyDetailsHandler,
  jeffreysTestIntDetailsHandler,
  testJsonDetailsHandler,
  robocopSecretHandler,
  setDefaultHandler,
)
