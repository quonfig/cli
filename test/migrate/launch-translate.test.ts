import {expect} from 'chai'

import {
  getOutputPath,
  groupChanges,
  isLegacyLogLevel,
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

    it('adds a zero-value default when config has no default section', () => {
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
