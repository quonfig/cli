/**
 * Unit tests for the Flagsmith converter (Epic 3).
 *
 * Each test exercises one branch of `translateFeature` / `translateSegment` /
 * `mapCondition` against a hand-built FlagsmithFeatureWithStates or
 * FlagsmithSegment. Table-driven where the surface is symmetric (operator
 * mapping, :semver detection).
 */

import {expect} from 'chai'

import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {
  flagOutputPath,
  mapCondition,
  segmentOutputPath,
  translateFeature,
  translateSegment,
} from '../../src/migrate/sources/flagsmith/translate.js'
import type {
  FlagsmithFeature,
  FlagsmithFeatureState,
  FlagsmithFeatureWithStates,
  FlagsmithSegment,
} from '../../src/migrate/sources/flagsmith/types.js'

// ── helpers ─────────────────────────────────────────────────────────────

function makeFeature(overrides: Partial<FlagsmithFeature> = {}): FlagsmithFeature {
  return {
    default_enabled: true,
    id: 1,
    is_archived: false,
    multivariate_options: [],
    name: 'fx-test',
    project: 38_856,
    tags: [],
    type: 'STANDARD',
    uuid: 'u',
    ...overrides,
  }
}

function makeBoolBundle(opts: {
  enabled: boolean
  envApiKey?: string
  identityOverrides?: FlagsmithFeatureWithStates['featurestates_by_env'][string]['identity_overrides']
  name?: string
  segmentOverrides?: FlagsmithFeatureState[]
  value: boolean | number | string
}): FlagsmithFeatureWithStates {
  const envApiKey = opts.envApiKey ?? 'apk-dev'
  return {
    feature: makeFeature({name: opts.name ?? 'fx-bool', type: 'STANDARD'}),
    feature_segments_by_env: {[envApiKey]: []},
    featurestates_by_env: {
      [envApiKey]: {
        default: {
          enabled: opts.enabled,
          environment: 1,
          feature: 1,
          feature_segment: null,
          feature_state_value: {
            boolean_value: typeof opts.value === 'boolean' ? opts.value : null,
            integer_value: typeof opts.value === 'number' ? opts.value : null,
            string_value: typeof opts.value === 'string' ? opts.value : null,
            type: typeof opts.value === 'boolean' ? 'bool' : typeof opts.value === 'number' ? 'int' : 'unicode',
          },
          id: 9000,
          multivariate_feature_state_values: [],
          uuid: 'fs-uuid',
        },
        identity_overrides: opts.identityOverrides ?? [],
        segment_overrides: opts.segmentOverrides ?? [],
      },
    },
  }
}

const projectEnvMap = (api: string, name: string) => new Map<string, string>([[api, name]])

// ── translateFeature ────────────────────────────────────────────────────

describe('migrate/sources/flagsmith/translate', () => {
  describe('output paths', () => {
    it('routes features to feature-flags/ and segments to segments/', () => {
      expect(flagOutputPath('fx-bool')).to.equal('feature-flags/fx-bool.json')
      expect(segmentOutputPath('fx-seg-a')).to.equal('segments/fx-seg-a.json')
    })
  })

  describe('translateFeature — boolean STANDARD, enabled=true, no overrides', () => {
    it('emits one ALWAYS_TRUE rule serving the env-default value', () => {
      const bundle = makeBoolBundle({enabled: true, value: true})
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {envNameByApiKey: projectEnvMap('apk-dev', 'Development')})
      expect(out.valueType).to.equal('bool')
      expect((out.environments as Array<{id: string; rules: unknown[]}>)[0].id).to.equal('development')
      const rules = (out.environments as Array<{rules: Array<{criteria: unknown[]; value: unknown}>}>)[0].rules
      expect(rules).to.deep.equal([{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: true}}])
      // Implicit boolean variants from `buildVariants` so the UI renders the rollout editor.
      expect(out.variants).to.deep.equal([
        {name: 'true', value: {type: 'bool', value: true}},
        {name: 'false', value: {type: 'bool', value: false}},
      ])
      expect(report.size).to.equal(0)
    })
  })

  describe('translateFeature — D-F1 enabled=false', () => {
    it('boolean feature serves false silently (no report entry)', () => {
      const bundle = makeBoolBundle({enabled: false, value: true})
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {envNameByApiKey: projectEnvMap('apk-dev', 'Development')})
      const rules = (out.environments as Array<{rules: Array<{value: unknown}>}>)[0].rules
      expect(rules[0].value).to.deep.equal({type: 'bool', value: false})
      expect(report.byCategory('enabled-false-non-boolean')).to.have.length(0)
    })

    it('string feature serves the stored value AND emits a loud sentinel entry', () => {
      const bundle = makeBoolBundle({enabled: false, value: 'fallback-string'})
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {envNameByApiKey: projectEnvMap('apk-dev', 'Development')})
      expect(out.valueType).to.equal('string')
      const rules = (out.environments as Array<{rules: Array<{value: unknown}>}>)[0].rules
      expect(rules[0].value).to.deep.equal({type: 'string', value: 'fallback-string'})
      const notes = report.byCategory('enabled-false-non-boolean')
      expect(notes).to.have.length(1)
      expect(notes[0].detail).to.contain("Flagsmith would have served your code's default")
    })
  })

  describe('translateFeature — MULTIVARIATE without overrides', () => {
    it('emits a weighted_values trailing rule from inline mv options', () => {
      const bundle: FlagsmithFeatureWithStates = {
        feature: makeFeature({
          multivariate_options: [
            {
              boolean_value: null,
              default_percentage_allocation: 60,
              id: 1,
              integer_value: null,
              string_value: 'control',
              type: 'unicode',
              uuid: 'mv1',
            },
            {
              boolean_value: null,
              default_percentage_allocation: 40,
              id: 2,
              integer_value: null,
              string_value: 'treatment',
              type: 'unicode',
              uuid: 'mv2',
            },
          ],
          name: 'fx-mv',
          type: 'MULTIVARIATE',
        }),
        feature_segments_by_env: {'apk-dev': []},
        featurestates_by_env: {
          'apk-dev': {
            default: {
              enabled: true,
              environment: 1,
              feature: 1,
              feature_segment: null,
              feature_state_value: {boolean_value: null, integer_value: null, string_value: 'control', type: 'unicode'},
              id: 9001,
              multivariate_feature_state_values: [],
              uuid: 'fs-uuid',
            },
            identity_overrides: [],
            segment_overrides: [],
          },
        },
      }
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {envNameByApiKey: projectEnvMap('apk-dev', 'Development')})
      expect(out.valueType).to.equal('string')
      const rules = (out.environments as Array<{rules: Array<{value: {type: string; value: unknown}}>}>)[0].rules
      expect(rules[0].value.type).to.equal('weighted_values')
      const wv = rules[0].value.value as {weightedValues: Array<{value: {type: string; value: string}; weight: number}>}
      expect(wv.weightedValues).to.deep.equal([
        {value: {type: 'string', value: 'control'}, weight: 60_000},
        {value: {type: 'string', value: 'treatment'}, weight: 40_000},
      ])
      // Variants populated from mv options.
      expect(out.variants).to.have.length(2)
    })

    it('normalizes mv allocations that violate the weight predicate (qfg-wis6.11)', () => {
      const bundle: FlagsmithFeatureWithStates = {
        feature: makeFeature({
          multivariate_options: [
            {
              boolean_value: null,
              default_percentage_allocation: 60,
              id: 1,
              integer_value: null,
              string_value: 'control',
              type: 'unicode',
              uuid: 'mv1',
            },
            {
              boolean_value: null,
              default_percentage_allocation: 30,
              id: 2,
              integer_value: null,
              string_value: 'treatment',
              type: 'unicode',
              uuid: 'mv2',
            },
          ],
          name: 'fx-mv-short',
          type: 'MULTIVARIATE',
        }),
        feature_segments_by_env: {'apk-dev': []},
        featurestates_by_env: {
          'apk-dev': {
            default: {
              enabled: true,
              environment: 1,
              feature: 1,
              feature_segment: null,
              feature_state_value: {boolean_value: null, integer_value: null, string_value: 'control', type: 'unicode'},
              id: 9001,
              multivariate_feature_state_values: [],
              uuid: 'fs-uuid',
            },
            identity_overrides: [],
            segment_overrides: [],
          },
        },
      }
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {envNameByApiKey: projectEnvMap('apk-dev', 'Development')})
      const rules = (out.environments as Array<{rules: Array<{value: {type: string; value: unknown}}>}>)[0].rules
      const wv = rules[0].value.value as {weightedValues: Array<{weight: number}>}
      // 60/30 (sum 90) — SDKs would serve 66.7/33.3; the stored weights now
      // say so explicitly and satisfy the predicate.
      expect(wv.weightedValues.map((entry) => entry.weight)).to.deep.equal([66_667, 33_333])
      expect(report.byCategory('normalized-rollout-weights').length).to.be.greaterThan(0)
    })
  })

  describe('translateFeature — segment override', () => {
    it('emits an IN_SEG rule for one segment override before the trailing ALWAYS_TRUE', () => {
      const bundle: FlagsmithFeatureWithStates = {
        feature: makeFeature({name: 'fx-bool-segov'}),
        feature_segments_by_env: {
          'apk-dev': [{environment: 1, id: 99, priority: 0, segment: 7, uuid: 'fsg-1'}],
        },
        featurestates_by_env: {
          'apk-dev': {
            default: {
              enabled: true,
              environment: 1,
              feature: 1,
              feature_segment: null,
              feature_state_value: {boolean_value: false, integer_value: null, string_value: null, type: 'bool'},
              id: 9000,
              multivariate_feature_state_values: [],
              uuid: 'fs-uuid',
            },
            identity_overrides: [],
            segment_overrides: [
              {
                enabled: true,
                environment: 1,
                feature: 1,
                feature_segment: {id: 99, priority: 0, segment: 7, uuid: 'fsg-1'},
                feature_state_value: {boolean_value: true, integer_value: null, string_value: null, type: 'bool'},
                id: 9100,
                multivariate_feature_state_values: [],
                uuid: 'fs-uuid-segov',
              },
            ],
          },
        },
      }
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {
        envNameByApiKey: projectEnvMap('apk-dev', 'Development'),
        segmentNameById: new Map([[7, 'beta-users']]),
      })
      const rules = (out.environments as Array<{rules: Array<{criteria: unknown[]; value: unknown}>}>)[0].rules
      expect(rules).to.have.length(2)
      expect(rules[0]).to.deep.equal({
        criteria: [{operator: 'IN_SEG', valueToMatch: {type: 'string', value: 'beta-users'}}],
        value: {type: 'bool', value: true},
      })
      expect(rules[1].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
    })
  })

  describe('translateFeature — identity override (pinned)', () => {
    it('emits a leading PROP_IS_ONE_OF rule on user.key serving the override value', () => {
      const bundle = makeBoolBundle({
        enabled: true,
        identityOverrides: [
          {
            feature_state: {
              enabled: true,
              feature: 1,
              feature_state_value: false,
              multivariate_feature_state_values: [],
            },
            identifier: 'beta-user-7',
            identity_uuid: 'iduuid',
          },
        ],
        value: true,
      })
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {envNameByApiKey: projectEnvMap('apk-dev', 'Development')})
      const rules = (out.environments as Array<{rules: Array<{criteria: unknown[]; value: unknown}>}>)[0].rules
      expect(rules).to.have.length(2)
      expect(rules[0]).to.deep.equal({
        criteria: [
          {
            operator: 'PROP_IS_ONE_OF',
            propertyName: 'user.key',
            valueToMatch: {type: 'string_list', value: ['beta-user-7']},
          },
        ],
        value: {type: 'bool', value: false},
      })
      expect(report.byCategory('identity-override-as-rule')).to.have.length(1)
    })
  })

  describe('translateFeature — D-F2 identity > segment ordering', () => {
    it('places identity-override rules before segment-override rules', () => {
      const bundle: FlagsmithFeatureWithStates = {
        feature: makeFeature({name: 'fx-bool-order'}),
        feature_segments_by_env: {'apk-dev': [{environment: 1, id: 99, priority: 0, segment: 7, uuid: 'fsg-1'}]},
        featurestates_by_env: {
          'apk-dev': {
            default: {
              enabled: true,
              environment: 1,
              feature: 1,
              feature_segment: null,
              feature_state_value: {boolean_value: false, integer_value: null, string_value: null, type: 'bool'},
              id: 9000,
              multivariate_feature_state_values: [],
              uuid: 'fs-uuid',
            },
            identity_overrides: [
              {
                feature_state: {
                  enabled: true,
                  feature: 1,
                  feature_state_value: true,
                  multivariate_feature_state_values: [],
                },
                identifier: 'id-1',
                identity_uuid: 'iduuid',
              },
            ],
            segment_overrides: [
              {
                enabled: true,
                environment: 1,
                feature: 1,
                feature_segment: {id: 99, priority: 0, segment: 7, uuid: 'fsg-1'},
                feature_state_value: {boolean_value: true, integer_value: null, string_value: null, type: 'bool'},
                id: 9100,
                multivariate_feature_state_values: [],
                uuid: 'fs-uuid-segov',
              },
            ],
          },
        },
      }
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {
        envNameByApiKey: projectEnvMap('apk-dev', 'Development'),
        segmentNameById: new Map([[7, 'beta-users']]),
      })
      const rules = (out.environments as Array<{rules: Array<{criteria: Array<{operator: string}>}>}>)[0].rules
      expect(rules).to.have.length(3)
      expect(rules[0].criteria[0].operator).to.equal('PROP_IS_ONE_OF') // identity
      expect(rules[1].criteria[0].operator).to.equal('IN_SEG') // segment
      expect(rules[2].criteria[0].operator).to.equal('ALWAYS_TRUE') // trailing
    })
  })

  describe('translateFeature — D-F5 cross-env value-type divergence', () => {
    it('coerces to string and emits a loud report entry', () => {
      const bundle: FlagsmithFeatureWithStates = {
        feature: makeFeature({name: 'fx-divergent'}),
        feature_segments_by_env: {dev: [], prod: []},
        featurestates_by_env: {
          dev: {
            default: {
              enabled: true,
              environment: 1,
              feature: 1,
              feature_segment: null,
              feature_state_value: {boolean_value: null, integer_value: 42, string_value: null, type: 'int'},
              id: 1,
              multivariate_feature_state_values: [],
              uuid: 'fs-dev',
            },
            identity_overrides: [],
            segment_overrides: [],
          },
          prod: {
            default: {
              enabled: true,
              environment: 2,
              feature: 1,
              feature_segment: null,
              feature_state_value: {
                boolean_value: null,
                integer_value: null,
                string_value: 'forty-two',
                type: 'unicode',
              },
              id: 2,
              multivariate_feature_state_values: [],
              uuid: 'fs-prod',
            },
            identity_overrides: [],
            segment_overrides: [],
          },
        },
      }
      const report = new ConversionReport()
      const out = translateFeature(bundle, report, {
        envNameByApiKey: new Map([
          ['dev', 'Development'],
          ['prod', 'Production'],
        ]),
      })
      expect(out.valueType).to.equal('string')
      const envs = out.environments as Array<{id: string; rules: Array<{value: {type: string; value: string}}>}>
      const devRules = envs.find((e) => e.id === 'development')!.rules
      expect(devRules[0].value).to.deep.equal({type: 'string', value: '42'})
      const notes = report.byCategory('cross-env-value-type-coerced')
      expect(notes).to.have.length(1)
      expect(notes[0].detail).to.contain('coerced to string')
    })
  })

  // ── operator mapping (plan §5.3) ──────────────────────────────────────

  describe('mapCondition — operator mapping per plan §5.3', () => {
    const ok = (
      label: string,
      input: {operator: string; property?: string; value?: null | string},
      expected: object,
    ) => {
      it(label, () => {
        const result = mapCondition(input as Parameters<typeof mapCondition>[0])
        expect(result).to.have.property('criterion')
        expect((result as {criterion: object}).criterion).to.deep.equal(expected)
      })
    }

    const drop = (
      label: string,
      input: {operator: string; property?: string; value?: null | string},
      reasonMatch: RegExp,
    ) => {
      it(label, () => {
        const result = mapCondition(input as Parameters<typeof mapCondition>[0])
        expect(result).to.have.property('drop', true)
        expect((result as {reason: string}).reason).to.match(reasonMatch)
      })
    }

    ok(
      'EQUAL → PROP_IS_ONE_OF',
      {operator: 'EQUAL', property: 'plan', value: 'enterprise'},
      {operator: 'PROP_IS_ONE_OF', propertyName: 'plan', valueToMatch: {type: 'string_list', value: ['enterprise']}},
    )
    ok(
      'EQUAL :semver → PROP_SEMVER_EQUAL',
      {operator: 'EQUAL', property: 'version', value: '4.2.0:semver'},
      {operator: 'PROP_SEMVER_EQUAL', propertyName: 'version', valueToMatch: {type: 'string', value: '4.2.0'}},
    )
    ok(
      'NOT_EQUAL → PROP_IS_NOT_ONE_OF',
      {operator: 'NOT_EQUAL', property: 'plan', value: 'free'},
      {operator: 'PROP_IS_NOT_ONE_OF', propertyName: 'plan', valueToMatch: {type: 'string_list', value: ['free']}},
    )
    drop(
      'NOT_EQUAL :semver → drops',
      {operator: 'NOT_EQUAL', property: 'v', value: '1.0:semver'},
      /NOT_EQUAL with :semver/,
    )

    ok(
      'GREATER_THAN → PROP_GREATER_THAN (int)',
      {operator: 'GREATER_THAN', property: 'age', value: '18'},
      {operator: 'PROP_GREATER_THAN', propertyName: 'age', valueToMatch: {type: 'int', value: 18}},
    )
    ok(
      'GREATER_THAN :semver → PROP_SEMVER_GREATER_THAN',
      {operator: 'GREATER_THAN', property: 'v', value: '4.0.0:semver'},
      {operator: 'PROP_SEMVER_GREATER_THAN', propertyName: 'v', valueToMatch: {type: 'string', value: '4.0.0'}},
    )
    ok(
      'GREATER_THAN_INCLUSIVE → PROP_GREATER_THAN_OR_EQUAL',
      {operator: 'GREATER_THAN_INCLUSIVE', property: 'age', value: '21'},
      {operator: 'PROP_GREATER_THAN_OR_EQUAL', propertyName: 'age', valueToMatch: {type: 'int', value: 21}},
    )
    drop(
      'GREATER_THAN_INCLUSIVE :semver → drops (no PROP_SEMVER_GTE)',
      {operator: 'GREATER_THAN_INCLUSIVE', property: 'v', value: '4.0.0:semver'},
      /no PROP_SEMVER_GREATER_THAN_OR_EQUAL/,
    )
    ok(
      'LESS_THAN → PROP_LESS_THAN',
      {operator: 'LESS_THAN', property: 'age', value: '100'},
      {operator: 'PROP_LESS_THAN', propertyName: 'age', valueToMatch: {type: 'int', value: 100}},
    )
    ok(
      'LESS_THAN :semver → PROP_SEMVER_LESS_THAN',
      {operator: 'LESS_THAN', property: 'v', value: '5.0.0:semver'},
      {operator: 'PROP_SEMVER_LESS_THAN', propertyName: 'v', valueToMatch: {type: 'string', value: '5.0.0'}},
    )
    drop(
      'LESS_THAN_INCLUSIVE :semver → drops',
      {operator: 'LESS_THAN_INCLUSIVE', property: 'v', value: '4.0.0:semver'},
      /no PROP_SEMVER_LESS_THAN_OR_EQUAL/,
    )
    ok(
      'CONTAINS → PROP_CONTAINS_ONE_OF',
      {operator: 'CONTAINS', property: 'email', value: '+beta'},
      {operator: 'PROP_CONTAINS_ONE_OF', propertyName: 'email', valueToMatch: {type: 'string_list', value: ['+beta']}},
    )
    ok(
      'NOT_CONTAINS → PROP_DOES_NOT_CONTAIN_ONE_OF',
      {operator: 'NOT_CONTAINS', property: 'email', value: '@blocked.com'},
      {
        operator: 'PROP_DOES_NOT_CONTAIN_ONE_OF',
        propertyName: 'email',
        valueToMatch: {type: 'string_list', value: ['@blocked.com']},
      },
    )
    ok(
      'REGEX → PROP_MATCHES',
      {operator: 'REGEX', property: 'email', value: '^admin@.*$'},
      {operator: 'PROP_MATCHES', propertyName: 'email', valueToMatch: {type: 'string', value: '^admin@.*$'}},
    )
    ok(
      'IS_SET → IS_PRESENT',
      {operator: 'IS_SET', property: 'beta_opt_in'},
      {operator: 'IS_PRESENT', propertyName: 'beta_opt_in'},
    )
    ok(
      'IS_NOT_SET → IS_NOT_PRESENT',
      {operator: 'IS_NOT_SET', property: 'beta_opt_in'},
      {operator: 'IS_NOT_PRESENT', propertyName: 'beta_opt_in'},
    )
    ok(
      'IN (comma-split) → PROP_IS_ONE_OF over the split list',
      {operator: 'IN', property: 'tenant_id', value: 'a,b,c'},
      {
        operator: 'PROP_IS_ONE_OF',
        propertyName: 'tenant_id',
        valueToMatch: {type: 'string_list', value: ['a', 'b', 'c']},
      },
    )
    drop('MODULO → drops with reason', {operator: 'MODULO', property: 'user_id', value: '3|0'}, /MODULO/)
    drop('PERCENTAGE_SPLIT → drops with reason', {operator: 'PERCENTAGE_SPLIT', value: '25'}, /PERCENTAGE_SPLIT/)
    drop('unknown operator → drops', {operator: 'NEVER_HEARD_OF_IT', value: '0'}, /unrecognized/)
  })

  describe('translateSegment — segment with MODULO drops the rule + reports', () => {
    it('drops the rule when MODULO is one of its conditions', () => {
      const segment: FlagsmithSegment = {
        id: 1,
        name: 'fx-seg-modulo',
        project: 38_856,
        rules: [{conditions: [{operator: 'MODULO', property: 'user_id', value: '3|0'}], rules: [], type: 'ALL'}],
        uuid: 'su',
      }
      const report = new ConversionReport()
      const out = translateSegment(segment, report)
      // Only the trailing catch-all should remain (the modulo rule was dropped).
      const rules = (out.default as {rules: Array<{criteria: unknown[]; value: unknown}>}).rules
      expect(rules).to.have.length(1)
      expect(rules[0]).to.deep.equal({criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}})
      expect(report.byCategory('skipped-rule')).to.have.length(1)
      expect(report.byCategory('skipped-rule')[0].detail).to.contain('MODULO')
    })
  })

  describe('translateSegment — segment with PERCENTAGE_SPLIT drops the rule + reports', () => {
    it('drops the rule when PERCENTAGE_SPLIT is one of its conditions', () => {
      const segment: FlagsmithSegment = {
        id: 1,
        name: 'fx-seg-pctsplit',
        project: 38_856,
        rules: [{conditions: [{operator: 'PERCENTAGE_SPLIT', value: '25'}], rules: [], type: 'ALL'}],
        uuid: 'su',
      }
      const report = new ConversionReport()
      const out = translateSegment(segment, report)
      const rules = (out.default as {rules: unknown[]}).rules
      expect(rules).to.have.length(1) // only catch-all left
      expect(report.byCategory('skipped-rule')).to.have.length(1)
      expect(report.byCategory('skipped-rule')[0].detail).to.contain('PERCENTAGE_SPLIT')
    })
  })

  describe('translateSegment — successful single-condition segment', () => {
    it('emits a true-valued rule plus the trailing false catch-all', () => {
      const segment: FlagsmithSegment = {
        id: 1,
        name: 'fx-seg-enterprise',
        project: 38_856,
        rules: [{conditions: [{operator: 'EQUAL', property: 'plan', value: 'enterprise'}], rules: [], type: 'ALL'}],
        uuid: 'su',
      }
      const report = new ConversionReport()
      const out = translateSegment(segment, report)
      const rules = (out.default as {rules: Array<{criteria: unknown[]; value: unknown}>}).rules
      expect(rules).to.have.length(2)
      expect(rules[0]).to.deep.equal({
        criteria: [
          {
            operator: 'PROP_IS_ONE_OF',
            propertyName: 'plan',
            valueToMatch: {type: 'string_list', value: ['enterprise']},
          },
        ],
        value: {type: 'bool', value: true},
      })
      expect(rules[1]).to.deep.equal({criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}})
    })
  })
})
