import {PassThrough, Writable} from 'node:stream'

import {expect} from 'chai'

import getConfirmation from '../src/ui/get-confirmation.js'

// qfg-r3a47: the confirm prompt reads in raw mode (no stray `^D` under a pty)
// and defaults to "no", so a bare Enter never confirms a write.
describe('getConfirmation (qfg-r3a47)', () => {
  const ask = async (keys: string) => {
    const input = new PassThrough()
    let written = ''
    const output = new Writable({
      write(chunk, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    })
    const answer = getConfirmation({context: {input, output}, flags: {interactive: true}, message: 'Confirm: go?'})
    input.write(keys)
    return {answer: await answer, written}
  }

  it('answers yes to "y"', async () => {
    const {answer, written} = await ask('y\r')
    expect(answer).to.equal(true)
    expect(written).to.not.contain('^D')
  })

  it('answers no to a bare Enter', async () => {
    const {answer} = await ask('\r')
    expect(answer).to.equal(false)
  })

  it('--confirm skips the prompt', async () => {
    expect(await getConfirmation({flags: {confirm: true}, message: 'never shown'})).to.equal(true)
  })
})
