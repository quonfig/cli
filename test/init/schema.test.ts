import {expect} from 'chai'

import {storedConfigJsonSchema} from '../../src/init/schema.js'

// qfg-hbuy.9: the published stored-config JSON schema (`qfg config-schema
// --json-schema`, and the copy `qfg init` can drop into a workspace) must
// describe the SAME `key` constraint the prod qfg-verify hook enforces —
// Policy A (charset `^[A-Za-z0-9._-]+$`, 200-char cap). Before this, the
// schema advertised maxLength:512 + `^[^/\\]+$`, so a key that validated
// green in a customer's editor was then hard-rejected at push time.
describe('storedConfigJsonSchema key property (qfg-hbuy.9)', () => {
  const schema = storedConfigJsonSchema() as {
    properties: {key: {maxLength: number; minLength: number; not: unknown; pattern: string}}
  }
  const key = schema.properties.key

  it('caps key length at Policy A (200), not the old 512', () => {
    expect(key.maxLength).to.equal(200)
  })

  it('uses the Policy A charset pattern, not the old loose ^[^/\\]+$', () => {
    expect(key.pattern).to.equal('^[A-Za-z0-9._-]+$')
  })

  it('keeps the other key invariants (min length, reserved "new")', () => {
    expect(key.minLength).to.equal(1)
    expect(key.not).to.deep.equal({const: 'new'})
  })

  it('pattern accepts conforming keys and rejects charset/length violations', () => {
    const re = new RegExp(key.pattern)
    expect(re.test('my.feature.flag')).to.equal(true)
    expect(re.test('Some-Mixed.Case_KEY')).to.equal(true)
    expect(re.test('my flag')).to.equal(false)
    expect(re.test('a/b')).to.equal(false)
    expect(re.test('feature@v2')).to.equal(false)
  })
})
