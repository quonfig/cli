import {Args} from '@oclif/core'

import {BaseCommand} from '../index.js'

/**
 * Discoverability wrapper for `qfg history NAME` — friction logs show agents
 * reaching for this phrasing. Always dispatches to `activity history`.
 */
export default class History extends BaseCommand {
  static args = {
    name: Args.string({description: 'Config key to inspect', required: true}),
  }

  static description = 'Alias: `qfg history NAME` → `qfg activity history NAME`.'

  static examples = ['<%= config.bin %> <%= command.id %> my.flag']

  static strict = false

  public async run(): Promise<void> {
    const {args, argv} = await this.parse(History)
    const passthrough = (argv as string[]).filter((token) => token.startsWith('-'))
    await this.config.runCommand('activity:history', [args.name, ...passthrough])
  }
}
