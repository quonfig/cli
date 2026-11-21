import {expect} from 'chai'

import {auditLines} from '../../src/util/audit-lines.js'

describe('auditLines', () => {
  it('prefixes each line of an update with its scope, so the environment shows', () => {
    expect(
      auditLines('updated', [
        {scope: 'staging', message: 'its own rules removed, so it now uses the default'},
        {scope: 'staging', message: '- everyone gets false'},
        {scope: 'default', message: '~ everyone gets false -> true'},
      ]),
    ).to.deep.equal([
      '    staging: its own rules removed, so it now uses the default',
      '    staging: - everyone gets false',
      '    default: ~ everyone gets false -> true',
    ])
  })

  it('leaves the created / deleted / restored header line unprefixed', () => {
    expect(
      auditLines('created', [
        {scope: 'metadata', message: 'Created feature flag "my.flag" (bool)'},
        {scope: 'default', message: '+ everyone gets false'},
      ]),
    ).to.deep.equal(['    Created feature flag "my.flag" (bool)', '    default: + everyone gets false'])
    expect(auditLines('restored', [{scope: 'metadata', message: 'Restored feature flag "my.flag"'}])).to.deep.equal([
      '    Restored feature flag "my.flag"',
    ])
  })

  it('prints a line that has no scope without a prefix', () => {
    expect(auditLines('updated', [{message: 'something changed'} as never])).to.deep.equal(['    something changed'])
  })
})
