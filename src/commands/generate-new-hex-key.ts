import {encryption} from '@quonfig/node'

import {BaseCommand} from '../index.js'
import {JsonObj} from '../result.js'

export default class GenerateNewHexKey extends BaseCommand {
  static description = 'Generate a new hex key suitable for secrets'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    const key = encryption.generateNewHexKey()

    return this.ok(key, {key})
  }
}
