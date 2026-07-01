import {expect} from 'chai'

import {planKeyRewrites, resetKeyRewriter} from '../../src/migrate/key-rewriter.js'
import {ConversionReport} from '../../src/migrate/quonfig-target/report.js'
import {translateFeature, translateSegment} from '../../src/migrate/sources/flagsmith/translate.js'
import type {
  FlagsmithFeature,
  FlagsmithFeatureWithStates,
  FlagsmithSegment,
} from '../../src/migrate/sources/flagsmith/types.js'

// qfg-6na9.3: the whole point of the per-run rewriter is that a rewritten
// segment KEY and every IN_SEG rule that REFERENCES it resolve to the SAME final
// key — otherwise a sanitized/disambiguated segment silently dangles its
// targeting. This exercises the REAL flagsmith translate at both sites with a
// non-conforming segment name, which is the concrete case Jeff flagged.

function makeFeature(name: string): FlagsmithFeature {
  return {
    default_enabled: true,
    id: 1,
    is_archived: false,
    multivariate_options: [],
    name,
    project: 1,
    tags: [],
    type: 'STANDARD',
    uuid: 'u',
  }
}

function segovBundle(featureName: string, segmentId: number): FlagsmithFeatureWithStates {
  return {
    feature: makeFeature(featureName),
    feature_segments_by_env: {'apk-dev': [{environment: 1, id: 99, priority: 0, segment: segmentId, uuid: 'fsg-1'}]},
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
            feature_segment: {id: 99, priority: 0, segment: segmentId, uuid: 'fsg-1'},
            feature_state_value: {boolean_value: true, integer_value: null, string_value: null, type: 'bool'},
            id: 9100,
            multivariate_feature_state_values: [],
            uuid: 'fs-uuid-segov',
          },
        ],
      },
    },
  }
}

function segment(id: number, name: string): FlagsmithSegment {
  return {id, name, project: 1, rules: [], uuid: `seg-${id}`}
}

/** The value of the first IN_SEG criterion the translated flag emits. */
function inSegValue(featureOut: Record<string, unknown>): string {
  const rules = (
    featureOut.environments as Array<{
      rules: Array<{criteria: Array<{operator: string; valueToMatch: {value: string}}>}>
    }>
  )[0].rules
  const inSeg = rules.flatMap((r) => r.criteria).find((c) => c.operator === 'IN_SEG')
  if (!inSeg) throw new Error('expected an IN_SEG criterion but none was emitted')
  return inSeg.valueToMatch.value
}

describe('migrate key/reference consistency (qfg-6na9.3)', () => {
  afterEach(() => resetKeyRewriter())

  it('a rewritten segment key and the IN_SEG rule referencing it resolve to the SAME key', () => {
    const report = new ConversionReport()
    planKeyRewrites(['Beta Users', 'fx-segov'])

    const feat = translateFeature(segovBundle('fx-segov', 7), report, {
      envNameByApiKey: new Map([['apk-dev', 'Development']]),
      segmentNameById: new Map([[7, 'Beta Users']]),
    })
    const seg = translateSegment(segment(7, 'Beta Users'), report)

    expect(seg.key).to.equal('Beta-Users') // space -> dash
    expect(inSegValue(feat)).to.equal('Beta-Users') // reference sanitized identically
    expect(inSegValue(feat)).to.equal(seg.key) // the no-dangling-targeting invariant
  })

  it('stays consistent under DISAMBIGUATION (two names collapse to one key)', () => {
    const report = new ConversionReport()
    // 'Beta Users' and 'Beta-Users' both sanitize to 'Beta-Users'; segment 7 is
    // the one that gets the numeric suffix. Both its key def and reference must
    // pick up the SAME suffixed key.
    planKeyRewrites(['Beta Users', 'Beta-Users', 'fx-segov'])

    const seg = translateSegment(segment(7, 'Beta-Users'), report)
    const feat = translateFeature(segovBundle('fx-segov', 7), report, {
      envNameByApiKey: new Map([['apk-dev', 'Development']]),
      segmentNameById: new Map([[7, 'Beta-Users']]),
    })

    expect(seg.key).to.equal('Beta-Users-2') // disambiguated
    expect(inSegValue(feat)).to.equal(seg.key) // reference follows the suffix
  })

  it('is a strict no-op for an already-conforming segment name (LD-style)', () => {
    const report = new ConversionReport()
    planKeyRewrites(['beta-users', 'fx-segov'])
    const seg = translateSegment(segment(7, 'beta-users'), report)
    const feat = translateFeature(segovBundle('fx-segov', 7), report, {
      envNameByApiKey: new Map([['apk-dev', 'Development']]),
      segmentNameById: new Map([[7, 'beta-users']]),
    })
    expect(seg.key).to.equal('beta-users')
    expect(inSegValue(feat)).to.equal('beta-users')
  })
})
