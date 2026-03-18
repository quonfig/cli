import {Help} from '@oclif/core'

import {interactivePrompt} from './interactive-prompt.js'

export default class MyHelpClass extends Help {
  public async showRootHelp() {
    if (process.argv.slice(2).includes('--help')) {
      return super.showRootHelp()
    }

    await interactivePrompt(this.config)
  }
}
