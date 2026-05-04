import {BaseCommand} from '../index.js'

export default class Activity extends BaseCommand {
  static description = 'Inspect what changed in the workspace (recent commits, per-config history, deletions).'

  static examples = [
    '<%= config.bin %> activity feed',
    '<%= config.bin %> activity history my.flag',
    '<%= config.bin %> activity deleted',
    '<%= config.bin %> activity restore my.flag --yes',
  ]

  public async run(): Promise<void> {
    this.log('Use one of the activity subcommands:')
    this.log('  qfg activity feed [--limit N] [--json]    # recent workspace changes')
    this.log('  qfg activity history NAME [--json]        # per-config audit trail')
    this.log('  qfg activity deleted [--json]             # tombstones for deleted items')
    this.log('  qfg activity restore NAME [--yes] [--json]  # undelete a config')
  }
}
