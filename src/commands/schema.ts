import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../index.js'
import {JsonObj} from '../result.js'

export default class Schema extends BaseCommand {
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
    const {args} = await this.parse(Schema)

    return this.err(
      'The `schema` command is temporarily disabled while schema files migrate to plain JSON Schema documents. TODO: rewire this command to the first-class schema-file API.',
      {
        name: args.name,
        phase: 'legacy-schema-command',
      },
    )
  }
}
