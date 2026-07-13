import {expect} from 'chai'

import {
  getFullKeyPlan,
  getKeyRewrites,
  planKeyRewrites,
  planKeyRewritesForChanges,
  preflightKeyRewrites,
  resetKeyRewriter,
  resolveKey,
  StrictKeysError,
} from '../../src/migrate/key-rewriter.js'

// qfg-6na9.3: the per-run key rewriter turns the pure sanitizer into a
// workspace-consistent map. planKeyRewrites() is the pre-pass over every source
// key; resolveKey() is then called at BOTH key-definition and by-key reference
// sites so a renamed segment and the IN_SEG rules pointing at it stay in sync.
// Collisions (two source keys -> one sanitized key, or a case-insensitive clash
// which the FS-floor hard-rejects) are disambiguated deterministically.
describe('key-rewriter (qfg-6na9.3)', () => {
  beforeEach(() => resetKeyRewriter())

  it('resolveKey falls back to a pure sanitize when no plan was built (no state mutation)', () => {
    expect(resolveKey('foo/bar')).to.equal('foo.bar')
    expect(resolveKey('Beta Users')).to.equal('Beta-Users')
    // conforming key round-trips untouched
    expect(resolveKey('my.flag')).to.equal('my.flag')
    // fallback must NOT register -> no rewrites recorded
    expect(getKeyRewrites()).to.deep.equal([])
  })

  it('is a no-op for an all-conforming key set (LD parity: zero rewrites)', () => {
    planKeyRewrites(['my.flag', 'billing.enabled', 'Some.CamelCase', 'log-level.app'])
    expect(getKeyRewrites()).to.deep.equal([])
    expect(resolveKey('my.flag')).to.equal('my.flag')
    expect(resolveKey('Some.CamelCase')).to.equal('Some.CamelCase')
  })

  it('rewrites non-conforming keys and records them, order-independent + deterministic', () => {
    planKeyRewrites(['Beta Users', 'feature@v2'])
    expect(resolveKey('Beta Users')).to.equal('Beta-Users')
    expect(resolveKey('feature@v2')).to.equal('feature-v2')
    const rewrites = getKeyRewrites()
    expect(rewrites.map((r) => `${r.source}=>${r.final}`)).to.have.members([
      'Beta Users=>Beta-Users',
      'feature@v2=>feature-v2',
    ])
  })

  it('disambiguates two distinct source keys that sanitize to the same key', () => {
    planKeyRewrites(['foo bar', 'foo-bar'])
    const a = resolveKey('foo bar')
    const b = resolveKey('foo-bar')
    expect(new Set([a, b]).size, 'must be distinct').to.equal(2)
    expect(new Set([a, b])).to.deep.equal(new Set(['foo-bar', 'foo-bar-2']))
  })

  it('never renames an already-valid key to make room for sanitized junk', () => {
    // 'my flag' sanitizes to 'my-flag', colliding with the ALREADY-VALID source
    // key 'my-flag'. The valid key must keep its own name — customer code calls
    // get("my-flag") and must keep hitting the same flag — and the sanitized
    // key takes the suffix.
    planKeyRewrites(['my flag', 'my-flag'])
    expect(resolveKey('my-flag')).to.equal('my-flag')
    expect(resolveKey('my flag')).to.equal('my-flag-2')
    // The unchanged valid key must NOT appear in the rewrites report.
    expect(getKeyRewrites().map((r) => `${r.source}=>${r.final}`)).to.deep.equal(['my flag=>my-flag-2'])
  })

  it('valid key wins regardless of the order keys are planned in', () => {
    for (const order of [
      ['my flag', 'my-flag'],
      ['my-flag', 'my flag'],
    ]) {
      resetKeyRewriter()
      planKeyRewrites(order)
      expect(resolveKey('my-flag'), order.join(',')).to.equal('my-flag')
      expect(resolveKey('my flag'), order.join(',')).to.equal('my-flag-2')
    }
  })

  it('a sanitized key that case-collides with a valid key gets the suffix, not the valid key', () => {
    // 'Foo ' sanitizes to 'Foo', which collides case-insensitively with the
    // valid source key 'foo'. 'foo' keeps its name; 'Foo ' is suffixed.
    for (const order of [
      ['Foo ', 'foo'],
      ['foo', 'Foo '],
    ]) {
      resetKeyRewriter()
      planKeyRewrites(order)
      expect(resolveKey('foo'), order.join(',')).to.equal('foo')
      expect(resolveKey('Foo '), order.join(',')).to.equal('Foo-2')
      expect(
        getKeyRewrites().map((r) => r.source),
        order.join(','),
      ).to.deep.equal(['Foo '])
    }
  })

  it('two VALID keys that collide case-insensitively resolve lexicographically (genuine conflict)', () => {
    // Both conform; the FS-floor still hard-rejects the case collision, so ONE
    // of them must move. Deterministic: lexicographically-first valid key keeps
    // its name.
    for (const order of [
      ['Foo', 'foo'],
      ['foo', 'Foo'],
    ]) {
      resetKeyRewriter()
      planKeyRewrites(order)
      expect(resolveKey('Foo'), order.join(',')).to.equal('Foo')
      expect(resolveKey('foo'), order.join(',')).to.equal('foo-2')
    }
  })

  it('disambiguates a case-insensitive collision (FS-floor is hard on those)', () => {
    planKeyRewrites(['Foo', 'foo'])
    const a = resolveKey('Foo')
    const b = resolveKey('foo')
    expect(a.toLowerCase()).to.not.equal(b.toLowerCase())
  })

  it('keeps references consistent: resolveKey returns the SAME final for a given source key everywhere', () => {
    planKeyRewrites(['Beta Users', 'gate.for.beta'])
    // the segment key definition and an IN_SEG reference both call resolveKey('Beta Users')
    expect(resolveKey('Beta Users')).to.equal(resolveKey('Beta Users'))
    expect(resolveKey('Beta Users')).to.equal('Beta-Users')
  })

  it('produces the same map regardless of the order keys are planned in', () => {
    resetKeyRewriter()
    planKeyRewrites(['foo bar', 'foo-bar'])
    const first = new Map(getKeyRewrites().map((r) => [r.source, r.final]))
    resetKeyRewriter()
    planKeyRewrites(['foo-bar', 'foo bar'])
    const second = new Map(getKeyRewrites().map((r) => [r.source, r.final]))
    expect([...second.entries()]).to.deep.equal([...first.entries()])
  })

  // qfg-hbuy.10: LaunchDarkly allows a flag and a segment to share one source
  // key (separate namespaces). One shared rewriter map made both resolve to the
  // same final key, so the migrator wrote feature-flags/<k>.json AND
  // segments/<k>.json and detectDuplicateKeys aborted the whole run. Segment
  // keys now plan in their own namespace: on a collision the flag keeps the
  // clean name and the segment gets a deterministic `-segment` suffix.
  describe('segment namespace (qfg-hbuy.10)', () => {
    it('a flag and a segment sharing one source key get distinct finals — flag keeps the clean name', () => {
      planKeyRewritesForChanges([{key: 'checkout'}, {key: 'checkout', keyNamespace: 'segment'}])
      expect(resolveKey('checkout')).to.equal('checkout')
      expect(resolveKey('checkout', 'segment')).to.equal('checkout-segment')
      // The rename is surfaced in the rewrites report; the flag is untouched.
      expect(getKeyRewrites().map((r) => `${r.source}=>${r.final}`)).to.deep.equal(['checkout=>checkout-segment'])
    })

    it('a lone segment keeps its clean name (no suffix without a collision)', () => {
      planKeyRewritesForChanges([{key: 'other-flag'}, {key: 'beta-users', keyNamespace: 'segment'}])
      expect(resolveKey('beta-users', 'segment')).to.equal('beta-users')
      expect(getKeyRewrites()).to.deep.equal([])
    })

    it("a suffixed segment never steals a DIFFERENT valid key's name", () => {
      planKeyRewritesForChanges([
        {key: 'checkout'},
        // A valid flag that already owns the name the segment would take.
        {key: 'checkout-segment'},
        {key: 'checkout', keyNamespace: 'segment'},
      ])
      expect(resolveKey('checkout')).to.equal('checkout')
      expect(resolveKey('checkout-segment')).to.equal('checkout-segment')
      expect(resolveKey('checkout', 'segment')).to.equal('checkout-segment-2')
    })

    it('a colliding segment key is still sanitized before suffixing', () => {
      planKeyRewritesForChanges([{key: 'beta users'}, {key: 'beta users', keyNamespace: 'segment'}])
      expect(resolveKey('beta users')).to.equal('beta-users')
      expect(resolveKey('beta users', 'segment')).to.equal('beta-users-segment')
    })

    it('persisted segment mappings are authoritative on delta runs', () => {
      planKeyRewritesForChanges([{key: 'checkout'}, {key: 'checkout', keyNamespace: 'segment'}])
      const plan = getFullKeyPlan()
      expect(plan).to.deep.equal({keys: {checkout: 'checkout'}, segmentKeys: {checkout: 'checkout-segment'}})

      // Delta run: only the segment is in the change set. Without the scoped
      // persisted mapping it would replan to the clean name.
      planKeyRewritesForChanges([{key: 'checkout', keyNamespace: 'segment'}], plan)
      expect(resolveKey('checkout', 'segment')).to.equal('checkout-segment')
    })

    it('segment-namespace resolution falls back to the default map for non-colliding keys', () => {
      // An IN_SEG reference resolves via the segment namespace even when the
      // segment itself planned in the default flow (no flag shares its key).
      planKeyRewritesForChanges([{key: 'Beta Users', keyNamespace: 'segment'}])
      expect(resolveKey('Beta Users', 'segment')).to.equal('Beta-Users')
    })

    it('a previously-migrated lone segment keeps its bare persisted mapping (v1 plan compat)', () => {
      // Plans written before qfg-hbuy.10 recorded segments as bare keys. A
      // re-run with the namespace-aware planner must keep resolving them to
      // the same finals.
      planKeyRewritesForChanges([{key: 'Beta Users', keyNamespace: 'segment'}], {
        keys: {'Beta Users': 'Beta-Users'},
        segmentKeys: {},
      })
      expect(resolveKey('Beta Users', 'segment')).to.equal('Beta-Users')
      expect(getFullKeyPlan()).to.deep.equal({keys: {'Beta Users': 'Beta-Users'}, segmentKeys: {}})
    })
  })

  describe('preflightKeyRewrites (--strict-keys)', () => {
    it('plans the map (non-strict) and leaves it queryable', () => {
      preflightKeyRewrites([{key: 'Beta Users'}, {key: 'ok.key'}])
      expect(resolveKey('Beta Users')).to.equal('Beta-Users')
      expect(getKeyRewrites().map((r) => r.source)).to.deep.equal(['Beta Users'])
    })

    it('throws StrictKeysError listing the rewrites when strict and any key is non-conforming', () => {
      expect(() => preflightKeyRewrites([{key: 'Beta Users'}], {strict: true}))
        .to.throw(StrictKeysError)
        .that.satisfies((e: StrictKeysError) => /Beta Users.*Beta-Users/s.test(e.message))
    })

    it('does NOT throw in strict mode when every key already conforms', () => {
      expect(() => preflightKeyRewrites([{key: 'ok.key'}, {key: 'Also-Fine_1'}], {strict: true})).to.not.throw()
    })

    it('ignores changes with no key', () => {
      expect(() => preflightKeyRewrites([{}, {key: 'ok.key'}], {strict: true})).to.not.throw()
    })
  })
})
