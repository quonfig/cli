import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import WorkspaceSwitch from './workspace/switch.js'

export default class Profile extends BaseCommand {
  static description = 'Deprecated. Use `qfg workspace switch` instead.'
  static hidden = true

  static examples = ['<%= config.bin %> workspace switch']

  public async run(): Promise<JsonObj | void> {
    this.log('Note: `qfg profile` is deprecated. Use `qfg workspace switch` instead.\n')
    return WorkspaceSwitch.run([], this.config)
  }
}
