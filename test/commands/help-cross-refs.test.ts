import {expect} from 'chai'

import {REFERENCE} from '../../src/commands/config-schema.js'
import Create from '../../src/commands/create.js'

describe('--help cross-refs to qfg cleanup (qfg-olm2.2)', () => {
  it('qfg create description points users at qfg cleanup list for flag retirement', () => {
    const description = Create.description ?? ''
    expect(description).to.match(/readyForCleanup/)
    expect(description).to.match(/qfg cleanup list/)
  })

  it('config-schema reference documents readyForCleanup with a cross-ref to qfg cleanup', () => {
    expect(REFERENCE).to.match(/readyForCleanup/)
    expect(REFERENCE).to.match(/qfg cleanup/)
  })
})

describe('--help steers targeting at <contextType>.key (qfg-dpzk.2)', () => {
  it('config-schema reference says to target by key and names qfg contexts search', () => {
    expect(REFERENCE).to.match(/organization\.key/)
    expect(REFERENCE).to.match(/qfg contexts search/)
  })

  it('set-default description points at qfg contexts search for targeting', async () => {
    const {default: SetDefault} = await import('../../src/commands/set-default.js')
    expect(SetDefault.description ?? '').to.match(/qfg contexts search/)
  })
})
