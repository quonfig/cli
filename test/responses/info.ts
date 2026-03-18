import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {identityHandler, identityHandlerTestDomain} from '../test-auth-helper.js'

export const keyWithEvaluations = 'my-string-list-key'
export const keyWithNoEvaluations = 'jeffreys.test.key.reforge'
export const secretKey = 'a.secret.config'
export const confidentialKey = 'a.confidential.config'

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

// GET /all-config-types/v1/metadata - list all configs
const metadataHandler = http.get('https://api.goatsofquonfig.com/all-config-types/v1/metadata', () =>
  HttpResponse.json({
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
    ],
  }),
)

// GET /all-config-types/v1/config/:key - get full config
const configHandler = http.get('https://api.goatsofquonfig.com/all-config-types/v1/config/:key', ({params}) => {
  const key = params.key as string

  if (key === keyWithEvaluations) {
    return HttpResponse.json(configWithEvaluations)
  }

  if (key === keyWithNoEvaluations) {
    return HttpResponse.json(configWithNoEvaluations)
  }

  if (key === secretKey) {
    return HttpResponse.json(secretConfig)
  }

  if (key === confidentialKey) {
    return HttpResponse.json(confidentialConfig)
  }

  return HttpResponse.json({error: 'Not found'}, {status: 404})
})

// GET /environments/v1 - list environments
const environmentsHandler = http.get('https://api.goatsofquonfig.com/environments/v1', () =>
  HttpResponse.json({
    environments: [
      {id: '588', name: 'jeffrey', active: true, protected: false},
      {id: '143', name: 'Production', active: true, protected: false},
    ],
  }),
)

// GET /evaluation-statistics/v1 - evaluation stats
const evaluationStatsHandler = http.get('https://api.goatsofquonfig.com/evaluation-statistics/v1', ({request}) => {
  const url = new URL(request.url)
  const key = url.searchParams.get('key')
  const envId = url.searchParams.get('projectEnvId')
  const startTime = url.searchParams.get('startTime')
  const endTime = url.searchParams.get('endTime')

  // For keyWithEvaluations, return stats
  if (key === keyWithEvaluations) {
    if (envId === '143') {
      // Production environment - return actual stats
      return HttpResponse.json({
        projectEnvId: '143',
        key: keyWithEvaluations,
        intervals: [
          {
            startAt: startTime ? Number(startTime) : 1_699_975_592_151,
            endAt: endTime ? Number(endTime) : 1_700_061_992_151,
            data: [
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
          },
        ],
      })
    }

    if (envId === '588') {
      // jeffrey environment
      return HttpResponse.json({
        projectEnvId: '588',
        key: keyWithEvaluations,
        intervals: [
          {
            startAt: startTime ? Number(startTime) : 1_699_975_592_151,
            endAt: endTime ? Number(endTime) : 1_700_061_992_151,
            data: [
              {
                configId: '1',
                configType: 'config',
                selectedValue: {string: 'test'},
                count: 42,
              },
            ],
          },
        ],
      })
    }
  }

  // For other keys or envs, return empty stats
  return HttpResponse.json({
    projectEnvId: envId || 'unknown',
    key: key || 'unknown',
    intervals: [],
  })
})

export const server = setupServer(
  identityHandler,
  identityHandlerTestDomain,
  metadataHandler,
  configHandler,
  environmentsHandler,
  evaluationStatsHandler,
)
