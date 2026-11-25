import {PassThrough, Writable} from 'node:stream'

import {expect} from 'chai'

import getKeyset, {keysetChoiceLabel} from '../src/ui/get-keyset.js'

// qfg-mol-hle PR 3: the keyset prompt of `qfg create --secret` (plan 3.2 rule 5).
describe('getKeyset (qfg-mol-hle)', () => {
  it('lists each keyset with its write key and what this machine holds, and returns the pick', async () => {
    const input = new PassThrough()
    let written = ''
    const output = new Writable({
      write(chunk, _enc, cb) {
        written += chunk.toString()
        cb()
      },
    })
    const answer = getKeyset(
      [
        {annotation: 'this machine can also read it', name: 'QUONFIG_KEYSET', writeFingerprint: '5d20c7e1'},
        {annotation: 'not on this machine', name: 'QUONFIG_KEYSET_PROD', writeFingerprint: '9c1e2f3a'},
      ],
      {input, output},
    )
    input.write('\u001B[B') // arrow down
    input.write('\r')
    expect(await answer).to.equal('QUONFIG_KEYSET_PROD')
    expect(written).to.contain('Encrypt with which keyset?')
    expect(written).to.contain('QUONFIG_KEYSET       writes use 5d20c7e1   this machine can also read it')
    expect(written).to.contain('QUONFIG_KEYSET_PROD  writes use 9c1e2f3a   not on this machine')
  })

  it('shows a placeholder fingerprint for a keyset that cannot be written', () => {
    expect(
      keysetChoiceLabel({annotation: 'cannot be written: x', name: 'QUONFIG_KEYSET', writeFingerprint: ''}, 14),
    ).to.equal('QUONFIG_KEYSET  writes use --------   cannot be written: x')
  })
})
