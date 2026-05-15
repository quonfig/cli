import {expect} from 'chai'

import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {
  flagOutputPath,
  segmentOutputPath,
  translateFlag,
  translateSegment,
} from '../../src/migrate/sources/launchdarkly/translate.js'
import type {LDFlag, LDSegment} from '../../src/migrate/sources/launchdarkly/types.js'

describe('migrate/sources/launchdarkly/translate', () => {
  describe('output paths', () => {
    it('routes flags to feature-flags/ and segments to segments/', () => {
      expect(flagOutputPath('fx-var-boolean')).to.equal('feature-flags/fx-var-boolean.json')
      expect(segmentOutputPath('seg-internal')).to.equal('segments/seg-internal.json')
    })
  })

  describe('translateFlag — variation types', () => {
    it('maps a boolean flag to valueType bool with bool variants', () => {
      const flag: LDFlag = {
        environments: {test: {fallthrough: {variation: 0}, on: true}},
        key: 'fx-var-boolean',
        kind: 'boolean',
        variations: [{value: true}, {value: false}],
      }
      const out = translateFlag(flag, new ConversionReport())
      expect(out.valueType).to.equal('bool')
      expect(out.variants).to.deep.equal([{value: {type: 'bool', value: true}}, {value: {type: 'bool', value: false}}])
    })

    it('infers double for a multivariate flag with a fractional variation', () => {
      const flag: LDFlag = {
        environments: {test: {fallthrough: {variation: 0}, on: true}},
        key: 'fx-var-number-float',
        kind: 'multivariate',
        variations: [{value: 0}, {value: 0.5}, {value: 3.141_59}],
      }
      const out = translateFlag(flag, new ConversionReport())
      expect(out.valueType).to.equal('double')
      // Declared type wins — the integer 0 still serializes as double.
      expect((out.variants as Array<{value: unknown}>)[0].value).to.deep.equal({type: 'double', value: 0})
    })
  })

  describe('translateFlag — on/off collapse (plan §5.2)', () => {
    it('collapses on:false to a single ALWAYS_TRUE rule serving offVariation', () => {
      const flag: LDFlag = {
        environments: {test: {offVariation: 1, on: false}},
        key: 'fx-state-off',
        kind: 'boolean',
        variations: [{value: true}, {value: false}],
      }
      const out = translateFlag(flag, new ConversionReport())
      const env = (out.environments as Array<{id: string; rules: unknown[]}>)[0]
      expect(env.id).to.equal('test')
      expect(env.rules).to.deep.equal([{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}}])
    })

    it('translates an on flag: rule then trailing fallthrough rule, order preserved', () => {
      const flag: LDFlag = {
        environments: {
          production: {
            fallthrough: {variation: 1},
            on: true,
            rules: [{clauses: [{attribute: 'email', op: 'endsWith', values: ['@acme.com']}], variation: 0}],
          },
        },
        key: 'fx-rule-single',
        kind: 'multivariate',
        variations: [
          {name: 'on', value: 'on'},
          {name: 'off', value: 'off'},
        ],
      }
      const out = translateFlag(flag, new ConversionReport())
      const env = (out.environments as Array<{id: string; rules: Array<{criteria: unknown[]; value: unknown}>}>)[0]
      expect(env.id).to.equal('production')
      expect(env.rules).to.have.length(2)
      expect(env.rules[0].criteria[0]).to.deep.equal({
        operator: 'PROP_ENDS_WITH_ONE_OF',
        propertyName: 'user.email',
        valueToMatch: {type: 'string_list', value: ['@acme.com']},
      })
      expect(env.rules[1]).to.deep.equal({
        criteria: [{operator: 'ALWAYS_TRUE'}],
        value: {type: 'string', value: 'off'},
      })
    })
  })

  describe('translateFlag — gap reporting (plan §5.4)', () => {
    it('reports dropped prerequisites, maintainer, customProperties and mobile-key availability', () => {
      const report = new ConversionReport()
      const flag: LDFlag = {
        clientSideAvailability: {usingEnvironmentId: true, usingMobileKey: true},
        customProperties: {jira: {value: ['QFG-1']}},
        environments: {
          test: {fallthrough: {variation: 0}, on: true, prerequisites: [{key: 'parent-flag', variation: 0}]},
        },
        key: 'fx-meta',
        kind: 'boolean',
        maintainerId: 'member-123',
        variations: [{value: true}, {value: false}],
      }
      translateFlag(flag, report)
      expect(report.byCategory('dropped-prerequisite')).to.have.length(1)
      expect(report.byCategory('dropped-prerequisite')[0].detail).to.match(/parent-flag/)
      expect(report.byCategory('dropped-maintainer')).to.have.length(1)
      expect(report.byCategory('dropped-custom-properties')).to.have.length(1)
      // Both surfaces enabled — flag is still client-visible via usingEnvironmentId.
      expect(report.byCategory('dropped-mobile-key-still-visible')).to.have.length(1)
      expect(report.byCategory('dropped-mobile-key-now-server-only')).to.have.length(0)
    })

    it('classifies usingMobileKey:true + usingEnvironmentId:false as now-server-only (must-fix)', () => {
      const report = new ConversionReport()
      const flag: LDFlag = {
        clientSideAvailability: {usingEnvironmentId: false, usingMobileKey: true},
        environments: {test: {fallthrough: {variation: 0}, on: true}},
        key: 'fx-mobile-only',
        kind: 'boolean',
        variations: [{value: true}, {value: false}],
      }
      translateFlag(flag, report)
      expect(report.byCategory('dropped-mobile-key-now-server-only')).to.have.length(1)
      expect(report.byCategory('dropped-mobile-key-still-visible')).to.have.length(0)
      expect(report.byCategory('dropped-mobile-key-now-server-only')[0].detail).to.match(/mobile/i)
    })

    it('emits no mobile-key note when usingMobileKey is false', () => {
      const report = new ConversionReport()
      const flag: LDFlag = {
        clientSideAvailability: {usingEnvironmentId: true, usingMobileKey: false},
        environments: {test: {fallthrough: {variation: 0}, on: true}},
        key: 'fx-no-mobile',
        kind: 'boolean',
        variations: [{value: true}, {value: false}],
      }
      translateFlag(flag, report)
      expect(report.byCategory('dropped-mobile-key-still-visible')).to.have.length(0)
      expect(report.byCategory('dropped-mobile-key-now-server-only')).to.have.length(0)
    })

    it('never emits sendToClientSdk on a feature flag (qfg-verify would reject it)', () => {
      const flag: LDFlag = {
        clientSideAvailability: {usingEnvironmentId: true, usingMobileKey: false},
        environments: {test: {fallthrough: {variation: 0}, on: true}},
        key: 'fx-csa',
        kind: 'boolean',
        variations: [{value: true}, {value: false}],
      }
      const out = translateFlag(flag, new ConversionReport())
      expect(out).to.not.have.property('sendToClientSdk')
    })
  })

  describe('translateSegment', () => {
    it('collapses included/excluded into first-match rules with excluded winning, then a catch-all false', () => {
      const seg: LDSegment = {
        excluded: ['banned-user'],
        included: ['vip-user'],
        key: 'seg-mixed',
        name: 'Mixed Segment',
      }
      const out = translateSegment(seg, new ConversionReport())
      expect(out.type).to.equal('segment')
      expect(out.valueType).to.equal('bool')
      const rules = (out.default as {rules: Array<{criteria: unknown[]; value: unknown}>}).rules
      // excluded first (false), included next (true), trailing catch-all (false).
      expect(rules).to.deep.equal([
        {
          criteria: [
            {
              operator: 'PROP_IS_ONE_OF',
              propertyName: 'user.key',
              valueToMatch: {type: 'string_list', value: ['banned-user']},
            },
          ],
          value: {type: 'bool', value: false},
        },
        {
          criteria: [
            {
              operator: 'PROP_IS_ONE_OF',
              propertyName: 'user.key',
              valueToMatch: {type: 'string_list', value: ['vip-user']},
            },
          ],
          value: {type: 'bool', value: true},
        },
        {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
      ])
    })

    it('reports an unbounded (big/synced) segment as having unexportable membership', () => {
      const report = new ConversionReport()
      const seg: LDSegment = {key: 'seg-big-synced', unbounded: true, unboundedContextKind: 'user'}
      translateSegment(seg, report)
      expect(report.byCategory('unexportable-segment-membership')).to.have.length(1)
    })
  })
})
