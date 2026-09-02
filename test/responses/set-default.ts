import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

/**
 * Mock responses for set-default command tests
 * Uses oRPC API endpoints via the CLI's resolved API base (getApiBase()).
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
    {
      key: 'targeted.config',
      type: 'config',
      valueType: 'string',
      version: 1,
      id: 1007,
      name: 'Targeted Config',
      description: 'A config with targeting rules in Staging and in default',
    },
    {
      key: 'targeting-only.config',
      type: 'config',
      valueType: 'string',
      version: 1,
      id: 1008,
      name: 'Targeting Only Config',
      description: 'A config whose Staging block holds a targeting rule and NO catch-all',
    },
    {
      key: 'targeted.flag',
      type: 'feature_flag',
      valueType: 'bool',
      version: 1,
      id: 1009,
      name: 'Targeted Flag',
      description: 'A boolean flag with targeting rules in Development',
    },
    {
      key: 'targeting-only.flag',
      type: 'feature_flag',
      valueType: 'bool',
      version: 1,
      id: 1010,
      name: 'Targeting Only Flag',
      description: 'A boolean flag whose Development block holds a targeting rule and NO catch-all',
    },
  ],
}

// ── Targeting fixtures (qfg-qjdm) ──────────────────────────────────────
//
// `set-default` / `set-rollout` are SURGICAL: they replace the fallback
// rule's value and keep every targeting rule around it. These fixtures give
// the tests the three shapes that matter — a scope with [targeting,
// catch-all], a scope with targeting and NO catch-all, and an environment
// with no block at all (which is seeded from `default.rules`).

const emailRule = (email: string, value: unknown) => ({
  criteria: [
    {operator: 'PROP_IS_ONE_OF', propertyName: 'user.email', valueToMatch: {type: 'string_list', value: [email]}},
  ],
  value,
})

const targetedConfigResponse = {
  key: 'targeted.config',
  type: 'config',
  valueType: 'string',
  commitSha: 'abc100',
  environments: [
    {
      id: 'Staging',
      rules: [
        emailRule('staff@example.test', {type: 'string', value: 'staging targeted'}),
        {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'staging fallback'}},
      ],
    },
  ],
  default: {
    rules: [
      emailRule('vip@example.test', {type: 'string', value: 'default targeted'}),
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'default fallback'}},
    ],
  },
}

const targetingOnlyConfigResponse = {
  key: 'targeting-only.config',
  type: 'config',
  valueType: 'string',
  commitSha: 'abc101',
  environments: [{id: 'Staging', rules: [emailRule('staff@example.test', {type: 'string', value: 'only targeted'})]}],
  // No catch-all in the default block either, so both scopes exercise the
  // append path (and therefore the spelling a fresh fallback is written in).
  default: {rules: [emailRule('vip@example.test', {type: 'string', value: 'default targeted'})]},
}

const targetedFlagResponse = {
  key: 'targeted.flag',
  type: 'feature_flag',
  valueType: 'bool',
  commitSha: 'abc102',
  environments: [
    {
      id: 'Development',
      rules: [
        emailRule('staff@example.test', {type: 'bool', value: true}),
        {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
      ],
    },
  ],
  default: {rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}}]},
}

const targetingOnlyFlagResponse = {
  key: 'targeting-only.flag',
  type: 'feature_flag',
  valueType: 'bool',
  commitSha: 'abc104',
  environments: [{id: 'Development', rules: [emailRule('staff@example.test', {type: 'bool', value: true})]}],
  default: {rules: [emailRule('vip@example.test', {type: 'bool', value: true})]},
}

// A log level whose targeting lives only in `default.rules` — the shape
// `qfg log-level --environment` used to drop on the floor by starting the
// named environment from an empty list.
const logLevelResponse = {
  key: 'log-level.test-app',
  type: 'log_level',
  valueType: 'log_level',
  commitSha: 'abc103',
  environments: [],
  default: {
    rules: [
      {
        criteria: [
          {
            operator: 'PROP_STARTS_WITH_ONE_OF',
            propertyName: 'quonfig-sdk-logging.key',
            valueToMatch: {type: 'string_list', value: ['Existing.Logger']},
          },
        ],
        value: {type: 'log_level', value: 'DEBUG'},
      },
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'log_level', value: 'WARN'}},
    ],
  },
}

// POST /api/v1/metadata/list - list all configs (oRPC wrapped)
const metadataHandler = http.post(`${getApiBase()}/api/v1/metadata/list`, () =>
  HttpResponse.json({json: metadataResponse}),
)

// POST /api/v1/environments/list - list environments (oRPC wrapped)
const environmentsHandler = http.post(`${getApiBase()}/api/v1/environments/list`, () =>
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
const getByKeyHandler = http.post(`${getApiBase()}/api/v1/metadata/getByKey`, async ({request}) => {
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

  if (key === 'targeted.config') {
    return HttpResponse.json({json: targetedConfigResponse})
  }

  if (key === 'targeting-only.config') {
    return HttpResponse.json({json: targetingOnlyConfigResponse})
  }

  if (key === 'targeted.flag') {
    return HttpResponse.json({json: targetedFlagResponse})
  }

  if (key === 'targeting-only.flag') {
    return HttpResponse.json({json: targetingOnlyFlagResponse})
  }

  if (key === 'log-level.test-app') {
    return HttpResponse.json({json: logLevelResponse})
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

// Capture the most recent body posted to /api/v1/configs/update so tests can
// assert on the exact payload the CLI sent (e.g. that a --secret write
// includes confidential + decryptWith fields — see qfg-ytw).

export const configsUpdateCapture: {body: any} = {body: null}

// POST /api/v1/configs/update — update a config via oRPC
const configsUpdateHandler = http.post(`${getApiBase()}/api/v1/configs/update`, async ({request}) => {
  const body = (await request.json()) as any
  configsUpdateCapture.body = body
  if (!body?.json?.configKey) {
    return HttpResponse.json({json: {error: 'Missing configKey'}}, {status: 400})
  }
  return HttpResponse.json({json: {success: true, key: body.json.configKey}})
})

// Same idea for /api/v1/flags/update — `set-rollout` writes feature flags
// through this endpoint, and its tests assert on the rule it emitted.
export const flagsUpdateCapture: {body: any} = {body: null}

// POST /api/v1/flags/update — update a flag via oRPC
const flagsUpdateHandler = http.post(`${getApiBase()}/api/v1/flags/update`, async ({request}) => {
  const body = (await request.json()) as any
  flagsUpdateCapture.body = body
  if (!body?.json?.flagKey) {
    return HttpResponse.json({json: {error: 'Missing flagKey'}}, {status: 400})
  }
  return HttpResponse.json({json: {success: true, key: body.json.flagKey}})
})

// Same idea for /api/v1/logLevels/update — `qfg log-level --target` writes
// through this endpoint and its tests assert on the merged rule list.
export const logLevelsUpdateCapture: {body: any} = {body: null}

// POST /api/v1/logLevels/update — update a log-level via oRPC
const logLevelsUpdateHandler = http.post(`${getApiBase()}/api/v1/logLevels/update`, async ({request}) => {
  const body = (await request.json()) as any
  logLevelsUpdateCapture.body = body
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
