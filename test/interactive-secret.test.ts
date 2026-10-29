import {ux} from '@oclif/core'
import {expect, test} from '@oclif/test'

import Create from '../src/commands/create.js'
import {getFlags} from '../src/interactive-prompt.js'
import getString from '../src/ui/get-string.js'

// qfg-38lp: the interactive "create --secret" path must not ask for a type
// (secrets are string-only), and a secret value prompt must mask input.
describe('interactive secret prompts (qfg-38lp)', () => {
  test
    .stub(ux, 'prompt', (stub) => stub.rejects(new Error('should not prompt')))
    .it('create --secret forces --type=string instead of prompting for a type', async () => {
      const flags = await getFlags(Create.flags, 'create', ['secret'], Create)
      expect(flags).to.include('--type=string')
      expect(flags).to.include('--secret')
    })

  let promptOptions: unknown
  test
    .stub(ux, 'prompt', (stub) =>
      stub.callsFake(async (_message: string, options: unknown) => {
        promptOptions = options
        return 'typed'
      }),
    )
    .it('getString({mask: true}) prompts with a masked input', async () => {
      expect(await getString({allowBlank: false, mask: true, message: 'Secret value'})).to.equal('typed')
      expect(promptOptions).to.deep.include({type: 'mask'})
    })
})
