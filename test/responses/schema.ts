import {HttpResponse, http, passthrough} from 'msw'
import {setupServer} from 'msw/node'

import {identityHandler, identityHandlerTestDomain} from '../test-auth-helper.js'
import {CannedResponses, getCannedResponse} from '../test-helper.js'

const cannedResponses: CannedResponses = {
  'https://api.goatsofquonfig.com/api/v2/config/': [
    // New schema creation success case
    [
      {
        configType: 'SCHEMA',
        key: 'new.schema',
        projectId: 124,
        rows: [
          {
            properties: {},
            values: [
              {
                criteria: [],
                value: {
                  schema: {
                    schema: 'z.string()',
                    schemaType: 1,
                  },
                },
              },
            ],
          },
        ],
      },
      {
        id: '17000801114938347',
      },
      200,
    ],

    // Existing schema case - returns 409
    [
      {
        configType: 'SCHEMA',
        key: 'existing.schema',
        projectId: 124,
        rows: [
          {
            properties: {},
            values: [
              {
                criteria: [],
                value: {
                  schema: {
                    schema: 'z.number()',
                    schemaType: 1,
                  },
                },
              },
            ],
          },
        ],
      },
      {
        _embedded: {
          errors: [
            {
              message: 'key `existing.schema` is already in use. Pass existing config id to overwrite',
            },
          ],
        },
        message: 'Conflict',
      },
      409,
    ],
  ],

  'https://api.goatsofquonfig.com/api/v2/config/key/my.schema': [
    [
      {},
      {
        rows: [
          {
            values: [
              {
                value: {
                  schema: {
                    schema: 'z.object({url: z.string()})',
                  },
                },
              },
            ],
          },
        ],
      },
      200,
    ],
  ],

  'https://api.goatsofquonfig.com/api/v2/config/key/non.existent.schema': [[{}, {message: 'Not Found'}, 404]],

  'https://api.goatsofquonfig.com/api/v2/config/set-default/': [
    [
      {
        configKey: 'existing.schema',
        value: {
          schema: {
            schema: 'z.number()',
            schemaType: 1,
          },
        },
      },
      {
        id: '17000801114938347',
      },
      200,
    ],
  ],
}

// V1 API handlers
const getSchemaV1Handler = http.get('https://api.goatsofquonfig.com/schemas/v1/schema/:key', ({params}) => {
  const {key} = params

  if (key === 'non.existent.schema') {
    return HttpResponse.json({message: 'Not Found'}, {status: 404})
  }

  if (key === 'my.schema') {
    return HttpResponse.json({
      default: {
        rules: [
          {
            criteria: [],
            value: {
              schema: {
                schema: 'z.object({url: z.string()})',
              },
            },
          },
        ],
      },
      rows: [
        {
          values: [
            {
              value: {
                schema: {
                  schema: 'z.object({url: z.string()})',
                },
              },
            },
          ],
        },
      ],
    })
  }

  return HttpResponse.json({message: 'Not Found'}, {status: 404})
})

const createSchemaV1Handler = http.post('https://api.goatsofquonfig.com/schemas/v1', async ({request}) => {
  const body = (await request.json()) as any

  // existing.schema should return 409 to trigger update path
  if (body.key === 'existing.schema') {
    return HttpResponse.json(
      {
        _embedded: {
          errors: [
            {
              message: 'key `existing.schema` is already in use',
            },
          ],
        },
        message: 'Conflict',
      },
      {status: 409},
    )
  }

  if (body.key === 'new.schema') {
    return HttpResponse.json({
      id: '17000801114938347',
    })
  }

  return HttpResponse.json({message: 'Bad Request'}, {status: 400})
})

const updateSchemaV1Handler = http.put('https://api.goatsofquonfig.com/schemas/v1/schema/:key', ({params}) => {
  const {key} = params

  if (key === 'existing.schema') {
    return HttpResponse.json({
      id: '17000801114938347',
    })
  }

  return HttpResponse.json({message: 'Not Found'}, {status: 404})
})

export const server = setupServer(
  identityHandler,
  identityHandlerTestDomain,
  getSchemaV1Handler,
  createSchemaV1Handler,
  updateSchemaV1Handler,
  http.get('https://api.goatsofquonfig.com/api/v2/configs/0', () => passthrough()),

  http.get('https://api.goatsofquonfig.com/api/v2/*', async ({request}) =>
    getCannedResponse(request, cannedResponses).catch(console.error),
  ),

  http.post('https://api.goatsofquonfig.com/api/v2/*', async ({request}) =>
    getCannedResponse(request, cannedResponses).catch(console.error),
  ),
)
