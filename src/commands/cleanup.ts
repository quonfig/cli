import {BaseCommand} from '../index.js'

export default class Cleanup extends BaseCommand {
  static description = `Retire feature flags that have done their job.

The cleanup workflow turns a flag's "Ready for cleanup" marker into an end-to-end
removal flow: surface the flags that are safe to retire, hand the actual code
removal to the qfg-flag-cleanup Claude skill, then delete the flag definition
once the call sites are gone.

Lifecycle (high-level):
  1. Owner flips readyForCleanup=true in the UI            (already exists)
  2. qfg cleanup list                                       see candidates + telemetry
  3. qfg cleanup status <key>                               drill into one flag
  4. qfg cleanup remove <key>                               handoff to the cleanup skill
  5. PR merges, SDK redeploys, telemetry confirms 0 evals
  6. qfg cleanup verify <key>                               (optional) confirm safe
  7. qfg delete <key>                                       remove the flag definition`

  static examples = [
    '<%= config.bin %> cleanup list',
    '<%= config.bin %> cleanup list --json',
    '<%= config.bin %> cleanup status my.flag.key',
  ]

  public async run(): Promise<void> {
    this.log('Use one of the cleanup subcommands:')
    this.log('  qfg cleanup list           # ready-for-cleanup flags + telemetry')
    this.log('  qfg cleanup status <key>   # drill into one flag')
  }
}
