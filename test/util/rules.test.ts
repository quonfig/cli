import {expect} from 'chai'

import {
  catchAllRule,
  countTargetingRules,
  isCatchAllRule,
  seedScopeRules,
  upsertEnvRules,
  upsertFallbackRule,
} from '../../src/util/rules.js'

const targeting = (email: string, value: unknown) => ({
  criteria: [
    {operator: 'PROP_IS_ONE_OF', propertyName: 'user.email', valueToMatch: {type: 'string_list', value: [email]}},
  ],
  value,
})

const alwaysTrue = (value: unknown) => ({criteria: [{operator: 'ALWAYS_TRUE'}], value})
const bareCatchAll = (value: unknown) => ({criteria: [], value})

describe('util/rules', () => {
  describe('isCatchAllRule', () => {
    it('accepts both live catch-all spellings', () => {
      expect(isCatchAllRule(bareCatchAll(1)), 'criteria: []').to.equal(true)
      expect(isCatchAllRule(alwaysTrue(1)), 'criteria: [ALWAYS_TRUE]').to.equal(true)
    })

    it('accepts an all-ALWAYS_TRUE list (criteria are ANDed)', () => {
      expect(isCatchAllRule({criteria: [{operator: 'ALWAYS_TRUE'}, {operator: 'ALWAYS_TRUE'}], value: 1})).to.equal(
        true,
      )
    })

    it('rejects a rule with any real criterion', () => {
      expect(isCatchAllRule(targeting('a@b.co', 1))).to.equal(false)
      expect(
        isCatchAllRule({criteria: [{operator: 'ALWAYS_TRUE'}, {operator: 'PROP_IS_ONE_OF'}], value: 1}),
        'one conditional criterion makes the whole rule conditional',
      ).to.equal(false)
    })

    it('fails closed on anything unreadable as a rule', () => {
      expect(isCatchAllRule({value: 1}), 'no criteria key at all').to.equal(false)
      expect(isCatchAllRule(null)).to.equal(false)
      expect(isCatchAllRule('nope')).to.equal(false)
    })
  })

  describe('countTargetingRules', () => {
    it('is 0 for an empty scope and for a lone catch-all', () => {
      expect(countTargetingRules([])).to.equal(0)
      expect(countTargetingRules([alwaysTrue(1)])).to.equal(0)
      expect(countTargetingRules([bareCatchAll(1)])).to.equal(0)
    })

    it('discounts a TRAILING catch-all', () => {
      expect(countTargetingRules([targeting('a@b.co', 1), alwaysTrue(2)])).to.equal(1)
      expect(countTargetingRules([targeting('a@b.co', 1), targeting('c@d.co', 2), bareCatchAll(3)])).to.equal(2)
    })

    it('counts a scope with no catch-all at all', () => {
      expect(countTargetingRules([targeting('a@b.co', 1)])).to.equal(1)
    })

    it('still counts an unconditional rule that is NOT last', () => {
      // A catch-all earlier in the list shadows everything after it — that is
      // a targeting decision in its own right.
      expect(countTargetingRules([alwaysTrue(1), targeting('a@b.co', 2)])).to.equal(2)
    })
  })

  describe('upsertFallbackRule', () => {
    it('replaces the value of the FIRST catch-all, leaving criteria untouched', () => {
      const rules = [targeting('a@b.co', 'targeted'), bareCatchAll('old'), alwaysTrue('later')]
      const next = upsertFallbackRule(rules, 'new')

      expect(next).to.have.length(3)
      expect(next[0]).to.deep.equal(targeting('a@b.co', 'targeted'))
      expect(next[1].criteria, 'existing spelling is preserved, not normalized').to.deep.equal([])
      expect(next[1].value).to.equal('new')
      expect(next[2].value, 'a later catch-all is left alone').to.equal('later')
    })

    it('appends an ALWAYS_TRUE fallback at the END when there is no catch-all', () => {
      const rules = [targeting('a@b.co', 'targeted')]
      const next = upsertFallbackRule(rules, 'new')

      expect(next).to.have.length(2)
      expect(next[0]).to.deep.equal(targeting('a@b.co', 'targeted'))
      expect(next[1]).to.deep.equal(catchAllRule('new'))
    })

    it('appends into an empty scope', () => {
      expect(upsertFallbackRule([], 'new')).to.deep.equal([catchAllRule('new')])
    })

    it('does not mutate the input rules', () => {
      const rules = [bareCatchAll('old')]
      upsertFallbackRule(rules, 'new')
      expect(rules[0].value).to.equal('old')
    })
  })

  describe('catchAllRule', () => {
    it('writes the ALWAYS_TRUE spelling (qfg-gv54)', () => {
      expect(catchAllRule({type: 'bool', value: true})).to.deep.equal({
        criteria: [{operator: 'ALWAYS_TRUE'}],
        value: {type: 'bool', value: true},
      })
    })
  })

  describe('seedScopeRules', () => {
    const config = {
      default: {rules: [targeting('a@b.co', 'targeted'), alwaysTrue('fallback')]},
      environments: [{id: 'staging', rules: [alwaysTrue('staging value')]}],
    }

    it('returns the default block when no environment is named', () => {
      const {rules, seeded} = seedScopeRules(config)
      expect(seeded).to.equal(false)
      expect(rules).to.deep.equal(config.default.rules)
    })

    it("returns the environment's own rules when it has a block", () => {
      const {rules, seeded} = seedScopeRules(config, 'staging')
      expect(seeded).to.equal(false)
      expect(rules).to.deep.equal([alwaysTrue('staging value')])
    })

    it('seeds a missing environment from a DEEP CLONE of default.rules', () => {
      const {rules, seeded} = seedScopeRules(config, 'production')
      expect(seeded).to.equal(true)
      expect(rules).to.deep.equal(config.default.rules)

      // Mutating the clone must not reach the document's default block.
      rules[0].value = 'mutated'
      expect(config.default.rules[0].value).to.equal('targeted')
    })

    it('does not claim a seed when there is nothing to copy', () => {
      const {rules, seeded} = seedScopeRules({default: {rules: []}, environments: []}, 'production')
      expect(seeded).to.equal(false)
      expect(rules).to.deep.equal([])
    })
  })

  describe('upsertEnvRules', () => {
    it('replaces the named environment in place', () => {
      const envs = [
        {id: 'staging', rules: [alwaysTrue(1)]},
        {id: 'production', rules: [alwaysTrue(2)]},
      ]
      expect(upsertEnvRules(envs, 'production', [alwaysTrue(3)])).to.deep.equal([
        {id: 'staging', rules: [alwaysTrue(1)]},
        {id: 'production', rules: [alwaysTrue(3)]},
      ])
    })

    it('appends an environment that has no block yet', () => {
      expect(upsertEnvRules([], 'production', [alwaysTrue(1)])).to.deep.equal([
        {id: 'production', rules: [alwaysTrue(1)]},
      ])
    })
  })
})
