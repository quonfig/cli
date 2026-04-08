import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'


/**
 * Mock responses for get command tests
 * Uses oRPC API endpoints via https://app.quonfig.com
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
// The get command sends {workspaceId, environmentId, context} and receives an array of EvaluationResult
const evaluationHandler = http.post('https://app.quonfig.com/api/v1/evaluations/evaluate', async ({request}) => {
  // Return all configs as evaluation results
  // The get command will find the matching key from the array
  const results = [
    {
      key: 'my-string-list-key',
      configType: 'CONFIG',
      valueType: 'STRING_LIST',
      value: ['a', 'b', 'c'],
      displayValue: ['a', 'b', 'c'],
    },
    {
      key: 'a.secret.config.reforge',
      configType: 'CONFIG',
      valueType: 'STRING',
      value: 'hello.world',
      displayValue: 'hello.world',
    },
    {
      key: 'provided.config',
      configType: 'CONFIG',
      valueType: 'STRING',
      value: 'server-resolved-value',
      displayValue: 'server-resolved-value',
    },
    {
      key: 'encrypted.config',
      configType: 'CONFIG',
      valueType: 'STRING',
      value: 'test-secret',
      displayValue: 'test-secret',
    },
  ]

  return HttpResponse.json({json: results})
})

export const server = setupServer(
  metadataHandler,
  environmentsHandler,
  evaluationHandler,
)
