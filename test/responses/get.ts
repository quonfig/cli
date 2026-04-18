import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'

/**
 * Mock responses for get command tests
 * Uses oRPC API endpoints via https://app.quonfig.com
 *
 * Response shape matches sdk-node RawConfigWithDependencies — the raw-match
 * path from qfg-c7d.2 that does NOT resolve ENV_VAR or decrypt on the server.
 */

// POST /api/v1/metadata/list - list all configs
const metadataHandler = http.post('https://app.quonfig.com/api/v1/metadata/list', () =>
  HttpResponse.json({
    json: {
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
    },
  }),
)

// POST /api/v1/environments/list - list environments
// oRPC returns the array directly (wrapped in {json: ...} by the transport)
const environmentsHandler = http.post('https://app.quonfig.com/api/v1/environments/list', () =>
  HttpResponse.json({json: [{id: '', name: '[default]', active: true, protected: false}]}),
)

// POST /api/v1/evaluations/evaluate - evaluate configs
// Returns RawConfigWithDependencies[] — raw stored values + dependency pointers.
// The CLI resolves providedBy (ENV_VAR) and decryptWith locally against its own
// process.env. See qfg-c7d for the security background.
const evaluationHandler = http.post('https://app.quonfig.com/api/v1/evaluations/evaluate', async () => {
  const results = [
    {
      key: 'my-string-list-key',
      type: 'string_list',
      value: ['a', 'b', 'c'],
      metadata: {
        configRowIndex: 0,
        conditionalValueIndex: 0,
        type: 'config',
        id: '1',
        valueType: 'string_list',
      },
    },
    {
      key: 'a.secret.config.reforge',
      type: 'string',
      value: 'hello.world',
      metadata: {
        configRowIndex: 0,
        conditionalValueIndex: 0,
        type: 'config',
        id: '2',
        valueType: 'string',
      },
    },
    {
      key: 'provided.config',
      type: 'provided',
      value: {source: 'ENV_VAR', lookup: 'TEST_CLI_PROVIDED_VAR'},
      metadata: {
        configRowIndex: 0,
        conditionalValueIndex: 0,
        type: 'config',
        id: '3',
        valueType: 'string',
      },
      dependencies: [
        {
          dependencyType: 'providedBy',
          source: 'TEST_CLI_PROVIDED_VAR',
        },
      ],
    },
    {
      key: 'encrypted.config',
      type: 'string',
      value: '652cf03ad4e252bb9b69c9--03bbdb754d1923b2a3c5bfc3--ebb8c20805482ce013b1fd68cad57d69',
      confidential: true,
      metadata: {
        configRowIndex: 0,
        conditionalValueIndex: 0,
        type: 'config',
        id: '4',
        valueType: 'string',
      },
      dependencies: [
        {
          dependencyType: 'decryptWith',
          source: 'quonfig.encryption.key',
          config: {
            key: 'quonfig.encryption.key',
            type: 'provided',
            value: {source: 'ENV_VAR', lookup: 'TEST_CLI_ENCRYPTION_KEY'},
            metadata: {
              configRowIndex: 0,
              conditionalValueIndex: 0,
              type: 'config',
              id: '5',
              valueType: 'string',
            },
            dependencies: [
              {
                dependencyType: 'providedBy',
                source: 'TEST_CLI_ENCRYPTION_KEY',
              },
            ],
          },
        },
      ],
    },
  ]

  return HttpResponse.json({json: results})
})

export const server = setupServer(metadataHandler, environmentsHandler, evaluationHandler)
