import {expect} from 'chai'
import * as path from 'node:path'

import {LocalConfigReader} from '../../src/codegen/local-config-reader.js'

const FIXTURE_DIR = path.join(process.cwd(), 'test/fixtures/workspace')

describe('LocalConfigReader', () => {
  describe('read()', () => {
    it('reads configs, feature-flags, and schemas from the fixture workspace', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      expect(result.configs).to.have.length.greaterThan(0)
      expect(result.schemas).to.have.length.greaterThan(0)
    })

    it('maps config files to configType CONFIG', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const stringConfig = result.configs.find((c) => c.key === 'my.string-config')
      expect(stringConfig).to.exist
      expect(stringConfig!.configType).to.equal('CONFIG')
    })

    it('maps feature-flag files to configType FEATURE_FLAG', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const boolFlag = result.configs.find((c) => c.key === 'my.bool-flag')
      expect(boolFlag).to.exist
      expect(boolFlag!.configType).to.equal('FEATURE_FLAG')
    })

    it('uppercases valueType', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const stringConfig = result.configs.find((c) => c.key === 'my.string-config')
      expect(stringConfig!.valueType).to.equal('STRING')

      const boolFlag = result.configs.find((c) => c.key === 'my.bool-flag')
      expect(boolFlag!.valueType).to.equal('BOOL')

      const intConfig = result.configs.find((c) => c.key === 'my.int-config')
      expect(intConfig!.valueType).to.equal('INT')
    })

    it('passes sendToClientSdk through directly', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const stringConfig = result.configs.find((c) => c.key === 'my.string-config')
      expect(stringConfig!.sendToClientSdk).to.equal(false)

      const intConfig = result.configs.find((c) => c.key === 'my.int-config')
      expect(intConfig!.sendToClientSdk).to.equal(true)

      const boolFlag = result.configs.find((c) => c.key === 'my.bool-flag')
      expect(boolFlag!.sendToClientSdk).to.equal(true)
    })

    it('passes schemaKey through directly', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const jsonConfig = result.configs.find((c) => c.key === 'my.json-config')
      expect(jsonConfig!.schemaKey).to.equal('my-schema')
    })

    it('builds rows from default.rules and environments.rules', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      // my.bool-flag has 1 default rule + 1 production rule = 2 rows
      const boolFlag = result.configs.find((c) => c.key === 'my.bool-flag')
      expect(boolFlag!.rows).to.have.length(2)

      // my.client-flag has 1 default rule + 0 env rules = 1 row
      const clientFlag = result.configs.find((c) => c.key === 'my.client-flag')
      expect(clientFlag!.rows).to.have.length(1)
    })

    it('maps bool values correctly', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const boolFlag = result.configs.find((c) => c.key === 'my.bool-flag')
      const firstValue = boolFlag!.rows[0].values[0]
      expect(firstValue.value.bool).to.equal(false) // default rule is false
    })

    it('maps string values correctly', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const stringConfig = result.configs.find((c) => c.key === 'my.string-config')
      const firstValue = stringConfig!.rows[0].values[0]
      expect(firstValue.value.string).to.equal('hello world')
    })

    it('maps int values correctly', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const intConfig = result.configs.find((c) => c.key === 'my.int-config')
      const firstValue = intConfig!.rows[0].values[0]
      expect(firstValue.value.int).to.equal(42)
    })

    it('maps json values correctly when stored as a stringified JSON string', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const jsonConfig = result.configs.find((c) => c.key === 'my.json-config')
      const firstValue = jsonConfig!.rows[0].values[0]
      expect(firstValue.value.json).to.deep.equal({json: '{"name":"example","count":42}'})
    })

    it('maps json values correctly when stored as an inline object (canonical git-native form)', async () => {
      // Regression: pre-fix, the parsed object was cast to string and
      // downstream JSON.parse would throw "[object Object]" is not valid JSON,
      // silently broadening JSON-config types to Array<any> | Record<string, any>.
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const jsonConfig = result.configs.find((c) => c.key === 'my.json-config-object-form')
      const firstValue = jsonConfig!.rows[0].values[0]
      expect(firstValue.value.json).to.have.property('json').that.is.a('string')
      expect(JSON.parse(firstValue.value.json!.json)).to.deep.equal({name: 'example', count: 42})
    })

    it('expands weighted_values rules into multiple row values, one per variant', async () => {
      // Regression: pre-fix, mapGitValue's default branch put the
      // weighted_values wrapper object into valueObj.value.string, so
      // codegen later called .match() on it and crashed. See
      // mhw-works/forcerankit homepage.hero.headline for the live example.
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      const config = result.configs.find((c) => c.key === 'my.weighted-string-config')
      expect(config).to.exist
      // 1 default rule (string) + 1 production rule (weighted_values, 2 variants)
      expect(config!.rows).to.have.length(2)

      const defaultRow = config!.rows[0]
      expect(defaultRow.values).to.have.length(1)
      expect(defaultRow.values[0].value.string).to.equal('default')

      const weightedRow = config!.rows[1]
      expect(weightedRow.values).to.have.length(2)
      expect(weightedRow.values[0].value.string).to.equal('Hello, {{name}}!')
      expect(weightedRow.values[1].value.string).to.equal('Hi {{firstName}}')
      // Every value.string is an actual string, not the wrapper object.
      for (const v of weightedRow.values) {
        expect(v.value.string).to.be.a('string')
      }
    })

    it('reads schemas directory', async () => {
      const reader = new LocalConfigReader(FIXTURE_DIR)
      const result = await reader.read()

      expect(result.schemas).to.have.length(1)
      const schema = result.schemas![0]
      expect(schema.path).to.include('my-schema.json')
      expect(schema.schema).to.have.property('$schema')
      expect(schema.schema).to.have.property('type', 'object')
    })

    it('throws an error when directory does not exist', async () => {
      const reader = new LocalConfigReader('/nonexistent/path/to/nowhere')
      try {
        await reader.read()
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect((error as Error).message).to.include('Directory not found: /nonexistent/path/to/nowhere')
        expect((error as Error).message).to.include('qfg pull')
      }
    })

    it('throws an error when directory exists but has no quonfig.json', async () => {
      const reader = new LocalConfigReader('/tmp')
      try {
        await reader.read()
        expect.fail('Should have thrown an error')
      } catch (error) {
        expect((error as Error).message).to.include('does not look like a Quonfig workspace')
      }
    })
  })
})
