import {Args, Flags} from '@oclif/core'

import {APICommand} from '../index.js'
import {JsonObj} from '../result.js'
import {checkmark} from '../util/color.js'

export default class Schema extends APICommand {
  static args = {
    name: Args.string({description: 'name of the schema', required: true}),
  }

  static description = 'Manage schemas for Quonfig configs'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-schema --set-zod="z.object({url: z.string()})"',
    '<%= config.bin %> <%= command.id %> my-schema --get',
  ]

  static flags = {
    get: Flags.boolean({description: 'get the schema definition'}),
    'set-zod': Flags.string({description: 'set a Zod schema definition'}),
  }

  public async run(): Promise<JsonObj | void> {
    const {args, flags} = await this.parse(Schema)

    if (flags.get) {
      const getRequest = await this.apiClient.get(`/schemas/v1/schema/${encodeURIComponent(args.name)}`)

      if (!getRequest.ok) {
        return this.err(`Failed to get schema: ${getRequest.status}`, {
          name: args.name,
          phase: 'get',
          serverError: getRequest.error,
        })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = getRequest.json as any
      const schemaData = response.default?.rules?.[0]?.value?.schema

      if (!schemaData) {
        return this.err(`No schema data found for: ${args.name}`)
      }

      return this.ok(`Schema for: ${args.name} is ${schemaData.schema}`, getRequest.json)
    }

    if (flags['set-zod']) {
      const createPayload = {
        key: args.name,
        schemaType: 'ZOD',
        schema: flags['set-zod'],
      }

      // Try to create first
      const createRequest = await this.apiClient.post('/schemas/v1', createPayload)

      if (!createRequest.ok) {
        if (createRequest.status === 409 || createRequest.status === 400) {
          // Schema already exists, try to update it
          const updatePayload = {
            schema: {
              schemaType: 'ZOD',
              schema: flags['set-zod'],
            },
          }

          const updateRequest = await this.apiClient.put(
            `/schemas/v1/schema/${encodeURIComponent(args.name)}`,
            updatePayload,
          )

          if (!updateRequest.ok) {
            return this.err(`Failed to update schema: ${updateRequest.status}`, {
              name: args.name,
              phase: 'update',
              serverError: updateRequest.error,
            })
          }

          const message = `${checkmark} Updated schema: ${args.name}`
          return this.ok(message, {name: args.name, ...updateRequest.json})
        }

        return this.err(`Failed to create schema: ${createRequest.status}`, {
          name: args.name,
          phase: 'creation',
          serverError: createRequest.error,
        })
      }

      const message = `${checkmark} Created schema: ${args.name}`
      return this.ok(message, {name: args.name, ...createRequest.json})
    }

    return this.err('No action specified. Try --get or --set-zod')
  }
}
