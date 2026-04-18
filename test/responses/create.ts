import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

const conflictResponse = {
  message: 'Conflict',
  error: 'already exists',
}

const successResponse = {
  message: '',
  newId: '17000801114938347',
}

// POST /api/v1/flags/create - create boolean flags (oRPC wrapped)
const flagsCreateHandler = http.post('https://app.quonfig.com/api/v1/flags/create', async ({request}) => {
  const body = (await request.json()) as any
  const input = body?.json
  const key = input?.flag?.key

  if (key === 'already.in.use') {
    return HttpResponse.json({json: conflictResponse}, {status: 409})
  }

  return HttpResponse.json({json: successResponse})
})

// Capture last create-config payload so tests can assert on the exact request body
// the CLI sends (not just stdout). Cleared between tests via resetCapturedCreatePayload.
export let capturedCreateConfigInput: any = null

export function resetCapturedCreateConfigInput(): void {
  capturedCreateConfigInput = null
}

// POST /api/v1/configs/create - create configs (oRPC wrapped)
const configsCreateHandler = http.post('https://app.quonfig.com/api/v1/configs/create', async ({request}) => {
  const body = (await request.json()) as any
  const input = body?.json
  capturedCreateConfigInput = input
  const key = input?.config?.key

  if (key === 'already.in.use') {
    return HttpResponse.json({json: conflictResponse}, {status: 409})
  }

  // Validate encrypted values have correct structure
  const defaultValue = input?.config?.default?.rules?.[0]?.value
  if (defaultValue?.confidential && defaultValue?.decryptWith) {
    // Encrypted values must have type and value fields
    if (!defaultValue.type) {
      return HttpResponse.json({json: {error: 'Encrypted values must have a type field'}}, {status: 400})
    }
    if (defaultValue.value === undefined) {
      return HttpResponse.json({json: {error: 'Encrypted values must have a value field'}}, {status: 400})
    }
  }

  return HttpResponse.json({json: successResponse})
})

// Metadata response for encryption key checks
const metadataResponse = {
  configs: [
    {key: 'quonfig.secrets.encryption.key', type: 'config'},
    {key: 'literal.encryption.key', type: 'config'},
    {key: 'new.format.encryption.key', type: 'config'},
  ],
}

// POST /api/v1/metadata/list - list all configs for encryption key check (oRPC wrapped)
const metadataHandler = http.post('https://app.quonfig.com/api/v1/metadata/list', () =>
  HttpResponse.json({json: metadataResponse}),
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

// POST /api/v1/metadata/getByKey - get config by key for encryption (oRPC wrapped)
const getByKeyHandler = http.post('https://app.quonfig.com/api/v1/metadata/getByKey', async ({request}) => {
  const body = (await request.json()) as any
  const key = body?.json?.key

  if (key === 'quonfig.secrets.encryption.key') {
    return HttpResponse.json({json: encryptionKeyResponse})
  }

  if (key === 'literal.encryption.key') {
    return HttpResponse.json({json: literalEncryptionKeyResponse})
  }

  if (key === 'new.format.encryption.key') {
    return HttpResponse.json({json: newFormatEncryptionKeyResponse})
  }

  if (key === 'missing.secret.key') {
    return HttpResponse.json({json: {error: 'Config not found'}}, {status: 404})
  }

  return HttpResponse.json({json: {error: 'Config not found'}}, {status: 404})
})

export const server = setupServer(flagsCreateHandler, configsCreateHandler, metadataHandler, getByKeyHandler)
