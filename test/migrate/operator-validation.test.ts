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
  it('throws InvalidSourceConfigError when a rule uses PROP_SEMVER_GREATER_THAN', () => {
    const config = baseFlag([
      {
        criteria: [{operator: 'PROP_SEMVER_GREATER_THAN', propertyName: 'device.appVersion', valueToMatch: {type: 'string', value: '4.0.9'}}],
        value: {type: 'bool', value: true},
      },
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
    ])
    expect(() => transformConfig(config, {})).to.throw(InvalidSourceConfigError, /PROP_SEMVER_GREATER_THAN/)
  })

  it('lists every distinct unsupported operator (sorted, deduplicated) in the error message', () => {
    const config = baseFlag([
      {criteria: [{operator: 'PROP_SEMVER_GREATER_THAN'}], value: {type: 'bool', value: true}},
      {criteria: [{operator: 'PROP_SEMVER_LESS_THAN_OR_EQUAL'}], value: {type: 'bool', value: false}},
      {criteria: [{operator: 'PROP_SEMVER_GREATER_THAN'}], value: {type: 'bool', value: true}},
      {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}},
    ])
    expect(() => transformConfig(config, {})).to.throw(/PROP_SEMVER_GREATER_THAN, PROP_SEMVER_LESS_THAN_OR_EQUAL/)
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
