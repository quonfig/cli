import {expect} from 'chai'

import {POLICY_A_KEY_RE, WINDOWS_RESERVED_DEVICE_NAME_RE, policyAKeyError} from '../../src/util/policy-a-key.js'

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

  // qfg-hbuy.6 (cli half): FS-safety floor parity with app-quonfig
  // PolicyAKeySchema — the two floor refinements the charset alone permits.
  it('rejects keys ending with a trailing dot (trailing-floor)', () => {
    // A trailing dot is charset-legal, so it reaches the trailing-floor refine.
    for (const bad of ['foo.', 'my.flag.', 'a..']) {
      expect(policyAKeyError(bad), bad).to.match(/end with a dot or space/)
    }
    // A trailing SPACE fails the charset refine first — same ordering as
    // app-quonfig PolicyAKeySchema (charset refine precedes the trailing refine).
    expect(policyAKeyError('foo ')).to.match(/letters, numbers, dots, dashes/)
  })

  it('rejects Windows reserved device names before the first dot', () => {
    for (const bad of ['con', 'CON', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt3', 'com3.foo', 'CON.json.bak']) {
      expect(policyAKeyError(bad), bad).to.match(/Windows reserved device name/)
    }
  })

  it('accepts near-miss device names that are NOT reserved', () => {
    for (const ok of ['com0', 'com10', 'console', 'foo.con', 'lpt0', 'context', 'aux-service']) {
      expect(policyAKeyError(ok), ok).to.equal(null)
    }
  })

  it('exposes the same reserved-device regex used by app-quonfig', () => {
    expect(WINDOWS_RESERVED_DEVICE_NAME_RE.test('con')).to.equal(true)
    expect(WINDOWS_RESERVED_DEVICE_NAME_RE.test('COM3')).to.equal(true)
    expect(WINDOWS_RESERVED_DEVICE_NAME_RE.test('com10')).to.equal(false)
    expect(WINDOWS_RESERVED_DEVICE_NAME_RE.test('console')).to.equal(false)
  })
})
