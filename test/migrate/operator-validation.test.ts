import {expect} from 'chai'

import {InvalidSourceConfigError, QUONFIG_SUPPORTED_OPERATORS, transformConfig} from '../../src/migrate/sources/launch/translate.js'

const baseFlag = (rules: unknown): import('../../src/migrate/sources/launch/types.js').LaunchConfig => ({
  default: {rules: rules as never[]},
  environments: [],
  id: 'flag-id',
  key: 'patient.mobile.guru',
  projectId: 'p1',
  type: 'feature_flag',
  valueType: 'bool',
})

describe('transformConfig operator validation (qfg-l18w)', () => {
  it('throws InvalidSourceConfigError when a rule uses an unsupported semver variant (qfg-0q1f.4 only adds <, =, >)', () => {
    const config = baseFlag([
      {
        criteria: [{operator: 'PROP_SEMVER_GREATER_THAN_OR_EQUAL', propertyName: 'device.appVersion', valueToMatch: {type: 'string', value: '4.0.9'}}],
        value: {type: 'bool', value: true},
      },
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
    ])
    expect(() => transformConfig(config, {})).to.throw(InvalidSourceConfigError, /PROP_SEMVER_GREATER_THAN_OR_EQUAL/)
  })

  it('lists every distinct unsupported operator (sorted, deduplicated) in the error message', () => {
    const config = baseFlag([
      {criteria: [{operator: 'PROP_SEMVER_GREATER_THAN_OR_EQUAL'}], value: {type: 'bool', value: true}},
      {criteria: [{operator: 'PROP_SEMVER_LESS_THAN_OR_EQUAL'}], value: {type: 'bool', value: false}},
      {criteria: [{operator: 'PROP_SEMVER_GREATER_THAN_OR_EQUAL'}], value: {type: 'bool', value: true}},
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
    ])
    expect(() => transformConfig(config, {})).to.throw(/PROP_SEMVER_GREATER_THAN_OR_EQUAL, PROP_SEMVER_LESS_THAN_OR_EQUAL/)
  })

  it('accepts a config whose rules use only supported operators', () => {
    const config = baseFlag([
      {
        criteria: [{operator: 'PROP_IS_ONE_OF', propertyName: 'tier', valueToMatch: {type: 'string_list', value: ['gold']}}],
        value: {type: 'bool', value: true},
      },
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
    ])
    expect(() => transformConfig(config, {})).to.not.throw()
  })

  // qfg-0q1f.4: PROP_SEMVER_LESS_THAN / EQUAL / GREATER_THAN became first-class
  // (SDKs already evaluate semver; the migrator now passes them through rather
  // than dropping the whole config). Fixture mirrors the qfg-l18w bead's
  // FormHealth case: device.appVersion > "4.0.9".
  it('passes PROP_SEMVER_GREATER_THAN through into a valid Quonfig criterion (qfg-0q1f.4)', () => {
    const config = baseFlag([
      {
        criteria: [{operator: 'PROP_SEMVER_GREATER_THAN', propertyName: 'device.appVersion', valueToMatch: {type: 'string', value: '4.0.9'}}],
        value: {type: 'bool', value: true},
      },
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
    ])
    let out: Record<string, unknown> | undefined
    expect(() => {
      out = transformConfig(config, {})
    }).to.not.throw()
    const rules = (out!.default as {rules: Array<{criteria: Array<{operator: string; propertyName?: string}>}>}).rules
    expect(rules[0].criteria[0].operator).to.equal('PROP_SEMVER_GREATER_THAN')
    expect(rules[0].criteria[0].propertyName).to.equal('device.appVersion')
  })

  it('passes PROP_SEMVER_LESS_THAN and PROP_SEMVER_EQUAL through (qfg-0q1f.4)', () => {
    const config = baseFlag([
      {
        criteria: [{operator: 'PROP_SEMVER_LESS_THAN', propertyName: 'device.appVersion', valueToMatch: {type: 'string', value: '5.0.0'}}],
        value: {type: 'bool', value: true},
      },
      {
        criteria: [{operator: 'PROP_SEMVER_EQUAL', propertyName: 'device.appVersion', valueToMatch: {type: 'string', value: '4.0.9'}}],
        value: {type: 'bool', value: true},
      },
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
    ])
    expect(() => transformConfig(config, {})).to.not.throw()
  })

  it('also catches unsupported operators inside an environment override', () => {
    const config: import('../../src/migrate/sources/launch/types.js').LaunchConfig = {
      ...baseFlag([{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}}]),
      environments: [
        {
          id: 'env-prod',
          rules: [
            {
              criteria: [{operator: 'PROP_SEMVER_GREATER_THAN_OR_EQUAL'}],
              value: {type: 'bool', value: true},
            },
            {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
          ],
        },
      ],
    }
    expect(() => transformConfig(config, {'env-prod': 'production'})).to.throw(InvalidSourceConfigError, /PROP_SEMVER_GREATER_THAN_OR_EQUAL/)
  })
})

describe('QUONFIG_SUPPORTED_OPERATORS parity with verify schema', () => {
  it('matches the OperatorSchema enum in src/verify/validate.ts (lockstep guard)', async () => {
    // Pull the enum values from the verify validator to ensure the migrator's
    // allowlist never drifts from what qfg-verify will accept.
    const validateModule = await import('../../src/verify/validate.js')
    const sourcePath = new URL('../../src/verify/validate.ts', import.meta.url).pathname
    const fs = await import('node:fs')
    const src = fs.readFileSync(sourcePath, 'utf8')
    const enumMatch = src.match(/const OperatorSchema = z\.enum\(\[([\s\S]*?)\]\)/)
    expect(enumMatch, 'OperatorSchema enum must exist in src/verify/validate.ts').to.not.equal(null)
    const verifyOperators = new Set(
      [...(enumMatch![1].matchAll(/'([A-Z_]+)'/g))].map((m) => m[1]),
    )
    expect(QUONFIG_SUPPORTED_OPERATORS, 'migrator allowlist == verify enum').to.deep.equal(verifyOperators)
    // sanity: validateModule loaded fine
    expect(typeof validateModule.validateWorkspace).to.equal('function')
  })
})
