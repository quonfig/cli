import type {JsonObj} from '../result.js'

import {getEnvironments} from '../api/get-environments.js'
import {APICommand} from '../index.js'

export default class Environments extends APICommand {
  static aliases = ['envs']

  static description = `List the environments in your workspace.

Use these names with --environment (set-default, set-rollout, get, run, ...).
"[Default]" is not an environment: it names the default rules that every
environment without rules of its own inherits. Protected environments may
require extra permissions to change.`

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --json']

  public async run(): Promise<JsonObj | void> {
    await this.parse(Environments)

    // getEnvironments drops deleted environments and sorts by name.
    const environments = (await getEnvironments(this)).map((env) => ({
      id: env.id,
      name: env.name,
      protected: env.protected === true,
    }))

    if (environments.length === 0) {
      this.log('No environments found.')
      return {environments}
    }

    const width = Math.max(...environments.map((env) => env.name.length))
    for (const env of environments) {
      this.log(env.protected ? `${env.name.padEnd(width)}  protected` : env.name)
    }

    this.log('')
    this.log('Pass one of these to --environment, or "[Default]" for the inherited default rules.')

    return {environments}
  }
}
