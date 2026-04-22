import {expect} from 'chai'

import {
  detectDuplicateKeys,
  getOutputPath,
  groupChanges,
  isLegacyLogLevel,
  normalizeLogLevelKey,
  slugify,
  transformConfig,
} from '../../src/migrate/sources/launch/translate.js'
import type {LaunchChangeEntry, LaunchConfig} from '../../src/migrate/sources/launch/types.js'

const USER = {email: 'a@b', fullName: 'Alice', id: 'u1', type: 'user'}

describe('migrate/sources/launch/translate', () => {
  describe('slugify', () => {
    it('lowercases and hyphenates', () => {
      expect(slugify('My Launch Env')).to.equal('my-launch-env')
    })
  })

  describe('isLegacyLogLevel', () => {
    it('returns true for LOG_LEVEL', () => {
      expect(isLegacyLogLevel('LOG_LEVEL')).to.equal(true)
    })

    it('returns false for LOG_LEVEL_V2', () => {
      expect(isLegacyLogLevel('LOG_LEVEL_V2')).to.equal(false)
    })
  })

  describe('normalizeLogLevelKey (qfg-0cz.2)', () => {
    it('prefixes a key missing the log-level. prefix', () => {
      expect(normalizeLogLevelKey('log-levels.default')).to.equal('log-level.log-levels.default')
    })

    it('leaves an already-prefixed key unchanged', () => {
      expect(normalizeLogLevelKey('log-level.api-server')).to.equal('log-level.api-server')
    })
  })

  describe('getOutputPath', () => {
    it('maps FEATURE_FLAG to feature-flags/', () => {
      expect(getOutputPath('FEATURE_FLAG', 'my-flag')).to.equal('feature-flags/my-flag.json')
    })

    it('maps SEGMENT to segments/', () => {
      expect(getOutputPath('SEGMENT', 'my-seg')).to.equal('segments/my-seg.json')
    })

    it('maps SCHEMA to schemas/', () => {
      expect(getOutputPath('SCHEMA', 'my-schema')).to.equal('schemas/my-schema.json')
    })

    it('maps CONFIG to configs/', () => {
      expect(getOutputPath('CONFIG', 'my-config')).to.equal('configs/my-config.json')
    })

    it('routes LOG_LEVEL_V2 and prefixes a key missing the log-level. prefix (qfg-0cz.2)', () => {
      expect(getOutputPath('LOG_LEVEL_V2', 'log-levels.default')).to.equal(
        'log-levels/log-level.log-levels.default.json',
      )
    })

    it('routes LOG_LEVEL_V2 without double-prefixing an already-prefixed key (qfg-0cz.2)', () => {
      expect(getOutputPath('LOG_LEVEL_V2', 'log-level.api-server')).to.equal(
        'log-levels/log-level.api-server.json',
      )
    })
  })

  describe('transformConfig', () => {
    const envMap = {148: 'production', 149: 'staging'}

    it('replaces env ids with slugified names, strips changedBy', () => {
      const input: LaunchConfig = {
        changedBy: USER,
        environments: [{id: '148', rules: []}],
        id: '1',
        key: 'my-flag',
        projectId: 'p',
        type: 'feature_flag',
        valueType: 'bool',
      }
      const out = transformConfig(input, envMap)
      expect(out.changedBy).to.equal(undefined)
      const environments = out.environments as Array<{id: string}>
      expect(environments[0].id).to.equal('production')
    })

    it('normalizes stringified json values into native JSON', () => {
      const input: LaunchConfig = {
        default: {
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'json', value: '{"a":1}'},
            },
          ],
        },
        environments: [],
        id: '1',
        key: 'my-json',
        projectId: 'p',
        type: 'config',
        valueType: 'json',
      }

      const out = transformConfig(input, envMap)
      const rules = (out.default as {rules: Array<{value: {value: unknown}}>}).rules
      expect(rules[0].value.value).to.deep.equal({a: 1})
    })

    it('adds a zero-value default when config has no default section and no variants', () => {
      const input: LaunchConfig = {
        environments: [],
        id: '1',
        key: 'no-default',
        projectId: 'p',
        type: 'feature_flag',
        valueType: 'bool',
      }
      const out = transformConfig(input, envMap)
      const rules = (out.default as {rules: Array<{value: {type: string; value: unknown}}>}).rules
      expect(rules[0].value).to.deep.equal({type: 'bool', value: false})
    })

    it('drops override sections whose env.id is not in envIdMap (qfg-0cz.1)', () => {
      const input: LaunchConfig = {
        environments: [
          {id: '148', rules: []},
          {id: '999', rules: []},
        ],
        id: '1',
        key: 'test',
        projectId: 'p',
        type: 'feature_flag',
        valueType: 'bool',
      }
      const out = transformConfig(input, envMap)
      const envs = out.environments as Array<{id: string}>
      expect(envs).to.have.length(1)
      expect(envs[0].id).to.equal('production')
    })

    it('invokes onDroppedEnv callback for each dropped override section (qfg-0cz.1)', () => {
      const input: LaunchConfig = {
        environments: [
          {id: '148', rules: []},
          {id: '1086', rules: []},
          {id: '6834', rules: []},
        ],
        id: '1',
        key: 'my-flag',
        projectId: 'p',
        type: 'feature_flag',
        valueType: 'bool',
      }
      const dropped: string[] = []
      transformConfig(input, envMap, (envId) => dropped.push(envId))
      expect(dropped).to.deep.equal(['1086', '6834'])
    })

    it("prefixes log_level keys missing the 'log-level.' prefix (qfg-0cz.2)", () => {
      const input: LaunchConfig = {
        default: {
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'log_level', value: 'INFO'},
            },
          ],
        },
        environments: [],
        id: '1',
        key: 'log-levels.default',
        projectId: 'p',
        type: 'log_level_v2',
        valueType: 'log_level',
      }
      const out = transformConfig(input, envMap)
      expect(out.key).to.equal('log-level.log-levels.default')
      expect(out.type).to.equal('log_level')
    })

    it('leaves already-prefixed log_level keys unchanged (qfg-0cz.2)', () => {
      const input: LaunchConfig = {
        default: {
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'log_level', value: 'WARN'},
            },
          ],
        },
        environments: [],
        id: '1',
        key: 'log-level.api-server',
        projectId: 'p',
        type: 'log_level_v2',
        valueType: 'log_level',
      }
      const out = transformConfig(input, envMap)
      expect(out.key).to.equal('log-level.api-server')
    })

    it('uses variants[0].value as synthesized default when variants exist (qfg-0cz.3)', () => {
      const input: LaunchConfig = {
        environments: [],
        id: '1',
        key: 'copilot-tasks',
        projectId: 'p',
        type: 'feature_flag',
        valueType: 'string_list',
        variants: [
          {value: {type: 'string_list', value: ['notion', 'gdocs', 'confluence', 'msword', 'jira']}},
          {value: {type: 'string_list', value: ['none']}},
        ],
      } as unknown as LaunchConfig
      const out = transformConfig(input, envMap)
      expect(out.default).to.deep.equal({
        rules: [
          {
            criteria: [{operator: 'ALWAYS_TRUE'}],
            value: {type: 'string_list', value: ['notion', 'gdocs', 'confluence', 'msword', 'jira']},
          },
        ],
      })
    })

    it("throws when a variant's value type does not match the config valueType (qfg-0cz.5)", () => {
      const input: LaunchConfig = {
        default: {
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'string', value: '44'},
            },
          ],
        },
        environments: [],
        id: '1',
        key: 'config-with-variants',
        projectId: 'p',
        type: 'config',
        valueType: 'double',
        variants: [
          {value: {type: 'string', value: '44'}},
          {value: {type: 'double', value: '23.0'}},
        ],
      } as unknown as LaunchConfig
      expect(() => transformConfig(input, envMap)).to.throw(/config-with-variants/)
      expect(() => transformConfig(input, envMap)).to.throw(/variants\[0]/)
      expect(() => transformConfig(input, envMap)).to.throw(/string.*double/)
    })

    it('skips variant/valueType check for weighted_values valueType (qfg-0cz.5)', () => {
      const input: LaunchConfig = {
        default: {
          rules: [
            {
              criteria: [{operator: 'ALWAYS_TRUE'}],
              value: {type: 'weighted_values', value: []},
            },
          ],
        },
        environments: [],
        id: '1',
        key: 'weighted',
        projectId: 'p',
        type: 'feature_flag',
        valueType: 'weighted_values',
        variants: [{value: {type: 'string', value: 'a'}}, {value: {type: 'string', value: 'b'}}],
      } as unknown as LaunchConfig
      expect(() => transformConfig(input, envMap)).to.not.throw()
    })
  })

  describe('detectDuplicateKeys (qfg-0cz.4)', () => {
    it('does not throw when all keys are unique across types', () => {
      expect(() =>
        detectDuplicateKeys([
          {path: 'configs/a.json'},
          {path: 'feature-flags/b.json'},
          {path: 'segments/c.json'},
        ]),
      ).to.not.throw()
    })

    it('allows the same key within the same type (same path is a no-op)', () => {
      expect(() =>
        detectDuplicateKeys([{path: 'configs/a.json'}, {path: 'configs/a.json'}]),
      ).to.not.throw()
    })

    it('throws when the same key appears across different types', () => {
      expect(() =>
        detectDuplicateKeys([
          {path: 'configs/test-config.json'},
          {path: 'feature-flags/test-config.json'},
        ]),
      ).to.throw(/test-config/)
      expect(() =>
        detectDuplicateKeys([
          {path: 'configs/test-config.json'},
          {path: 'feature-flags/test-config.json'},
        ]),
      ).to.throw(/config.*feature_flag|feature_flag.*config/)
    })

    it('lists every colliding key in a single error', () => {
      expect(() =>
        detectDuplicateKeys([
          {path: 'configs/k1.json'},
          {path: 'feature-flags/k1.json'},
          {path: 'configs/k2.json'},
          {path: 'feature-flags/k2.json'},
        ]),
      ).to.throw(/k1[\S\s]*k2|k2[\S\s]*k1/)
    })
  })

  describe('groupChanges', () => {
    it('groups by changedAt+changedBy.id and sorts chronologically', () => {
      const changes: LaunchChangeEntry[] = [
        {changedAt: 200, changedBy: USER, deleted: false, key: 'late', newConfigId: 2, type: 'FEATURE_FLAG'},
        {changedAt: 100, changedBy: USER, deleted: false, key: 'early-1', newConfigId: 1, type: 'FEATURE_FLAG'},
        {changedAt: 100, changedBy: USER, deleted: false, key: 'early-2', newConfigId: 1, type: 'FEATURE_FLAG'},
      ]

      const groups = groupChanges(changes)
      expect(groups).to.have.length(2)
      expect(groups[0].changedAt).to.equal(100)
      expect(groups[0].changes.map((c) => c.key)).to.deep.equal(['early-1', 'early-2'])
      expect(groups[1].changedAt).to.equal(200)
    })
  })
})
