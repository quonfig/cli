import {expect} from 'chai'

import {mapLaunchDarklyOperator} from '../../src/migrate/quonfig-target/operators.js'
import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {
  buildRule,
  clauseToCriterion,
  collapseEnvironment,
  normalizeAttribute,
  rolloutToWeightedValues,
  type RulesetContext,
} from '../../src/migrate/quonfig-target/ruleset.js'
import {inferFlagValueType, inferValueType, toQuonfigValue} from '../../src/migrate/quonfig-target/values.js'

describe('migrate/quonfig-target', () => {
  describe('operators.mapLaunchDarklyOperator', () => {
    it('maps directly-negatable string operators in both directions', () => {
      expect(mapLaunchDarklyOperator('in', false)).to.deep.equal({operator: 'PROP_IS_ONE_OF'})
      expect(mapLaunchDarklyOperator('in', true)).to.deep.equal({operator: 'PROP_IS_NOT_ONE_OF'})
      expect(mapLaunchDarklyOperator('segmentMatch', true)).to.deep.equal({operator: 'NOT_IN_SEG'})
    })

    it('maps non-negated comparison/date/semver operators directly', () => {
      expect(mapLaunchDarklyOperator('lessThan', false)).to.deep.equal({operator: 'PROP_LESS_THAN'})
      expect(mapLaunchDarklyOperator('before', false)).to.deep.equal({operator: 'PROP_BEFORE'})
      expect(mapLaunchDarklyOperator('semVerGreaterThan', false)).to.deep.equal({operator: 'PROP_SEMVER_GREATER_THAN'})
    })

    it('skips NEGATED comparison/date/semver operators (D3 — no algebraic flip)', () => {
      const result = mapLaunchDarklyOperator('lessThan', true)
      expect(result).to.have.property('skip', true)
      // Revert check: the skip must be specifically because of negation, not a
      // blanket "lessThan unsupported" — flip negate back and it converts.
      expect(mapLaunchDarklyOperator('lessThan', false)).to.not.have.property('skip')
    })

    it('skips applicationVersionSupported and unrecognized operators', () => {
      expect(mapLaunchDarklyOperator('applicationVersionSupported', false)).to.have.property('skip', true)
      expect(mapLaunchDarklyOperator('madeUpOp', false)).to.have.property('skip', true)
    })
  })

  describe('values', () => {
    it('inferValueType discriminates bool / int / double / string / json', () => {
      expect(inferValueType(true)).to.equal('bool')
      expect(inferValueType(3)).to.equal('int')
      expect(inferValueType(3.14)).to.equal('double')
      expect(inferValueType('x')).to.equal('string')
      expect(inferValueType({a: 1})).to.equal('json')
      expect(inferValueType([1, 2])).to.equal('json')
    })

    it('inferFlagValueType returns bool for boolean kind regardless of values', () => {
      expect(inferFlagValueType('boolean', [true, false])).to.equal('bool')
    })

    it('inferFlagValueType widens int→double when any variation is fractional', () => {
      expect(inferFlagValueType('multivariate', [0, 1, 2])).to.equal('int')
      expect(inferFlagValueType('multivariate', [0, 0.5, 1])).to.equal('double')
    })

    it('toQuonfigValue honors the declared flag value type over the raw shape', () => {
      // A double flag whose variation is the integer 2 still serializes as double.
      expect(toQuonfigValue(2, 'double')).to.deep.equal({type: 'double', value: 2})
      expect(toQuonfigValue('on', 'string')).to.deep.equal({type: 'string', value: 'on'})
      expect(toQuonfigValue({theme: 'dark'}, 'json')).to.deep.equal({type: 'json', value: {theme: 'dark'}})
    })
  })

  describe('ruleset.normalizeAttribute', () => {
    it('prefixes the context kind, defaulting to user', () => {
      expect(normalizeAttribute(undefined, 'email')).to.equal('user.email')
      expect(normalizeAttribute('organization', 'plan')).to.equal('organization.plan')
    })

    it('flattens a nested JSON-pointer attribute to a dotted path', () => {
      expect(normalizeAttribute('user', '/address/city')).to.equal('user.address.city')
    })
  })

  function ctx(over: Partial<RulesetContext> = {}): RulesetContext {
    return {
      report: new ConversionReport(),
      sourceKey: 'fx-flag',
      valueType: 'string',
      variationValues: ['control', 'treatment'],
      ...over,
    }
  }

  describe('ruleset.clauseToCriterion', () => {
    it('builds a string_list valueToMatch for multi-value operators', () => {
      const c = clauseToCriterion({attribute: 'email', op: 'in', values: ['a@x.com', 'b@x.com']}, ctx())
      expect(c).to.deep.equal({
        operator: 'PROP_IS_ONE_OF',
        propertyName: 'user.email',
        valueToMatch: {type: 'string_list', value: ['a@x.com', 'b@x.com']},
      })
    })

    it('builds a numeric valueToMatch for comparison operators', () => {
      const c = clauseToCriterion({attribute: 'age', op: 'lessThan', values: [18]}, ctx())
      expect(c).to.deep.equal({
        operator: 'PROP_LESS_THAN',
        propertyName: 'user.age',
        valueToMatch: {type: 'int', value: 18},
      })
    })

    it('returns null and reports when the clause operator cannot be mapped (D3)', () => {
      const report = new ConversionReport()
      const c = clauseToCriterion({attribute: 'age', negate: true, op: 'lessThan', values: [18]}, ctx({report}))
      expect(c).to.equal(null)
      expect(report.byCategory('skipped-rule')).to.have.length(1)
      expect(report.byCategory('skipped-rule')[0].detail).to.match(/negated comparison/)
    })

    it('keeps only the first segment key for a multi-segment segmentMatch and reports the rest', () => {
      const report = new ConversionReport()
      const c = clauseToCriterion(
        {attribute: 'segmentMatch', op: 'segmentMatch', values: ['seg-a', 'seg-b']},
        ctx({report}),
      )
      expect(c!.operator).to.equal('IN_SEG')
      expect(c!.valueToMatch).to.deep.equal({type: 'string', value: 'seg-a'})
      expect(report.size).to.equal(1)
    })
  })

  describe('ruleset.buildRule', () => {
    it('ANDs all clauses into one rule', () => {
      const rule = buildRule(
        [
          {attribute: 'email', op: 'endsWith', values: ['@acme.com']},
          {attribute: 'plan', contextKind: 'organization', op: 'in', values: ['enterprise']},
        ],
        {type: 'string', value: 'treatment'},
        ctx(),
      )
      expect(rule!.criteria).to.have.length(2)
      expect(rule!.criteria[1].propertyName).to.equal('organization.plan')
    })

    it('drops the WHOLE rule (not just the clause) when any clause is unmappable', () => {
      const report = new ConversionReport()
      // A two-clause AND: one good clause, one negated-comparison clause.
      // Dropping only the bad clause would broaden targeting — the whole rule
      // must be dropped instead.
      const rule = buildRule(
        [
          {attribute: 'email', op: 'in', values: ['a@x.com']},
          {attribute: 'age', negate: true, op: 'greaterThan', values: [21]},
        ],
        {type: 'string', value: 'treatment'},
        ctx({report}),
      )
      expect(rule).to.equal(null)
      expect(report.byCategory('skipped-rule')).to.have.length(1)
    })
  })

  describe('ruleset.rolloutToWeightedValues', () => {
    it('converts weights and reports re-bucketing', () => {
      const report = new ConversionReport()
      const wv = rolloutToWeightedValues(
        {
          variations: [
            {variation: 0, weight: 60_000},
            {variation: 1, weight: 40_000},
          ],
        },
        ctx({report}),
      )
      expect(wv.type).to.equal('weighted_values')
      expect(wv.value.hashByPropertyName).to.equal('user.key')
      expect(wv.value.weightedValues).to.deep.equal([
        {value: {type: 'string', value: 'control'}, weight: 60_000},
        {value: {type: 'string', value: 'treatment'}, weight: 40_000},
      ])
      expect(report.byCategory('rebucketed-rollout')).to.have.length(1)
    })

    it('drops experiment metadata + reports it, and maps bucketBy to hashByPropertyName', () => {
      const report = new ConversionReport()
      const wv = rolloutToWeightedValues(
        {bucketBy: 'email', kind: 'experiment', seed: 12_345, variations: [{variation: 0, weight: 100_000}]},
        ctx({report}),
      )
      expect(wv.value.hashByPropertyName).to.equal('user.email')
      expect(report.byCategory('dropped-experiment-metadata')).to.have.length(1)
      expect(report.byCategory('dropped-experiment-metadata')[0].detail).to.match(/seed 12345/)
    })
  })

  describe('ruleset.collapseEnvironment', () => {
    it('collapses on:false into a single ALWAYS_TRUE rule serving offVariation', () => {
      const rules = collapseEnvironment({offVariation: 1, on: false}, ctx())
      expect(rules).to.deep.equal([
        {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'treatment'}},
      ])
    })

    it('collapses on:true into leading target rules + rules + a trailing fallthrough rule', () => {
      const report = new ConversionReport()
      const rules = collapseEnvironment(
        {
          fallthrough: {variation: 0},
          on: true,
          rules: [{clauses: [{attribute: 'email', op: 'in', values: ['vip@x.com']}], variation: 1}],
          targets: [{values: ['user-a', 'user-b'], variation: 1}],
        },
        ctx({report}),
      )
      // [0] = target rule, [1] = the in-clause rule, [2] = fallthrough.
      expect(rules).to.have.length(3)
      expect(rules[0].criteria[0]).to.deep.equal({
        operator: 'PROP_IS_ONE_OF',
        propertyName: 'user.key',
        valueToMatch: {type: 'string_list', value: ['user-a', 'user-b']},
      })
      expect(rules[1].criteria[0].propertyName).to.equal('user.email')
      expect(rules[2].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
      expect(rules[2].value).to.deep.equal({type: 'string', value: 'control'})
      expect(report.byCategory('individual-target-as-rule')).to.have.length(1)
    })

    it('enriches the individual-target-as-rule note with the LD targets-pane UI-loss trade-off + beta_user alternative (qfg-1xow)', () => {
      const report = new ConversionReport()
      collapseEnvironment(
        {fallthrough: {variation: 0}, on: true, targets: [{values: ['user-a', 'user-b'], variation: 1}]},
        ctx({report}),
      )
      const notes = report.byCategory('individual-target-as-rule')
      expect(notes).to.have.length(1)
      const detail = notes[0].detail
      // Count + new "inlined" verb (replaces the bland "converted").
      expect(detail).to.match(/2 user key\(s\) inlined into a leading PROP_IS_ONE_OF rule on user\.key/)
      // The trade-off copy — the specific mechanism this bead adds.
      expect(detail).to.match(/Trade-off/)
      expect(detail).to.match(/LD 'targets' UI pane/)
      expect(detail).to.match(/qfg set/)
      // Suggested alternative — beta_user context attribute for beta-list-style toggling.
      expect(detail).to.match(/beta_user/)
    })

    it('drops prerequisites silently and still converts the rest of the environment (reporting is owned by translateFlag — qfg-nb4n)', () => {
      const report = new ConversionReport()
      const rules = collapseEnvironment(
        {fallthrough: {variation: 0}, on: true, prerequisites: [{key: 'other-flag', variation: 0}]},
        ctx({report}),
      )
      expect(rules).to.have.length(1) // fallthrough still produced
      // collapseEnvironment no longer emits the note — translateFlag dedupes
      // across envs and emits one enriched note per child flag instead.
      expect(report.byCategory('dropped-prerequisite')).to.have.length(0)
    })
  })
})
