import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../index.js'

export default class Override extends BaseCommand {
  static args = {
    name: Args.string({description: 'config/feature-flag/etc. name'}),
  }

  static description = `Override a flag value for your dev user (not yet implemented).

The Quonfig replacement writes a top-priority rule keyed on the dev-only
quonfig-user.email attribute. See project/plans/dev-overrides.md for design
and bead qfg-pj0.6 for delivery status.`

  static examples = ['<%= config.bin %> <%= command.id %>  # currently exits non-zero with a not-yet-implemented message']

  // Legacy flag surface preserved so users with muscle memory get the helpful
  // "not yet implemented" message rather than oclif's "Nonexistent flag" error.
  // Replaced wholesale by qfg-pj0.6 (--env / --remove / --clear).
  static flags = {
    environment: Flags.string({description: 'unused — replaced by --env in the rewrite (qfg-pj0.6)', hidden: true}),
    remove: Flags.boolean({default: false, description: 'unused until rewrite (qfg-pj0.6)', hidden: true}),
    value: Flags.string({description: 'unused until rewrite (qfg-pj0.6)', hidden: true}),
  }

  public async run(): Promise<void> {
    this.err(
      'qfg override is not yet implemented in Quonfig — see project/plans/dev-overrides.md (tracked in bead qfg-pj0.6).',
    )
  }
}
