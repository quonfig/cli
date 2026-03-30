import {HttpResponse, http, passthrough} from 'msw'
import {setupServer} from 'msw/node'

import {CannedResponses, SECRET_VALUE, getCannedResponse} from '../test-helper.js'

const recipeResponse = (key: string, defaultValue: boolean = false) => ({
  allowableValues: [{bool: true}, {bool: false}],
  changedBy: {sdkKeyId: '315', email: '', userId: '4'},
  configType: 'FEATURE_FLAG',
  id: '0',
  key,
  projectId: '124',
  rows: [{projectEnvId: '143', values: [{value: {bool: defaultValue}}]}],
  valueType: 'NOT_SET_VALUE_TYPE',
})

const createFlagRequest = (key: string, defaultValue: boolean = false) => ({
  allowableValues: [{bool: true}, {bool: false}],
  changedBy: {sdkKeyId: '315', email: '', userId: '4'},
  configType: 'FEATURE_FLAG',
  id: '0',
  key,
  projectId: '124',
  rows: [{projectEnvId: '143', values: [{value: {bool: defaultValue}}]}],
  valueType: 'NOT_SET_VALUE_TYPE',
})

const createRequest = (key: string, options: Record<string, unknown>) => ({
  configType: 'CONFIG',
  key,
  projectId: 124,
  sendToClientSdk: false,
  valueType: 'STRING',
  ...options,
})

const conflictResponse = {
  _embedded: {
    errors: [{message: 'key `already.in.use` is already in use. Pass existing config id to overwrite'}],
  },
  _links: {self: {href: '/api/v2/config/', templated: false}},
  message: 'Conflict',
}

const successResponse = {
  message: '',
  newId: '17000801114938347',
}

const cannedResponses: CannedResponses = {
  'https://api.goatsofquonfig.com/api/v2/config/': [
    [createFlagRequest('brand.new.flag'), successResponse, 200],
    [createFlagRequest('already.in.use'), conflictResponse, 409],
    [createFlagRequest('new.with.different.default', true), conflictResponse, 200],
    [
      createRequest('brand.new.string', {
        rows: [{properties: {}, values: [{criteria: [], value: {string: 'hello.world'}}]}],
      }),
      successResponse,
      200,
    ],
    [
      createRequest('brand.new.int', {
        configType: 'CONFIG',
        key: 'brand.new.int',
        projectId: 124,
        rows: [{properties: {}, values: [{criteria: [], value: {int: '123'}}]}],
        valueType: 'INT',
      }),
      successResponse,
      200,
    ],
    [
      createRequest('brand.new.double', {
        configType: 'CONFIG',
        key: 'brand.new.double',
        projectId: 124,
        rows: [{properties: {}, values: [{criteria: [], value: {double: 123.99}}]}],
        valueType: 'DOUBLE',
      }),
      successResponse,
      200,
    ],
    [
      createRequest('brand.new.boolean', {
        configType: 'CONFIG',
        key: 'brand.new.boolean',
        projectId: 124,
        rows: [{properties: {}, values: [{criteria: [], value: {bool: false}}]}],
        valueType: 'BOOL',
      }),
      successResponse,
      200,
    ],
    [
      createRequest('brand.new.string-list', {
        configType: 'CONFIG',
        key: 'brand.new.string-list',
        projectId: 124,
        rows: [{properties: {}, values: [{criteria: [], value: {stringList: {values: ['a', 'b', 'c', 'd']}}}]}],
        valueType: 'STRING_LIST',
      }),
      successResponse,
      200,
    ],
    [
      createRequest('brand.new.json', {
        configType: 'CONFIG',
        key: 'brand.new.json',
        projectId: 124,
        rows: [{properties: {}, values: [{criteria: [], value: {json: {json: '{"key": "value"}'}}}]}],
        valueType: 'JSON',
      }),
      successResponse,
      200,
    ],
    [
      createRequest('confidential.new.string', {
        rows: [{properties: {}, values: [{criteria: [], value: {confidential: true, string: 'hello.world'}}]}],
      }),
      successResponse,
      200,
    ],
    [
      createRequest('int.from.env', {
        rows: [{properties: {}, values: [{criteria: [], value: {provided: {lookup: 'MY_INT', source: 'ENV_VAR'}}}]}],
        valueType: 'INT',
      }),
      successResponse,
      200,
    ],
    [
      createRequest('greeting.from.env', {
        rows: [{properties: {}, values: [{criteria: [], value: {provided: {lookup: 'GREETING', source: 'ENV_VAR'}}}]}],
      }),
      successResponse,
      200,
    ],
    [
      createRequest('confidential.greeting.from.env', {
        rows: [
          {
            properties: {},
            values: [{criteria: [], value: {confidential: true, provided: {lookup: 'GREETING', source: 'ENV_VAR'}}}],
          },
        ],
      }),
      successResponse,
      200,
    ],
    [
      createRequest('brand.new.secret', {
        rows: [
          {
            properties: {},
            values: [
              {
                criteria: [],
                value: {
                  confidential: true,
                  decryptWith: 'quonfig.secrets.encryption.key',
                  string: SECRET_VALUE,
                },
              },
            ],
          },
        ],
      }),
      successResponse,
      200,
    ],
    [
      createRequest('secret.with.literal.key', {
        rows: [
          {
            properties: {},
            values: [
              {
                criteria: [],
                value: {
                  confidential: true,
                  decryptWith: 'literal.encryption.key',
                  string: SECRET_VALUE,
                },
              },
            ],
          },
        ],
      }),
      successResponse,
      200,
    ],
    [
      createRequest('secret.with.new.format.key', {
        rows: [
          {
            properties: {},
            values: [
              {
                criteria: [],
                value: {
                  confidential: true,
                  decryptWith: 'new.format.encryption.key',
                  string: SECRET_VALUE,
                },
              },
            ],
          },
        ],
      }),
      successResponse,
      200,
    ],
  ],

  'https://api.goatsofquonfig.com/api/v2/config/key/missing.secret.key': [[{}, {}, 404]],

  'https://api.goatsofquonfig.com/api/v2/config/key/quonfig.secrets.encryption.key': [
    [
      {},
      {
        changedBy: {sdkKeyId: '', email: 'jeffrey.chupp@quonfig.com', userId: '0'},
        configType: 'CONFIG',
        draftId: '497',
        id: '17018809595519854',
        key: 'quonfig.secrets.encryption.key',
        projectId: 100,
        rows: [
          {values: [{value: {provided: {lookup: 'FAKE_PROD_SECRET', source: 'ENV_VAR'}}}]},
          {projectEnvId: '101', values: [{value: {provided: {lookup: 'FAKE_DEFAULT_SECRET', source: 'ENV_VAR'}}}]},
        ],
        valueType: 'STRING',
      },
      200,
    ],
  ],

  'https://api.goatsofquonfig.com/api/v2/config-recipes/feature-flag/boolean': [
    [{defaultValue: false, key: 'brand.new.flag'}, recipeResponse('brand.new.flag'), 200],
    [{defaultValue: false, key: 'already.in.use'}, recipeResponse('already.in.use'), 200],
    [{defaultValue: true, key: 'new.with.different.default'}, recipeResponse('new.with.different.default', true), 200],
  ],
}

// V1 API handlers
const flagsV1Handler = http.post('https://api.goatsofquonfig.com/flags/v1', async ({request}) => {
  const body = (await request.json()) as any

  if (body.key === 'already.in.use') {
    return new Response(JSON.stringify(conflictResponse), {status: 409})
  }

  return new Response(JSON.stringify(successResponse), {status: 200})
})

const flagsV1HandlerProd = http.post('https://api.quonfig.com/flags/v1', async ({request}) => {
  const body = (await request.json()) as any

  if (body.key === 'already.in.use') {
    return new Response(JSON.stringify(conflictResponse), {status: 409})
  }

  return new Response(JSON.stringify(successResponse), {status: 200})
})

const configsV1Handler = http.post('https://api.goatsofquonfig.com/configs/v1', async ({request}) => {
  const body = (await request.json()) as any

  if (body.key === 'already.in.use') {
    return new Response(JSON.stringify(conflictResponse), {status: 409})
  }

  // Validate encrypted values have correct structure
  const defaultValue = body.default?.rules?.[0]?.value
  if (defaultValue?.confidential && defaultValue?.decryptWith) {
    // Encrypted values must have type and value fields
    if (!defaultValue.type) {
      return new Response(JSON.stringify({error: 'Encrypted values must have a type field'}), {status: 400})
    }
    if (defaultValue.value === undefined) {
      return new Response(JSON.stringify({error: 'Encrypted values must have a value field'}), {status: 400})
    }
  }

  return new Response(JSON.stringify(successResponse), {status: 200})
})

const configsV1HandlerProd = http.post('https://api.quonfig.com/configs/v1', async ({request}) => {
  const body = (await request.json()) as any

  if (body.key === 'already.in.use') {
    return new Response(JSON.stringify(conflictResponse), {status: 409})
  }

  // Validate encrypted values have correct structure
  const defaultValue = body.default?.rules?.[0]?.value
  if (defaultValue?.confidential && defaultValue?.decryptWith) {
    // Encrypted values must have type and value fields
    if (!defaultValue.type) {
      return new Response(JSON.stringify({error: 'Encrypted values must have a type field'}), {status: 400})
    }
    if (defaultValue.value === undefined) {
      return new Response(JSON.stringify({error: 'Encrypted values must have a value field'}), {status: 400})
    }
  }

  return new Response(JSON.stringify(successResponse), {status: 200})
})

// GET /all-config-types/v1/metadata - list all configs
const metadataResponse = {
  configs: [
    {key: 'quonfig.secrets.encryption.key', type: 'config'},
    {key: 'literal.encryption.key', type: 'config'},
    {key: 'new.format.encryption.key', type: 'config'},
  ],
}

const metadataHandler = http.get('https://api.goatsofquonfig.com/all-config-types/v1/metadata', () =>
  HttpResponse.json(metadataResponse),
)

const metadataHandlerProd = http.get('https://api.quonfig.com/all-config-types/v1/metadata', () =>
  HttpResponse.json(metadataResponse),
)

// Encryption key config responses
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
}

const literalEncryptionKeyResponse = {
  key: 'literal.encryption.key',
  type: 'config',
  valueType: 'string',
  default: {
    rules: [
      {
        criteria: [],
        value: {
          type: 'string',
          value: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    ],
  },
}

const newFormatEncryptionKeyResponse = {
  key: 'new.format.encryption.key',
  type: 'config',
  valueType: 'string',
  default: {
    rules: [
      {
        criteria: [],
        value: {
          type: 'provided',
          value: {
            source: 'ENV_VAR',
            lookup: 'QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY',
          },
        },
      },
    ],
  },
}

// GET /all-config-types/v1/config/:key - get encryption key config (old format with provided.lookup)
const encryptionKeyHandler = http.get(
  'https://api.goatsofquonfig.com/all-config-types/v1/config/quonfig.secrets.encryption.key',
  () => HttpResponse.json(encryptionKeyResponse),
)

const encryptionKeyHandlerProd = http.get(
  'https://api.quonfig.com/all-config-types/v1/config/quonfig.secrets.encryption.key',
  () => HttpResponse.json(encryptionKeyResponse),
)

// GET /all-config-types/v1/config/literal.encryption.key - encryption key with literal value
const literalEncryptionKeyHandler = http.get(
  'https://api.goatsofquonfig.com/all-config-types/v1/config/literal.encryption.key',
  () => HttpResponse.json(literalEncryptionKeyResponse),
)

const literalEncryptionKeyHandlerProd = http.get(
  'https://api.quonfig.com/all-config-types/v1/config/literal.encryption.key',
  () => HttpResponse.json(literalEncryptionKeyResponse),
)

// GET /all-config-types/v1/config/new.format.encryption.key - encryption key with new type: "provided" format
const newFormatEncryptionKeyHandler = http.get(
  'https://api.goatsofquonfig.com/all-config-types/v1/config/new.format.encryption.key',
  () => HttpResponse.json(newFormatEncryptionKeyResponse),
)

const newFormatEncryptionKeyHandlerProd = http.get(
  'https://api.quonfig.com/all-config-types/v1/config/new.format.encryption.key',
  () => HttpResponse.json(newFormatEncryptionKeyResponse),
)

// GET /all-config-types/v1/config/missing.secret.key - missing encryption key
const missingEncryptionKeyHandler = http.get(
  'https://api.goatsofquonfig.com/all-config-types/v1/config/missing.secret.key',
  () => HttpResponse.json({error: 'Config not found'}, {status: 404}),
)

const missingEncryptionKeyHandlerProd = http.get(
  'https://api.quonfig.com/all-config-types/v1/config/missing.secret.key',
  () => HttpResponse.json({error: 'Config not found'}, {status: 404}),
)

export const server = setupServer(
  flagsV1Handler,
  flagsV1HandlerProd,
  configsV1Handler,
  configsV1HandlerProd,
  metadataHandler,
  metadataHandlerProd,
  encryptionKeyHandler,
  encryptionKeyHandlerProd,
  literalEncryptionKeyHandler,
  literalEncryptionKeyHandlerProd,
  newFormatEncryptionKeyHandler,
  newFormatEncryptionKeyHandlerProd,
  missingEncryptionKeyHandler,
  missingEncryptionKeyHandlerProd,
  http.get('https://api.goatsofquonfig.com/api/v2/configs/0', () => passthrough()),

  http.get('https://api.goatsofquonfig.com/api/v2/*', async ({request}) =>
    getCannedResponse(request, cannedResponses).catch(console.error),
  ),

  http.post('https://api.goatsofquonfig.com/api/v2/*', async ({request}) =>
    getCannedResponse(request, cannedResponses).catch(console.error),
  ),
)
