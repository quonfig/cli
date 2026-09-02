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

    // qfg-gv54: a rollout catch-all we CREATE must use the ALWAYS_TRUE
    // spelling. `criteria: []` means the same thing to every evaluator, but
    // only one spelling gets written going forward so readers stop needing to
    // guess. (An existing fallback is edited in place and keeps whichever
    // spelling it already had — qfg-qjdm.)
    test
      .stdout()
      .command(['set-rollout', 'targeting-only.flag', '--environment=Development', '--true-percent=25', '--confirm'])
      .it('writes the rollout catch-all with the ALWAYS_TRUE spelling', () => {
        const body = flagsUpdateCapture.body
        expect(body, 'flags/update was never called').to.not.be.null
        const environments = body.json.flag.environments as Array<{id: string; rules: Array<{criteria: unknown[]}>}>
        const devEnv = environments.find((e) => e.id === 'Development')
        expect(devEnv, 'development env missing from update payload').to.exist
        expect(devEnv!.rules.at(-1)!.criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
      })
  })

  // ── Surgical targeting (qfg-qjdm) ──────────────────────────────────
  //
  // Same semantics as `set-default`: the rollout replaces the FALLBACK
  // rule's value and keeps every targeting rule around it, unless
  // --replace-targeting says otherwise.
  describe('surgical targeting', () => {
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

    test
      .stdout()
      .command(['set-rollout', 'targeted.flag', '--environment=Development', '--true-percent=25', '--confirm'])
      .it('keeps the environment targeting rules and rolls out only the fallback', (ctx) => {
        const body = flagsUpdateCapture.body
        expect(body, 'flags/update was never called').to.not.be.null
        const environments = body.json.flag.environments as Array<{id: string; rules: any[]}>
        const devEnv = environments.find((e) => e.id === 'Development')
        expect(devEnv!.rules).to.have.length(2)
        expect(devEnv!.rules[0].criteria[0].operator).to.equal('PROP_IS_ONE_OF')
        expect(devEnv!.rules[0].value).to.deep.equal({type: 'bool', value: true})
        expect(devEnv!.rules[1].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
        expect(devEnv!.rules[1].value.type).to.equal('weighted_values')
        expect(ctx.stdout).to.contain('Kept 1 targeting rule')
      })

    // The [Default] scope writes the document's `default` block. Before
    // qfg-qjdm this created an environment literally named "[Default]", which
    // no SDK would ever match.
    test
      .stdout()
      .command(['set-rollout', 'targeted.flag', '--environment=[default]', '--true-percent=25', '--confirm'])
      .it('rolls out the [Default] scope into default.rules, keeping its targeting', (ctx) => {
        const body = flagsUpdateCapture.body
        expect(body, 'flags/update was never called').to.not.be.null
        expect(body.json.flag.environments, 'no environments key on a [Default] write').to.equal(undefined)
        const rules = (body.json.flag.default as {rules: any[]}).rules
        expect(rules).to.have.length(2)
        expect(rules[0].criteria[0].operator, 'default targeting rule kept').to.equal('PROP_IS_ONE_OF')
        expect(rules[0].value).to.deep.equal({type: 'bool', value: true})
        expect(rules[1].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
        expect(rules[1].value.type).to.equal('weighted_values')
        expect(ctx.stdout).to.contain('in the default')
        expect(ctx.stdout).to.contain('Kept 1 targeting rule')
      })

    test
      .stdout()
      .command([
        'set-rollout',
        'targeted.flag',
        '--environment=Development',
        '--true-percent=25',
        '--replace-targeting',
        '--confirm',
      ])
      .it('--replace-targeting collapses the scope to the rollout alone', (ctx) => {
        const body = flagsUpdateCapture.body
        const environments = body.json.flag.environments as Array<{id: string; rules: any[]}>
        const devEnv = environments.find((e) => e.id === 'Development')
        expect(devEnv!.rules).to.have.length(1)
        expect(devEnv!.rules[0].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
        expect(devEnv!.rules[0].value.type).to.equal('weighted_values')
        expect(ctx.stdout).to.contain('Replaced 1 targeting rule')
        expect(ctx.stdout).to.contain('abc102')
      })
  })
})
