import {BaseCommand} from '../index.js'
import {interactivePrompt} from '../interactive-prompt.js'

export default class Interactive extends BaseCommand {
  static examples = ['<%= config.bin %>']

  public async run(): Promise<void> {
    await interactivePrompt(this.config)
  }
}
