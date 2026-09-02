import {expect, test} from '@oclif/test'

import {synthesizeVariants} from '../../src/commands/set-rollout.js'
import {resetClientCache} from '../../src/util/get-client.js'
// Shares the set-default mock server: `set-rollout` talks to the same
// metadata/environments/update endpoints.
import {flagsUpdateCapture, server} from '../responses/set-default.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('set-rollout', () => {
  describe('synthesizeVariants', () => {
    it('uses the first 10 chars of the value as the variant name', () => {
      const variants = synthesizeVariants([
        {value: {type: 'string', value: 'red'}, weight: 50_000},
        {value: {type: 'string', value: 'blue'}, weight: 50_000},
      ])

      expect(variants).to.deep.equal([
        {name: 'red', value: {type: 'string', value: 'red'}},
        {name: 'blue', value: {type: 'string', value: 'blue'}},
      ])
    })

    it('truncates long values to 10 characters', () => {
      const variants = synthesizeVariants([
        {value: {type: 'string', value: 'hello-world-foo-bar'}, weight: 50_000},
        {value: {type: 'string', value: 'short'}, weight: 50_000},
      ])

      expect(variants.map((v) => v.name)).to.deep.equal(['hello-worl', 'short'])
    })

    it('dedupes colliding names by appending -2, -3, ...', () => {
      const variants = synthesizeVariants([
        {value: {type: 'string', value: 'hello-worldX'}, weight: 33_000},
        {value: {type: 'string', value: 'hello-worldY'}, weight: 33_000},
        {value: {type: 'string', value: 'hello-worldZ'}, weight: 34_000},
      ])

      expect(variants.map((v) => v.name)).to.deep.equal(['hello-worl', 'hello-worl-2', 'hello-worl-3'])
    })

    it('handles non-string values via JSON stringification', () => {
      const variants = synthesizeVariants([
        {value: {type: 'int', value: 42}, weight: 50_000},
        {value: {type: 'int', value: 9_999_999_999}, weight: 50_000},
      ])

      expect(variants.map((v) => v.name)).to.deep.equal(['42', '9999999999'])
    })

    it('preserves the original value on the variant', () => {
      const variants = synthesizeVariants([{value: {type: 'json', value: {foo: 'bar'}}, weight: 100_000}])

      expect(variants).to.have.length(1)
      expect(variants[0].value).to.deep.equal({type: 'json', value: {foo: 'bar'}})
    })
  })

  describe('written rule shape', () => {
    before(() => {
      setupTestAuth()
      server.listen()
    })
    afterEach(() => {
      server.resetHandlers()
      resetClientCache()
      flagsUpdateCapture.body = null
    })
    after(() => {
      server.close()
      cleanupTestAuth()
    })

    // qfg-gv54: the rollout catch-all must use the ALWAYS_TRUE spelling.
    // `criteria: []` means the same thing to every evaluator, but only one
    // spelling gets written going forward so readers stop needing to guess.
    test
      .stdout()
      .command(['set-rollout', 'feature-flag.simple', '--environment=Development', '--true-percent=25', '--confirm'])
      .it('writes the rollout catch-all with the ALWAYS_TRUE spelling', () => {
        const body = flagsUpdateCapture.body
        expect(body, 'flags/update was never called').to.not.be.null
        const environments = body.json.flag.environments as Array<{id: string; rules: Array<{criteria: unknown[]}>}>
        const devEnv = environments.find((e) => e.id === 'Development')
        expect(devEnv, 'development env missing from update payload').to.exist
        expect(devEnv!.rules[0].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
      })
  })
})
