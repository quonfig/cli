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
      expect(getOutputPath('LOG_LEVEL_V2', 'log-level.api-server')).to.equal('log-levels/log-level.api-server.json')
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
        variants: [{value: {type: 'string', value: '44'}}, {value: {type: 'double', value: '23.0'}}],
      } as unknown as LaunchConfig
      expect(() => transformConfig(input, envMap)).to.throw(/config-with-variants/)
      expect(() => transformConfig(input, envMap)).to.throw(/variants\[0]/)
      expect(() => transformConfig(input, envMap)).to.throw(/string.*double/)
    })

    it("coerces Launch's empty-string sentinel rule value to the typed default in non-string configs (qfg-gpnd)", () => {
      // Launch emits {value:{type:'string', value:''}} as a "no value set yet"
      // sentinel for catch-all rules even when the config valueType is int. The
      // qfg-verify pre-receive hook rejects this as a value-type mismatch. The
      // migrator should coerce the sentinel to the typed default (0 for int)
      // so the rest of the otherwise-valid config still ships.
      const input: LaunchConfig = {
        environments: [
          {
            id: '148',
            rules: [
              {
                criteria: [
                  {operator: 'PROP_IS_ONE_OF', propertyName: 'tier', valueToMatch: {type: 'string', value: 'pro'}},
                ],
                value: {type: 'int', value: '50'},
              },
              {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: ''}},
            ],
          },
        ],
        id: '1',
        key: 'cloud_context.integrations.max_limit',
        projectId: 'p',
        type: 'config',
        valueType: 'int',
      } as unknown as LaunchConfig
      const out = transformConfig(input, envMap)
      const env0 = (out.environments as Array<{rules: Array<{value: {type: string; value: unknown}}>}>)[0]
      expect(env0.rules[0].value).to.deep.equal({type: 'int', value: '50'})
      expect(env0.rules[1].value).to.deep.equal({type: 'int', value: '0'})
    })

    it('coerces empty-string sentinel in default.rules too (qfg-gpnd)', () => {
      const input: LaunchConfig = {
        default: {
          rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: ''}}],
        },
        environments: [],
        id: '1',
        key: 'some.int.config',
        projectId: 'p',
        type: 'config',
        valueType: 'int',
      } as unknown as LaunchConfig
      const out = transformConfig(input, envMap)
      const rules = (out.default as {rules: Array<{value: {type: string; value: unknown}}>}).rules
      expect(rules[0].value).to.deep.equal({type: 'int', value: '0'})
    })

    it("leaves a legitimate empty-string value alone when the config valueType IS 'string' (qfg-gpnd)", () => {
      const input: LaunchConfig = {
        environments: [
          {id: '148', rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: ''}}]},
        ],
        id: '1',
        key: 'some.string.config',
        projectId: 'p',
        type: 'config',
        valueType: 'string',
      } as unknown as LaunchConfig
      const out = transformConfig(input, envMap)
      const env0 = (out.environments as Array<{rules: Array<{value: {type: string; value: unknown}}>}>)[0]
      expect(env0.rules[0].value).to.deep.equal({type: 'string', value: ''})
    })

    it('reports each sentinel coercion via the onCoercedSentinel callback (qfg-gpnd)', () => {
      const input: LaunchConfig = {
        environments: [
          {id: '148', rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: ''}}]},
          {id: '149', rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: ''}}]},
        ],
        id: '1',
        key: 'some.int.config',
        projectId: 'p',
        type: 'config',
        valueType: 'int',
      } as unknown as LaunchConfig
      const coerced: Array<{envId: string; valueType: string}> = []
      transformConfig(input, envMap, undefined, (envId, valueType) => coerced.push({envId, valueType}))
      expect(coerced).to.deep.equal([
        {envId: 'production', valueType: 'int'},
        {envId: 'staging', valueType: 'int'},
      ])
    })

    it("normalizes segment valueType to 'bool' regardless of source value (qfg-ol8y)", () => {
      // Launch emits valueType: 'not_set_value_type' for segments where the
      // valueType was never explicitly set in Launch's UI. Quonfig's validator
      // requires segments to have valueType === 'bool' (segments are
      // conceptually "is the user in the segment?"). Force-normalize so the
      // qfg-verify pre-receive hook stops rejecting these pushes.
      const input: LaunchConfig = {
        default: {
          rules: [{criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'bool', value: false}}],
        },
        environments: [],
        id: '1',
        key: 'test',
        projectId: 'p',
        type: 'segment',
        valueType: 'not_set_value_type',
      } as unknown as LaunchConfig
      const out = transformConfig(input, envMap)
      expect(out.valueType).to.equal('bool')
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

  describe('detectDuplicateKeys (qfg-0cz.4 + qfg-zfl.20)', () => {
    it('returns [] when all keys are unique across types', () => {
      expect(
        detectDuplicateKeys([{path: 'configs/a.json'}, {path: 'feature-flags/b.json'}, {path: 'segments/c.json'}]),
      ).to.deep.equal([])
    })

    it('returns [] when the same key appears twice in the same type (no collision)', () => {
      expect(detectDuplicateKeys([{path: 'configs/a.json'}, {path: 'configs/a.json'}])).to.deep.equal([])
    })

    it('resolves config + feature_flag collision by keeping the config (qfg-zfl.20)', () => {
      const result = detectDuplicateKeys([
        {path: 'configs/build.docuforge.json'},
        {path: 'feature-flags/build.docuforge.json'},
      ])
      expect(result).to.have.length(1)
      expect(result[0].key).to.equal('build.docuforge')
      expect(result[0].kept).to.equal('configs/build.docuforge.json')
      expect(result[0].deleted).to.deep.equal(['feature-flags/build.docuforge.json'])
      expect(result[0].collisionTypes).to.have.members(['config', 'feature_flag'])
    })

    it('returns a resolution per colliding key (qfg-zfl.20)', () => {
      const result = detectDuplicateKeys([
        {path: 'configs/k1.json'},
        {path: 'feature-flags/k1.json'},
        {path: 'configs/k2.json'},
        {path: 'feature-flags/k2.json'},
      ])
      expect(result).to.have.length(2)
      const keys = result.map((r) => r.key).sort()
      expect(keys).to.deep.equal(['k1', 'k2'])
      for (const r of result) {
        expect(r.kept.startsWith('configs/')).to.equal(true)
        expect(r.deleted).to.deep.equal([`feature-flags/${r.key}.json`])
      }
    })

    it('still throws on a collision that does NOT include config (unexpected pattern)', () => {
      expect(() => detectDuplicateKeys([{path: 'segments/foo.json'}, {path: 'feature-flags/foo.json'}])).to.throw(/foo/)
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
