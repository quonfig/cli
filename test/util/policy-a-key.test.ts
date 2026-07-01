import {expect} from 'chai'

import {POLICY_A_KEY_RE, policyAKeyError} from '../../src/util/policy-a-key.js'

// qfg-6na9.2: the create-time HARD Policy A charset check, mirroring
// app-quonfig src/lib/domain/config-schemas.ts PolicyAKeySchema. The two must
// stay in sync (charset ^[A-Za-z0-9._-]+$, <=200 chars, not "new", no leading
// dot). The general charset stays a WARNING in `qfg verify` (validate.ts,
// qfg-6na9.5) — this helper is the create boundary only.
describe('policyAKeyError (qfg-6na9.2)', () => {
  it('accepts a conforming key (returns null)', () => {
    for (const ok of ['my.new.flag', 'flag_v2', 'Some-Mixed.Case_KEY', 'a', 'log-level.my-app', 'x'.repeat(200)]) {
      expect(policyAKeyError(ok), ok).to.equal(null)
    }
  })

  it('rejects charset violations', () => {
    for (const bad of ['my flag', 'feature@v2', 'a+b', 'beta:v2', 'café', 'a/b', 'a\\b', 'x*y']) {
      expect(policyAKeyError(bad), bad).to.match(/letters, numbers, dots, dashes/)
    }
  })

  it('rejects empty, over-length, reserved "new", and leading-dot keys', () => {
    expect(policyAKeyError('')).to.match(/required/)
    expect(policyAKeyError('x'.repeat(201))).to.match(/200 characters/)
    expect(policyAKeyError('new')).to.match(/cannot be "new"/)
    expect(policyAKeyError('.beta')).to.match(/cannot start with a dot/)
  })

  it('exposes the same charset regex used by app-quonfig', () => {
    expect(POLICY_A_KEY_RE.test('a.b-c_d')).to.equal(true)
    expect(POLICY_A_KEY_RE.test('a b')).to.equal(false)
  })
})
