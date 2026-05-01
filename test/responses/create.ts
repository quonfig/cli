import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

const conflictResponse = {
  message: 'Conflict',
  error: 'already exists',
}

// Build a realistic FlagDetail response (StoredConfig + commitSha) — this
// matches what app-quonfig's createEntity returns. Tests that assert on
// `qfg create --json` output and the local-disk write both depend on this
// shape lining up with production.
const buildFlagDetail = (key: string, defaultBoolValue: boolean) => ({
  key,
  type: 'feature_flag',
  valueType: 'bool',
  sendToClientSdk: true,
  access: 'standard',
  tags: [],
  default: {
    rules: [
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: defaultBoolValue}},
    ],
  },
  environments: [],
  variants: [
    {value: {type: 'bool', value: true}, name: 'True', description: 'Enabled'},
    {value: {type: 'bool', value: false}, name: 'False', description: 'Disabled'},
  ],
  commitSha: 'abc123def456abc123def456abc123def456abc1',
})

// POST /api/v1/flags/create - create boolean flags (oRPC wrapped)
const flagsCreateHandler = http.post('https://app.quonfig.com/api/v1/flags/create', async ({request}) => {
  const body = (await request.json()) as any
  const input = body?.json
  const key = input?.flag?.key

  if (key === 'already.in.use') {
    return HttpResponse.json({json: conflictResponse}, {status: 409})
  }

  const defaultBoolValue = input?.flag?.defaultValue?.value === true
  return HttpResponse.json({json: buildFlagDetail(key, defaultBoolValue)})
})

// Capture last create-config payload so tests can assert on the exact request body
// the CLI sends (not just stdout). Cleared between tests via resetCapturedCreatePayload.
export let capturedCreateConfigInput: any = null

export function resetCapturedCreateConfigInput(): void {
  capturedCreateConfigInput = null
}

// Build a realistic ConfigDetail response (StoredConfig + commitSha) for
// regular `qfg create --type=string|int|...` paths. Mirrors createEntity.
const buildConfigDetail = (key: string, valueType: string, defaultValue: unknown) => ({
  key,
  type: 'config',
  valueType,
  sendToClientSdk: false,
  access: 'standard',
  tags: [],
  default: {
    rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: defaultValue}],
  },
  environments: [],
  variants: [],
  commitSha: 'config-sha-1234567890abcdef1234567890abcdef12345678',
})

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
  const defaultValue = input?.config?.defaultValue
  if (defaultValue?.confidential && defaultValue?.decryptWith) {
    // Encrypted values must have type and value fields
    if (!defaultValue.type) {
      return HttpResponse.json({json: {error: 'Encrypted values must have a type field'}}, {status: 400})
    }
    if (defaultValue.value === undefined) {
      return HttpResponse.json({json: {error: 'Encrypted values must have a value field'}}, {status: 400})
    }
  }

  return HttpResponse.json({
    json: buildConfigDetail(key, input?.config?.valueType ?? 'string', defaultValue ?? {type: 'string', value: ''}),
  })
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

// Capture last log-level create + update payloads so tests can assert on the
// exact request body the CLI sends.
export let capturedLogLevelCreateInput: any = null
export let capturedLogLevelUpdateInput: any = null

export function resetCapturedLogLevelInputs(): void {
  capturedLogLevelCreateInput = null
  capturedLogLevelUpdateInput = null
}

// POST /api/v1/logLevels/create — create a log-level config (oRPC wrapped).
// Matches app-quonfig's createEntity which always initializes default=INFO.
const logLevelsCreateHandler = http.post('https://app.quonfig.com/api/v1/logLevels/create', async ({request}) => {
  const body = (await request.json()) as any
  const input = body?.json
  capturedLogLevelCreateInput = input
  const key = input?.logLevel?.key

  if (key === 'log-level.already-exists') {
    return HttpResponse.json({json: conflictResponse}, {status: 409})
  }

  return HttpResponse.json({
    json: {
      key,
      type: 'log_level',
      valueType: 'log_level',
      sendToClientSdk: false,
      default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'log_level', value: 'INFO'}}]},
      environments: [],
      variants: [],
      commitSha: 'sha-after-create',
    },
  })
})

// POST /api/v1/logLevels/update — patch an existing log-level config.
const logLevelsUpdateHandler = http.post('https://app.quonfig.com/api/v1/logLevels/update', async ({request}) => {
  const body = (await request.json()) as any
  const input = body?.json
  capturedLogLevelUpdateInput = input
  return HttpResponse.json({json: {...input, commitSha: 'sha-after-update'}})
})

// Canned log-level config responses for --target tests. The body shape matches
// what the real metadata.getByKey returns for a log_level-type config.
const buildLogLevelDetail = (key: string, rules: Array<{criteria: unknown[]; value: unknown}>) => ({
  key,
  type: 'log_level',
  valueType: 'log_level',
  sendToClientSdk: false,
  default: {rules},
  environments: [],
  variants: [],
  commitSha: 'sha-existing',
})

const LOG_LEVEL_WITH_NO_RULES = buildLogLevelDetail('log-level.existing', [
  {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'log_level', value: 'INFO'}},
])

// Matches the real storage/API shape: valueToMatch is {type: 'string_list', value: [...]}.
const LOG_LEVEL_WITH_EXISTING_TARGET = buildLogLevelDetail('log-level.existing-with-rule', [
  {
    criteria: [
      {
        operator: 'PROP_STARTS_WITH_ONE_OF',
        propertyName: 'quonfig-sdk-logging.key',
        valueToMatch: {type: 'string_list', value: ['Foo.Bar']},
      },
    ],
    value: {type: 'log_level', value: 'DEBUG'},
  },
  {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'log_level', value: 'INFO'}},
])

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

  if (key === 'log-level.existing') {
    return HttpResponse.json({json: LOG_LEVEL_WITH_NO_RULES})
  }

  if (key === 'log-level.existing-with-rule') {
    return HttpResponse.json({json: LOG_LEVEL_WITH_EXISTING_TARGET})
  }

  if (key === 'missing.secret.key') {
    return HttpResponse.json({json: {error: 'Config not found'}}, {status: 404})
  }

  return HttpResponse.json({json: {error: 'Config not found'}}, {status: 404})
})

export const server = setupServer(
  flagsCreateHandler,
  configsCreateHandler,
  logLevelsCreateHandler,
  logLevelsUpdateHandler,
  metadataHandler,
  getByKeyHandler,
)
