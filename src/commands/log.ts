import {BaseCommand} from '../index.js'

/**
 * Discoverability wrapper. `qfg log` is muscle memory from `git log`; route
 * it to the workspace activity feed.
 */
export default class Log extends BaseCommand {
  static description = 'Alias: `qfg log` → `qfg activity feed`.'

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --limit 5']

  static strict = false

  public async run(): Promise<void> {
    const {argv} = await this.parse(Log)
    const passthrough = (argv as string[]).filter((token) => token.startsWith('-'))
    await this.config.runCommand('activity:feed', passthrough)
  }
}
