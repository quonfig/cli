import {BaseCommand} from '../index.js'
import {interactivePrompt} from '../interactive-prompt.js'

export default class Interactive extends BaseCommand {
  static description = `Launch an interactive menu to browse and manage your workspace.

Common shortcuts:
  qfg set-default my.flag --environment production --value false   # catch-all fallback
  qfg set-rollout my.flag --environment production --true-percent 20   # % rollout

For arbitrary targeting rules (e.g. user.email, plan, segment, custom property),
run 'qfg config-schema' then 'qfg pull' and edit the JSON config directly.`

  static examples = ['<%= config.bin %>']

  public async run(): Promise<void> {
    await interactivePrompt(this.config)
  }
}
