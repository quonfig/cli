import {HttpResponse, http} from 'msw'
import {setupServer} from 'msw/node'


type SchemaDocument = Record<string, unknown>

interface StoredSchema {
  commitSha: string
  protected: boolean
  schema: SchemaDocument
}

const makeCommitSha = (n: number): string => n.toString().padStart(40, '0').slice(-40)

const seedSchemaStore = (): Map<string, StoredSchema> =>
  new Map<string, StoredSchema>([
    [
      'existing.schema',
      {
        commitSha: makeCommitSha(1),
        protected: false,
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          description: 'Original existing schema',
          properties: {
            count: {type: 'integer'},
          },
          title: 'Existing schema',
          type: 'object',
        },
      },
    ],
    [
      'my.schema',
      {
        commitSha: makeCommitSha(2),
        protected: false,
        schema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          description: 'Schema returned by the get command',
          properties: {
            enabled: {type: 'boolean'},
          },
          title: 'My schema',
          type: 'object',
        },
      },
    ],
  ])

let schemaStore = seedSchemaStore()
let commitCounter = 10

export const resetSchemaStore = () => {
  schemaStore = seedSchemaStore()
  commitCounter = 10
}

function nextCommitSha(): string {
  commitCounter += 1
  return makeCommitSha(commitCounter)
}

function schemaResponseFor(key: string, stored: StoredSchema) {
  return {
    commitSha: stored.commitSha,
    description: typeof stored.schema.description === 'string' ? stored.schema.description : undefined,
    key,
    protected: stored.protected,
    schema: stored.schema,
    title: typeof stored.schema.title === 'string' ? stored.schema.title : undefined,
  }
}

// POST /api/v1/schemas/getByKey - get schema by key (oRPC wrapped)
const getSchemaHandler = http.post('https://app.quonfig.com/api/v1/schemas/getByKey', async ({request}) => {
  const body = (await request.json()) as any
  const key = body?.json?.schemaKey

  const stored = schemaStore.get(key)

  if (!stored) {
    return HttpResponse.json({json: {message: `Schema ${key} not found`}}, {status: 404})
  }

  return HttpResponse.json({json: schemaResponseFor(key, stored)})
})

// POST /api/v1/schemas/create - create schema (oRPC wrapped)
const createSchemaHandler = http.post('https://app.quonfig.com/api/v1/schemas/create', async ({request}) => {
  const body = (await request.json()) as any
  const input = body?.json

  if (!input?.schemaKey || !input?.schema || typeof input.schema !== 'object' || Array.isArray(input.schema)) {
    return HttpResponse.json({json: {message: 'Bad Request'}}, {status: 400})
  }

  if (schemaStore.has(input.schemaKey)) {
    return HttpResponse.json({json: {message: `Schema ${input.schemaKey} already exists`}}, {status: 409})
  }

  const commitSha = nextCommitSha()
  schemaStore.set(input.schemaKey, {
    commitSha,
    protected: Boolean(input.protected),
    schema: input.schema,
  })

  return HttpResponse.json({
    json: schemaResponseFor(input.schemaKey, {
      commitSha,
      protected: Boolean(input.protected),
      schema: input.schema,
    }),
  })
})

// POST /api/v1/schemas/update - update schema (oRPC wrapped)
const updateSchemaHandler = http.post('https://app.quonfig.com/api/v1/schemas/update', async ({request}) => {
  const body = (await request.json()) as any
  const input = body?.json

  const key = input?.schemaKey
  const stored = schemaStore.get(key)
  if (!stored) {
    return HttpResponse.json({json: {message: `Schema ${key} not found`}}, {status: 404})
  }

  if (!input?.schema || typeof input.schema !== 'object' || Array.isArray(input.schema)) {
    return HttpResponse.json({json: {message: 'Bad Request'}}, {status: 400})
  }

  if (input.expectedCommitSha && input.expectedCommitSha !== stored.commitSha) {
    return HttpResponse.json({json: {message: 'Conflict'}}, {status: 409})
  }

  const commitSha = nextCommitSha()
  const nextProtected = input.protected ?? stored.protected

  schemaStore.set(key, {
    commitSha,
    protected: nextProtected,
    schema: input.schema,
  })

  return HttpResponse.json({
    json: schemaResponseFor(key, {
      commitSha,
      protected: nextProtected,
      schema: input.schema,
    }),
  })
})

export const server = setupServer(
  getSchemaHandler,
  createSchemaHandler,
  updateSchemaHandler,
)
