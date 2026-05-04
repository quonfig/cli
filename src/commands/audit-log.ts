import {Args} from '@oclif/core'

import {BaseCommand} from '../index.js'

/**
 * Discoverability wrapper. Friction-log entries show agents reaching for
 * `qfg audit-log` (with and without a positional). Dispatch by argument
 * presence so both phrasings land on the right activity subcommand.
 *
 * Strategy A from qfg-d6cn.3: a thin top-level command that re-routes via
 * `this.config.runCommand(...)`. We forward unknown flags as-is so
 * `--limit`, `--json`, etc. flow through to the underlying command.
 */
export default class AuditLog extends BaseCommand {
  static args = {
    name: Args.string({
      description: 'Optional config key. If present, dispatches to `activity history NAME`; otherwise `activity feed`.',
    }),
  }

  static description = 'Alias: `qfg audit-log` → `qfg activity feed`; `qfg audit-log NAME` → `qfg activity history NAME`.'

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> my.flag']

  static strict = false

  public async run(): Promise<void> {
    const {args, argv} = await this.parse(AuditLog)
    const passthrough = (argv as string[]).filter((token) => token.startsWith('-'))
    if (args.name) {
      await this.config.runCommand('activity:history', [args.name, ...passthrough])
      return
    }

    await this.config.runCommand('activity:feed', passthrough)
  }
}
