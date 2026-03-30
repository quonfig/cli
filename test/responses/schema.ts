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

const getSchemaHandler = http.get('https://api.*/schemas/v1/schema/:key', ({params}) => {
  const key = String(params.key)
  const stored = schemaStore.get(key)

  if (!stored) {
    return HttpResponse.json({message: `Schema ${key} not found`}, {status: 404})
  }

  return HttpResponse.json(schemaResponseFor(key, stored))
})

const createSchemaHandler = http.post('https://api.*/schemas/v1', async ({request}) => {
  const body = (await request.json()) as {
    protected?: boolean
    schema?: SchemaDocument
    schemaKey?: string
    workspaceId?: string
  }

  if (!body.schemaKey || !body.schema || typeof body.schema !== 'object' || Array.isArray(body.schema)) {
    return HttpResponse.json({message: 'Bad Request'}, {status: 400})
  }

  if (schemaStore.has(body.schemaKey)) {
    return HttpResponse.json({message: `Schema ${body.schemaKey} already exists`}, {status: 409})
  }

  const commitSha = nextCommitSha()
  schemaStore.set(body.schemaKey, {
    commitSha,
    protected: Boolean(body.protected),
    schema: body.schema,
  })

  return HttpResponse.json(
    schemaResponseFor(body.schemaKey, {
      commitSha,
      protected: Boolean(body.protected),
      schema: body.schema,
    }),
  )
})

const updateSchemaHandler = http.put('https://api.*/schemas/v1/schema/:key', async ({params, request}) => {
  const key = String(params.key)
  const body = (await request.json()) as {
    expectedCommitSha?: string
    protected?: boolean
    schema?: SchemaDocument
    schemaKey?: string
    workspaceId?: string
  }

  const stored = schemaStore.get(key)
  if (!stored) {
    return HttpResponse.json({message: `Schema ${key} not found`}, {status: 404})
  }

  if (!body.schema || typeof body.schema !== 'object' || Array.isArray(body.schema)) {
    return HttpResponse.json({message: 'Bad Request'}, {status: 400})
  }

  if (body.expectedCommitSha && body.expectedCommitSha !== stored.commitSha) {
    return HttpResponse.json({message: 'Conflict'}, {status: 409})
  }

  const commitSha = nextCommitSha()
  const nextProtected = body.protected ?? stored.protected

  schemaStore.set(key, {
    commitSha,
    protected: nextProtected,
    schema: body.schema,
  })

  return HttpResponse.json(
    schemaResponseFor(key, {
      commitSha,
      protected: nextProtected,
      schema: body.schema,
    }),
  )
})

export const server = setupServer(
  getSchemaHandler,
  createSchemaHandler,
  updateSchemaHandler,
)
