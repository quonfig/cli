import {BaseCommand} from '../index.js'

export default class Contexts extends BaseCommand {
  static description = 'Look up contexts (organizations, users, ...) your SDKs have reported, to target them by key.'

  static examples = ['<%= config.bin %> contexts search organization formhealth']

  public async run(): Promise<void> {
    this.log('Use one of the contexts subcommands:')
    this.log('  qfg contexts search CONTEXT_TYPE QUERY [--environment ENV] [--limit N] [--json]')
    this.log('      # find a context key by name, e.g. qfg contexts search organization formhealth')
  }
}
