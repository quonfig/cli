import {PassThrough, Writable} from 'node:stream'

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

  // qfg-38lp fix pass: oclif's `mask` prompt echoed each typed character and
  // only redrew `*` after Enter, so the plaintext sat in scrollback; it also
  // hung when a paste delivered "value\r" in one chunk.
  const runMasked = async (chunks: string[]) => {
    const input = new PassThrough()
    let written = ''
    const output = new Writable({
      write(chunk, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    })
    const answer = getString({allowBlank: false, context: {input, output}, mask: true, message: 'Secret value'})
    for (const chunk of chunks) input.write(chunk)
    return {answer: await answer, written}
  }

  it('a masked prompt never writes the typed plaintext to the terminal', async () => {
    const {answer, written} = await runMasked(['F', 'A', 'K', 'E', '_typed_9', '\r'])
    expect(answer).to.equal('FAKE_typed_9')
    expect(written).to.not.contain('FAKE')
    expect(written).to.not.contain('typed')
  })

  it('a masked prompt accepts a paste that carries the newline in the same chunk', async () => {
    const {answer, written} = await runMasked(['FAKE_pasted_value_0001\r'])
    expect(answer).to.equal('FAKE_pasted_value_0001')
    expect(written).to.not.contain('FAKE_pasted')
  })
})
