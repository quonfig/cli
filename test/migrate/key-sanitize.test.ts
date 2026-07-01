import {expect} from 'chai'

import {sanitizePolicyAKey} from '../../src/migrate/key-sanitize.js'

// qfg-6na9.3: deterministic single-key Policy A sanitizer used by `qfg migrate`
// so imported keys 100% conform (charset ^[A-Za-z0-9._-]+$, <=200, not "new",
// no leading dot, no FS-floor violation). LD keys are already conformant, so
// this must be a strict no-op for them. Collision disambiguation is layered on
// top by the per-run key rewriter (key-rewriter.ts) — NOT here.
describe('sanitizePolicyAKey (qfg-6na9.3)', () => {
  const clean = (k: string) => sanitizePolicyAKey(k).key

  it('is a no-op for already-conforming keys (LD parity)', () => {
    for (const k of ['my.flag.v2', 'flag_v2', 'Some-Mixed.Case_KEY', 'a', 'log-level.my-app', 'patient.faq.account']) {
      const r = sanitizePolicyAKey(k)
      expect(r.key, k).to.equal(k)
      expect(r.changed, k).to.equal(false)
      expect(r.reasons, k).to.deep.equal([])
    }
  })

  it('replaces path separators with a dot (preserves dotted hierarchy)', () => {
    expect(clean('foo/bar')).to.equal('foo.bar')
    expect(clean('a\\b')).to.equal('a.b')
    expect(clean('a/b/c')).to.equal('a.b.c')
  })

  it('replaces charset violations with a dash and preserves case', () => {
    expect(clean('Beta Users')).to.equal('Beta-Users')
    expect(clean('feature@v2')).to.equal('feature-v2')
    expect(clean('a+b=c')).to.equal('a-b-c')
    expect(clean('café')).to.equal('caf') // 'é' -> '-', then the trailing dash is trimmed
  })

  it('collapses runs of disallowed chars into a single dash', () => {
    expect(clean('a   b')).to.equal('a-b')
    expect(clean('a@#$b')).to.equal('a-b')
  })

  it('strips leading dots and trailing dot/space (FS-floor)', () => {
    expect(clean('.beta')).to.equal('beta')
    expect(clean('foo.')).to.equal('foo')
    expect(clean('foo ')).to.equal('foo')
    expect(clean('..x..')).to.equal('x')
  })

  it('escapes Windows reserved device names on the first segment', () => {
    expect(clean('con')).to.equal('con_')
    expect(clean('CON')).to.equal('CON_')
    expect(clean('nul.foo')).to.equal('nul_.foo')
    expect(clean('com1')).to.equal('com1_')
    // Non-reserved lookalikes are untouched.
    expect(clean('console')).to.equal('console')
    expect(clean('com10')).to.equal('com10')
  })

  it('escapes the reserved key "new"', () => {
    expect(clean('new')).to.equal('new-key')
    // "new" only reserved as the whole key, not as a segment.
    expect(clean('new.flag')).to.equal('new.flag')
  })

  it('produces a deterministic non-empty placeholder when sanitizing empties the key', () => {
    const a = sanitizePolicyAKey('!!!')
    expect(a.key).to.match(/^key-[\da-f]{8}$/)
    expect(a.changed).to.equal(true)
    // deterministic
    expect(sanitizePolicyAKey('!!!').key).to.equal(a.key)
    // different input -> different placeholder
    expect(sanitizePolicyAKey('???').key).to.not.equal(a.key)
  })

  it('caps length at 200 with a stable hash suffix', () => {
    const long = 'x'.repeat(300)
    const r = sanitizePolicyAKey(long)
    expect(r.key.length).to.equal(200)
    expect(r.key).to.match(/-[\da-f]{8}$/)
    expect(sanitizePolicyAKey(long).key).to.equal(r.key) // deterministic
    // a 200-char conforming key is untouched
    expect(sanitizePolicyAKey('y'.repeat(200)).changed).to.equal(false)
  })

  it('always returns a Policy-A-valid key', () => {
    const re = /^[\w.-]+$/
    for (const bad of ['Beta Users', '.beta', 'foo.', 'con', 'a/b', '!!!', 'x'.repeat(300), 'a:b*c?"<>|', 'new']) {
      const out = sanitizePolicyAKey(bad).key
      expect(re.test(out), `${bad} -> ${out}`).to.equal(true)
      expect(out.startsWith('.'), out).to.equal(false)
      expect(out.length <= 200, out).to.equal(true)
    }
  })
})
