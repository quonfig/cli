import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {getApiBase} from '../test-domain-helper.js'

export const keyWithEvaluations = 'my-string-list-key'
export const keyWithNoEvaluations = 'jeffreys.test.key.reforge'
export const secretKey = 'a.secret.config'
export const confidentialKey = 'a.confidential.config'
export const jsonKey = 'question.max-response.override'
export const rolloutRuleKey = 'fx-rule-rollout'
export const readyForCleanupKey = 'flag.ready-for-cleanup'

export const rawSecret = `875247386844c18c58a97c--b307b97a8288ac9da3ce0cf2--7ab0c32e044869e355586ed653a435de`

// v1 config response structure for keyWithEvaluations
const configWithEvaluations = {
  key: keyWithEvaluations,
  type: 'config',
  valueType: 'string_list',
  default: {
    rules: [
      {
        criteria: [{operator: 'ALWAYS_TRUE'}],
        value: {
          type: 'string_list',
          value: ['a', 'b', 'c'],
        },
      },
    ],
  },
  environments: [
    {
      id: '588',
      rules: [],
    },
    {
      id: '143',
      rules: [],
    },
  ],
}

// v1 config response for keyWithNoEvaluations
const configWithNoEvaluations = {
  key: keyWithNoEvaluations,
  type: 'config',
  valueType: 'string',
  default: {
    rules: [
      {
        criteria: [
          {
            propertyName: 'quonfig-api-key.user-id',
            operator: 'PROP_IS_ONE_OF',
            valueToMatch: {
              type: 'string_list',
              value: ['112'],
            },
          },
        ],
        value: {
          type: 'string',
          value: 'my.override',
        },
      },
      {
        criteria: [{operator: 'ALWAYS_TRUE'}],
        value: {
          type: 'string',
          value: 'abc',
        },
      },
    ],
  },
  environments: [
    {
      id: '588',
      rules: [
        {
          criteria: [{operator: 'ALWAYS_TRUE'}],
          value: {type: 'string', value: 'test'},
        },
      ],
    },
    {
      id: '143',
      rules: [
        {
          criteria: [
            {
              operator: 'PROP_IS_ONE_OF',
              propertyName: 'prefab-api-key.user-id',
              valueToMatch: {
                type: 'string_list',
                value: ['112'],
              },
            },
          ],
          value: {type: 'string', value: 'my.override'},
        },
      ],
    },
  ],
}

const secretConfig = {
  key: secretKey,
  type: 'config',
  valueType: 'string',
  default: {
    rules: [
      {
        criteria: [{operator: 'ALWAYS_TRUE'}],
        value: {
          type: 'string',
          value: rawSecret,
          confidential: true,
          decryptWith: 'prefab.secrets.encryption.key',
        },
      },
    ],
  },
}

// v1 config response for a JSON-typed config (exercises [object Object] bug)
const jsonConfig = {
  key: jsonKey,
  type: 'config',
  valueType: 'json',
  default: {
    rules: [
      {
        criteria: [{operator: 'ALWAYS_TRUE'}],
        value: {
          type: 'json',
          value: {maxTokens: 500, model: 'claude'},
        },
      },
    ],
  },
  environments: [],
}

// Config whose `test` env serves a weighted_values rollout via a conditional
// rule — the LaunchDarkly migrator produces this shape, and it tripped the
// "[override] [object Object]" bug (qfg-5j9i). The rule's value is wrapped:
//   {type: 'weighted_values', value: {hashByPropertyName, weightedValues: [...]}}
const rolloutRuleConfig = {
  key: rolloutRuleKey,
  type: 'feature_flag',
  valueType: 'bool',
  default: {
    rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}}],
  },
  environments: [
    {
      id: '588',
      rules: [
        {
          criteria: [
            {
              operator: 'PROP_IS_ONE_OF',
              propertyName: 'user.key',
              valueToMatch: {type: 'string_list', value: ['alice', 'bob']},
            },
          ],
          value: {
            type: 'weighted_values',
            value: {
              hashByPropertyName: 'user.key',
              weightedValues: [
                {value: {type: 'bool', value: true}, weight: 50_000},
                {value: {type: 'bool', value: false}, weight: 50_000},
              ],
            },
          },
        },
        {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
      ],
    },
  ],
}

// Flag marked readyForCleanup=true — verifies that `qfg info` appends the
// cleanup hint to non-JSON output and surfaces the field in --json (qfg-olm2.6).
const readyForCleanupConfig = {
  key: readyForCleanupKey,
  type: 'feature_flag',
  valueType: 'bool',
  readyForCleanup: true,
  default: {
    rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}],
  },
  environments: [],
}

const confidentialConfig = {
  key: confidentialKey,
  type: 'config',
  valueType: 'string',
  default: {
    rules: [
      {
        criteria: [{operator: 'ALWAYS_TRUE'}],
        value: {
          type: 'string',
          value: 'some value',
          confidential: true,
        },
      },
    ],
  },
}

// POST /api/v1/metadata/list - list all configs (oRPC wrapped)
const metadataHandler = http.post(`${getApiBase()}/api/v1/metadata/list`, () =>
  HttpResponse.json({
    json: {
      configs: [
        {
          key: keyWithEvaluations,
          type: 'config',
          valueType: 'string_list',
          version: 1,
          id: 1,
          name: 'My String List',
          description: '',
        },
        {
          key: keyWithNoEvaluations,
          type: 'config',
          valueType: 'string',
          version: 1,
          id: 2,
          name: 'Jeffrey Test',
          description: '',
        },
        {key: secretKey, type: 'config', valueType: 'string', version: 1, id: 3, name: 'Secret', description: ''},
        {
          key: confidentialKey,
          type: 'config',
          valueType: 'string',
          version: 1,
          id: 4,
          name: 'Confidential',
          description: '',
        },
        {key: jsonKey, type: 'config', valueType: 'json', version: 1, id: 5, name: 'JSON Override', description: ''},
        {
          key: rolloutRuleKey,
          type: 'feature_flag',
          valueType: 'bool',
          version: 1,
          id: 6,
          name: 'Rollout Rule',
          description: '',
        },
        {
          key: readyForCleanupKey,
          type: 'feature_flag',
          valueType: 'bool',
          version: 1,
          id: 7,
          name: 'Ready For Cleanup',
          description: '',
          readyForCleanup: true,
        },
      ],
    },
  }),
)

// POST /api/v1/metadata/getByKey - get full config (oRPC wrapped)
const configHandler = http.post(`${getApiBase()}/api/v1/metadata/getByKey`, async ({request}) => {
  const body = (await request.json()) as any
  const key = body?.json?.key

  if (key === keyWithEvaluations) {
    return HttpResponse.json({json: configWithEvaluations})
  }

  if (key === keyWithNoEvaluations) {
    return HttpResponse.json({json: configWithNoEvaluations})
  }

  if (key === secretKey) {
    return HttpResponse.json({json: secretConfig})
  }

  if (key === confidentialKey) {
    return HttpResponse.json({json: confidentialConfig})
  }

  if (key === jsonKey) {
    return HttpResponse.json({json: jsonConfig})
  }

  if (key === rolloutRuleKey) {
    return HttpResponse.json({json: rolloutRuleConfig})
  }

  if (key === readyForCleanupKey) {
    return HttpResponse.json({json: readyForCleanupConfig})
  }

  return HttpResponse.json({json: {error: 'Not found'}}, {status: 404})
})

// POST /api/v1/environments/list - list environments (oRPC wrapped)
const environmentsHandler = http.post(`${getApiBase()}/api/v1/environments/list`, () =>
  HttpResponse.json({
    json: [
      {id: '588', name: 'jeffrey', active: true, protected: false},
      {id: '143', name: 'Production', active: true, protected: false},
    ],
  }),
)

// Captured evaluationStats request bodies for assertions (cleared per-test by server.resetHandlers)
export const evaluationStatsRequests: Array<Record<string, unknown>> = []

// POST /api/v1/analytics/evaluationStats - evaluation stats (oRPC wrapped)
//
// The real server forwards `environment` straight into a ClickHouse query that
// matches on the environment NAME (see app-quonfig/src/lib/clickhouse/queries.ts).
// We mirror that here so the CLI's behavior is verified against the real
// backend semantics — passing the env UUID returns []. (qfg-kemk)
const evaluationStatsHandler = http.post(`${getApiBase()}/api/v1/analytics/evaluationStats`, async ({request}) => {
  const body = (await request.json()) as any
  const configKey = body?.json?.configKey
  const environment = body?.json?.environment
  evaluationStatsRequests.push(body?.json as Record<string, unknown>)

  // For keyWithEvaluations, return stats
  if (configKey === keyWithEvaluations) {
    if (environment === 'Production') {
      // Production environment - return actual stats
      return HttpResponse.json({
        json: [
          {
            configId: '1',
            configType: 'config',
            selectedValue: {bool: false},
            count: 11_473,
          },
          {
            configId: '1',
            configType: 'config',
            selectedValue: {bool: true},
            count: 23_316,
          },
        ],
      })
    }

    if (environment === 'jeffrey') {
      // jeffrey environment
      return HttpResponse.json({
        json: [
          {
            configId: '1',
            configType: 'config',
            selectedValue: {string: 'test'},
            count: 42,
          },
        ],
      })
    }
  }

  // For other keys or envs, return empty stats
  return HttpResponse.json({json: []})
})

export const server = setupServer(metadataHandler, configHandler, environmentsHandler, evaluationStatsHandler)
