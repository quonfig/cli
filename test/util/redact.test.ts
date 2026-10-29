import {expect} from 'chai'
import {createHash} from 'node:crypto'

import {fingerprint, redactedDisplay, redactedSummary, scrubConfidentialValues} from '../../src/util/redact.js'

const md5Prefix = (s: string) => `*****${createHash('md5').update(s).digest('hex').slice(0, 5)}`

describe('redact helper (qfg-38lp)', () => {
  it('fingerprint matches the SDK telemetry format (*****<first 5 hex of md5>)', () => {
    expect(fingerprint('hello')).to.equal(md5Prefix('hello'))
    expect(fingerprint('hello')).to.match(/^\*{5}[\da-f]{5}$/)
  })

  it('encrypted values fingerprint the CIPHERTEXT, like the SDK resolver does', () => {
    const summary = redactedSummary({ciphertext: 'aa--bb--cc', plaintext: 'sk_live_FAKE_0123456789'})
    expect(summary).to.deep.equal({
      encrypted: true,
      fingerprint: md5Prefix('aa--bb--cc'),
      last4: '6789',
      length: 23,
      redacted: true,
    })
  })

  it('confidential (unencrypted) values fingerprint the plaintext', () => {
    const summary = redactedSummary({plaintext: 'sk_live_FAKE_0123456789'})
    expect(summary.fingerprint).to.equal(md5Prefix('sk_live_FAKE_0123456789'))
    expect(summary.encrypted).to.equal(false)
  })

  it('omits last4 when the plaintext is shorter than 12 chars', () => {
    const summary = redactedSummary({ciphertext: 'x--y--z', plaintext: 'short-fake'})
    expect(summary).to.not.have.property('last4')
    expect(summary.length).to.equal(10)
  })

  it('renders a one-line display that never contains the plaintext', () => {
    const plaintext = 'sk_live_FAKE_0123456789'
    const display = redactedDisplay(redactedSummary({ciphertext: 'aa--bb--cc', plaintext}))
    expect(display).to.equal(`[encrypted ${md5Prefix('aa--bb--cc')}, 23 chars, ends …6789]`)
    expect(display).to.not.contain(plaintext)
  })

  it('renders without a fingerprint before the value is encrypted (confirm prompt)', () => {
    expect(redactedDisplay(redactedSummary({encrypted: true, plaintext: 'short-fake'}))).to.equal(
      '[encrypted, 10 chars]',
    )
  })

  it('renders confidential values', () => {
    expect(redactedDisplay(redactedSummary({plaintext: 'short-fake'}))).to.equal(
      `[confidential ${md5Prefix('short-fake')}, 10 chars]`,
    )
  })

  it('scrubs unencrypted confidential rule values out of a stored document', () => {
    const doc = {
      default: {rules: [{value: {confidential: true, type: 'string', value: 'sk_live_FAKE_0123456789'}}]},
      environments: [
        {id: 'p', rules: [{value: {confidential: true, decryptWith: 'k', type: 'string', value: 'a--b--c'}}]},
      ],
      key: 'x',
    }
    const scrubbed = JSON.stringify(scrubConfidentialValues(doc))
    expect(scrubbed).to.not.contain('sk_live_FAKE_0123456789')
    // ciphertext is not plaintext; it stays
    expect(scrubbed).to.contain('a--b--c')
  })
})
