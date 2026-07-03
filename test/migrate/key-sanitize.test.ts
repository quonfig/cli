import {expect} from 'chai'

import {sanitizePolicyAKey} from '../../src/migrate/key-sanitize.js'
import {policyAKeyError} from '../../src/util/policy-a-key.js'
import {type ValidationIssue, validateKey} from '../../src/verify/validate.js'

/** Hard FS-floor errors for `key` (charset warnings are excluded on purpose). */
function floorErrors(key: string): string[] {
  const issues: ValidationIssue[] = []
  validateKey(key, 'test.json', issues)
  return issues.filter((i) => i.severity === 'error').map((i) => i.message)
}

/** True when `key` passes BOTH the Policy A rule AND the FS-safety floor. */
function isFullyValid(key: string): boolean {
  return policyAKeyError(key) === null && floorErrors(key).length === 0
}

/** Deterministic 32-bit PRNG (mulberry32) — property tests must be replayable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d_2b_79_f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

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
    expect(clean('café')).to.equal('caf-') // 'é' -> '-'; the trailing dash is legal and kept
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

  it('is a no-op for valid dash-edged keys (dashes are legal at the edges under Policy A)', () => {
    // A leading/trailing dash passes policyAKeyError AND the FS-floor, so the
    // sanitizer must not touch it — otherwise --strict-keys aborts on a
    // perfectly valid key and the "rewritten keys" report lies.
    for (const k of ['-foo-', '-foo', 'foo-', 'foo.-', '-.foo', '-', 'a--b-']) {
      expect(isFullyValid(k), `precondition: ${k} is fully valid`).to.equal(true)
      const r = sanitizePolicyAKey(k)
      expect(r.key, k).to.equal(k)
      expect(r.changed, k).to.equal(false)
      expect(r.reasons, k).to.deep.equal([])
    }
  })

  it('closure: identity on every key that passes BOTH policyAKeyError and the FS-floor', () => {
    const validKeys = [
      'my.flag.v2',
      '-edge-dashes-',
      '_underscore_',
      'MiXeD.CaSe-Key',
      'a',
      '-',
      '_',
      'con_', // escaped reserved name is itself valid
      'new.flag', // "new" only reserved as the whole key
      'console', // reserved-name lookalike
      'com10',
      'x.-.y',
      'y'.repeat(200),
      '0numeric-start',
      'trailing.dash-.-',
    ]
    for (const k of validKeys) {
      expect(isFullyValid(k), `precondition: ${k} is fully valid`).to.equal(true)
      expect(sanitizePolicyAKey(k).key, k).to.equal(k)
    }
  })

  it('property (seeded): every output passes both validators; idempotent; identity on valid inputs', () => {
    const rand = mulberry32(0x5f_3a_1c_9d)
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]
    // Mix of Policy-A chars (so some generated keys are fully valid and hit the
    // identity branch) and hostile chars (spaces, unicode, Windows-reserved,
    // control chars, path separators).
    const policyAChars = [...'abcXYZ019._-', '_']
    const hostileChars = [...' /\\!@:*"<>|+~#é', '', '']
    const genKey = (): string => {
      const hostile = rand() < 0.5
      const len = Math.floor(rand() * (rand() < 0.9 ? 24 : 220))
      let out = ''
      for (let i = 0; i < len; i++) {
        out += hostile && rand() < 0.3 ? pick(hostileChars) : pick(policyAChars)
      }

      // Occasionally force the interesting fixed shapes.
      const roll = rand()
      if (roll < 0.03) return `con${out}`
      if (roll < 0.06) return `.${out}`
      if (roll < 0.09) return `${out}.`
      if (roll < 0.12) return `-${out}-`
      return out
    }

    for (let i = 0; i < 3000; i++) {
      const raw = genKey()
      const out = sanitizePolicyAKey(raw).key
      expect(policyAKeyError(out), `policy A: ${JSON.stringify(raw)} -> ${JSON.stringify(out)}`).to.equal(null)
      expect(floorErrors(out), `FS-floor: ${JSON.stringify(raw)} -> ${JSON.stringify(out)}`).to.deep.equal([])
      // Idempotence: sanitize(sanitize(x)) === sanitize(x).
      expect(sanitizePolicyAKey(out).key, `idempotence: ${JSON.stringify(raw)}`).to.equal(out)
      // Closure: a fully valid input is returned byte-identical.
      if (isFullyValid(raw)) {
        expect(out, `identity on valid input ${JSON.stringify(raw)}`).to.equal(raw)
      }
    }
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
