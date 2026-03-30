import {readFileSync} from 'node:fs'

import {Args, Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {JsonObj} from '../result.js'
import {checkmark} from '../util/color.js'

type SchemaDocument = Record<string, unknown>

interface SchemaDetailResponse {
  commitSha: string
  description?: string
  key: string
  protected?: boolean
  schema: SchemaDocument
  title?: string
}

interface SchemaWriteResponse extends SchemaDetailResponse {}

const isSchemaDocument = (value: unknown): value is SchemaDocument =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const loadSchemaDocument = (input: string): SchemaDocument => {
  const source = input.trim().startsWith('@') ? readFileSync(input.trim().slice(1), 'utf8') : input

  let parsed: unknown

  try {
    parsed = JSON.parse(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Schema documents must be valid JSON Schema objects: ${message}`)
  }

  if (!isSchemaDocument(parsed)) {
    throw new Error('Schema documents must be JSON objects.')
  }

  return parsed
}

export default class Schema extends APICommand {
  static args = {
    name: Args.string({description: 'schema key', required: true}),
  }

  static description = 'Get or update first-class schema documents'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-schema --get',
    '<%= config.bin %> <%= command.id %> my-schema --set-json-schema=\'{"type":"object","properties":{}}\'',
    '<%= config.bin %> <%= command.id %> my-schema --set-json-schema=@schemas/my-schema.json --protected',
  ]

  static flags = {
    get: Flags.boolean({description: 'get the schema document'}),
    protected: Flags.boolean({default: false, description: 'store the schema in protected storage'}),
    'set-json-schema': Flags.string({
      description: 'set a plain JSON Schema document (inline JSON or @file path)',
    }),
    'set-zod': Flags.string({
      description: 'compatibility alias for --set-json-schema; now expects plain JSON Schema',
    }),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(Schema)

    if (!this.workspaceId) {
      return this.err('Workspace ID not found. Please run `qfg login`.')
    }

    const schemaKey = args.name
    const schemaInput = flags['set-json-schema'] ?? flags['set-zod']

    if (flags.get && schemaInput) {
      return this.err('Use either --get or --set-json-schema, not both.')
    }

    if (!flags.get && !schemaInput) {
      return this.err('Use --get or --set-json-schema.')
    }

    if (flags.get) {
      return this.getSchema(schemaKey)
    }

    return this.upsertSchema(schemaKey, schemaInput!, flags.protected)
  }

  private async getSchema(schemaKey: string): Promise<JsonObj | void> {
    const request = await this.apiClient.post('/api/v1/schemas/getByKey', {
      workspaceId: this.workspaceId,
      schemaKey,
    })

    if (!request.ok) {
      if (request.status === 404) {
        return this.err(`Schema ${schemaKey} not found`, {
          key: schemaKey,
          phase: 'lookup',
          serverError: request.error,
        })
      }

      return this.err(`Failed to fetch schema ${schemaKey}: ${request.status} | ${JSON.stringify(request.error)}`, {
        key: schemaKey,
        phase: 'lookup',
        serverError: request.error,
      })
    }

    const response = request.json as unknown as SchemaDetailResponse

    if (!isSchemaDocument(response.schema)) {
      return this.err(`Schema ${schemaKey} returned an invalid document`, {
        key: schemaKey,
        phase: 'lookup',
      })
    }

    return this.ok(JSON.stringify(response.schema, null, 2), {
      commitSha: response.commitSha,
      key: response.key,
      protected: response.protected,
      schema: response.schema,
    })
  }

  private async upsertSchema(schemaKey: string, schemaInput: string, protectedSchema: boolean): Promise<JsonObj | void> {
    const schema = loadSchemaDocument(schemaInput)

    const existing = await this.fetchSchema(schemaKey)

    if (!existing) {
      return this.createSchema(schemaKey, schema, protectedSchema)
    }

    return this.updateSchema(schemaKey, schema, existing, protectedSchema)
  }

  private async fetchSchema(schemaKey: string): Promise<SchemaDetailResponse | undefined> {
    const request = await this.apiClient.post('/api/v1/schemas/getByKey', {
      workspaceId: this.workspaceId,
      schemaKey,
    })

    if (request.ok) {
      const response = request.json as unknown as SchemaDetailResponse
      if (isSchemaDocument(response.schema)) {
        return response
      }
      return undefined
    }

    if (request.status === 404) {
      return undefined
    }

    throw new Error(`Failed to fetch schema ${schemaKey}: ${request.status} | ${JSON.stringify(request.error)}`)
  }

  private async createSchema(
    schemaKey: string,
    schema: SchemaDocument,
    protectedSchema: boolean,
  ): Promise<JsonObj | void> {
    const request = await this.apiClient.post('/api/v1/schemas/create', {
      workspaceId: this.workspaceId,
      schemaKey,
      protected: protectedSchema,
      schema,
    })

    if (!request.ok) {
      if (request.status === 409) {
        const current = await this.fetchSchema(schemaKey)
        if (current) {
          return this.updateSchema(schemaKey, schema, current, protectedSchema)
        }
      }

      return this.err(`Failed to create schema: ${schemaKey} | ${request.status} | ${JSON.stringify(request.error)}`, {
        key: schemaKey,
        phase: 'creation',
        serverError: request.error,
      })
    }

    const response = request.json as unknown as SchemaWriteResponse

    return this.ok(`${checkmark} Created schema: ${schemaKey}`, {
      commitSha: response.commitSha,
      key: response.key,
      protected: response.protected,
      schema: response.schema,
    })
  }

  private async updateSchema(
    schemaKey: string,
    schema: SchemaDocument,
    existing: SchemaDetailResponse,
    protectedSchema: boolean,
  ): Promise<JsonObj | void> {
    const request = await this.apiClient.post('/api/v1/schemas/update', {
      workspaceId: this.workspaceId,
      schemaKey,
      protected: protectedSchema,
      schema,
      expectedCommitSha: existing.commitSha,
    })

    if (!request.ok) {
      return this.err(`Failed to update schema: ${schemaKey} | ${request.status} | ${JSON.stringify(request.error)}`, {
        key: schemaKey,
        phase: 'update',
        serverError: request.error,
      })
    }

    const response = request.json as unknown as SchemaWriteResponse

    return this.ok(`${checkmark} Updated schema: ${schemaKey}`, {
      commitSha: response.commitSha,
      key: response.key,
      protected: response.protected,
      schema: response.schema,
    })
  }
}
