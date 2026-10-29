import {expect} from 'chai'

import {displayUrl, redactToken} from '../../src/util/git-ops.js'

// qfg-9iu0: a git URL can carry its credential as `user:token@` or as a bare
// `token@` (no password slot). Both must be scrubbed before we print git
// output or a remote URL.
describe('redactToken', () => {
  it('redacts the password of a user:token@ URL and keeps the username', () => {
    expect(redactToken('https://qf-ws-abc:s3cret@git.quonfig.com/acme/prod.git')).to.equal(
      'https://qf-ws-abc:***@git.quonfig.com/acme/prod.git',
    )
  })

  it('redacts a bare token@ URL', () => {
    expect(redactToken('https://s3cret@git.quonfig.com/acme/prod.git')).to.equal(
      'https://***@git.quonfig.com/acme/prod.git',
    )
  })

  it('redacts every URL in a multi-line git error, not just the first', () => {
    const stderr =
      "Cloning into 'x'...\n" +
      "fatal: unable to access 'https://bot:s3cret@git.quonfig.com/a/b.git/'\n" +
      "hint: retry with 'https://s3cret@git.quonfig.com/a/b.git'"
    const out = redactToken(stderr)
    expect(out).to.not.include('s3cret')
    expect(out).to.include("'https://bot:***@git.quonfig.com/a/b.git/'")
    expect(out).to.include("'https://***@git.quonfig.com/a/b.git'")
  })

  it('leaves URLs without credentials and non-URL @ text alone', () => {
    const s = 'push https://git.quonfig.com/acme/prod.git as ada@quonfig.com (ref main@{1})'
    expect(redactToken(s)).to.equal(s)
  })

  it('displayUrl redacts a bare token@ remote', () => {
    expect(displayUrl('https://s3cret@git.quonfig.com/acme/prod')).to.equal('https://***@git.quonfig.com/acme/prod')
  })
})
