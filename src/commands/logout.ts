import type {JsonObj} from '../result.js'

import {BaseCommand} from '../index.js'
import {clearAuth} from '../util/token-storage.js'

export default class Logout extends BaseCommand {
  static description = 'Log out and clear stored authentication tokens'

  static examples = ['<%= config.bin %> <%= command.id %>']

  public async run(): Promise<JsonObj | void> {
    await clearAuth()

    this.log('Successfully logged out!')
    this.log('Authentication tokens have been cleared.')

    return {success: true}
  }
}
