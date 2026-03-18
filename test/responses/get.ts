import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

import {identityHandler, identityHandlerTestDomain} from '../test-auth-helper.js'

/**
 * Mock responses for get command tests
 * Uses v2 API endpoints
 */

// GET /all-config-types/v1/metadata - list all configs
const metadataHandler = http.get('https://api.goatsofquonfig.com/all-config-types/v1/metadata', () =>
  HttpResponse.json({
    configs: [
      {
        description: 'A string list config',
        id: 1,
        key: 'my-string-list-key',
        name: 'My String List',
        type: 'config',
        valueType: 'string_list',
        version: 1,
      },
      {
        description: 'A secret config',
        id: 2,
        key: 'a.secret.config.reforge',
        name: 'Secret Config',
        type: 'config',
        valueType: 'string',
        version: 1,
      },
      {
        description: 'A provided config',
        id: 3,
        key: 'provided.config',
        name: 'Provided Config',
        type: 'config',
        valueType: 'string',
        version: 1,
      },
      {
        description: 'An encrypted config',
        id: 4,
        key: 'encrypted.config',
        name: 'Encrypted Config',
        type: 'config',
        valueType: 'string',
        version: 1,
      },
    ],
  }),
)

// GET /environments/v1 - list environments
const environmentsHandler = http.get('https://api.goatsofquonfig.com/environments/v1', () =>
  HttpResponse.json({
    environments: [{id: '', name: '[default]', active: true, protected: false}],
  }),
)

// GET /evaluation/v2/eval - evaluate a config
const evaluationHandler = http.get('https://api.goatsofquonfig.com/evaluation/v2/eval', ({request}) => {
  const url = new URL(request.url)
  const key = url.searchParams.get('key')

  if (key === 'my-string-list-key') {
    return HttpResponse.json({
      config: {
        key: 'my-string-list-key',
        metadata: {
          configRowIndex: 0,
          conditionalValueIndex: 0,
          id: 1,
          type: 'CONFIG',
          valueType: 'STRING_LIST',
        },
        type: 'string_list',
        value: ['a', 'b', 'c'],
      },
    })
  }

  if (key === 'a.secret.config.reforge') {
    return HttpResponse.json({
      config: {
        key: 'a.secret.config.reforge',
        metadata: {
          configRowIndex: 0,
          conditionalValueIndex: 0,
          id: 2,
          type: 'CONFIG',
          valueType: 'STRING',
        },
        type: 'string',
        value: 'hello.world',
      },
    })
  }

  if (key === 'provided.config') {
    return HttpResponse.json({
      config: {
        dependencies: [
          {
            dependencyType: 'providedBy',
            source: 'TEST_ENV_VAR',
          },
        ],
        key: 'provided.config',
        metadata: {
          configRowIndex: 0,
          conditionalValueIndex: 0,
          id: 3,
          type: 'CONFIG',
          valueType: 'STRING',
        },
        type: 'provided',
        value: '',
      },
    })
  }

  if (key === 'encrypted.config') {
    return HttpResponse.json({
      config: {
        confidential: true,
        dependencies: [
          {
            config: {
              confidential: true,
              dependencies: [
                {
                  dependencyType: 'providedBy',
                  source: 'TEST_ENCRYPTION_KEY',
                },
              ],
              key: 'encryption.key',
              metadata: {
                configRowIndex: 0,
                conditionalValueIndex: 0,
                id: 5,
                type: 'CONFIG',
                valueType: 'STRING',
              },
              type: 'provided',
            },
            dependencyType: 'decryptWith',
            source: 'encryption.key',
          },
        ],
        key: 'encrypted.config',
        metadata: {
          configRowIndex: 0,
          conditionalValueIndex: 0,
          id: 4,
          type: 'CONFIG',
          valueType: 'STRING',
        },
        type: 'string',
        // This is 'test-secret' encrypted with key: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        value: '652cf03ad4e252bb9b69c9--03bbdb754d1923b2a3c5bfc3--ebb8c20805482ce013b1fd68cad57d69',
      },
    })
  }

  return HttpResponse.json({error: 'Config not found'}, {status: 404})
})

export const server = setupServer(
  identityHandler,
  identityHandlerTestDomain,
  metadataHandler,
  environmentsHandler,
  evaluationHandler,
)
