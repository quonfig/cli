import {Args, Flags} from '@oclif/core'

import {BaseCommand} from '../index.js'
import {formatResult, validateWorkspace} from '../verify/validate.js'

export default class Verify extends BaseCommand {
  static args = {
    path: Args.string({
      default: '.',
      description: 'Path to workspace directory',
    }),
  }

  static description = 'Validate a Quonfig workspace directory'

  static examples = [
    '<%= config.bin %> verify',
    '<%= config.bin %> verify ./my-workspace',
    '<%= config.bin %> verify --json',
  ]

  static flags = {
    strict: Flags.boolean({
      default: false,
      description: 'Treat warnings as errors',
    }),
  }

  public async run(): Promise<object> {
    const {args, flags} = await this.parse(Verify)
    const dir = args.path

    const result = validateWorkspace(dir)

    if (flags.strict) {
      // Promote warnings to errors
      for (const issue of result.issues) {
        if (issue.severity === 'warning') {
          issue.severity = 'error'
        }
      }

      result.valid = !result.issues.some((i) => i.severity === 'error')
    }

    if (this.jsonEnabled()) {
      if (!result.valid) {
        // Print the JSON findings BEFORE exiting non-zero. `this.exit()` throws,
        // so exiting first would swallow the very output `--json` exists to
        // produce (qfg-ez47). Same order as `migrate doctor`: emit, then exit.
        this.logJson(result)
        this.exit(1)
      }

      return result
    }

    this.log(formatResult(result))

    if (!result.valid) {
      this.exit(1)
    }

    return result
  }
}
