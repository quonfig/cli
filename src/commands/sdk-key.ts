import {BaseCommand} from '../index.js'

export default class SdkKey extends BaseCommand {
  static description = 'Manage SDK keys for your workspace'

  static examples = [
    '<%= config.bin %> sdk-key list',
    '<%= config.bin %> sdk-key create --environment production --type server',
    '<%= config.bin %> sdk-key revoke <key-id>',
  ]

  public async run(): Promise<void> {
    this.log('Use one of the sdk-key subcommands:')
    this.log('  qfg sdk-key list')
    this.log('  qfg sdk-key create --environment <name> --type server|browser')
    this.log('  qfg sdk-key revoke <key-id>')
  }
}
