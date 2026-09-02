import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {configsUpdateCapture, server} from '../responses/set-default.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('set-default', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    configsUpdateCapture.body = null
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  describe('success', () => {
    test
      .stdout()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true', '--confirm'])
      .it('can change the default for a boolean flag', (ctx) => {
        expect(ctx.stdout).to.contain('Set Development fallback to `true`')
      })

    test
      .stdout()
      .command(['toggle', 'feature-flag.simple', '--environment=Development', '--value=true', '--confirm'])
      .it('supports `toggle` alias', (ctx) => {
        expect(ctx.stdout).to.contain('Set Development fallback to `true`')
      })

    test
      .stdout()
      .command([
        'set-default',
        'feature-flag.simple',
        '--environment=Development',
        '--value=true',
        '--confirm',
        '--json',
      ])
      .it('can change the default for a boolean flag with json output', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.deep.equal({
          environment: {
            id: '5',
            name: 'Development',
          },
          key: 'feature-flag.simple',
          success: true,
          value: 'true',
        })
      })

    test
      .stdout()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=[default]',
        '--value=hello default world',
        '--confirm',
      ])
      .it('can change the default for a string flag', (ctx) => {
        expect(ctx.stdout).to.contain('Set the default fallback to `hello default world`')
      })

    test
      .stdout()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=[default]',
        '--confirm',
        '--value=hello default world',
        '--json',
      ])
      .it('can change the default for a string flag with json output', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.deep.equal({
          environment: {
            id: '',
            name: '[Default]',
          },
          key: 'jeffreys.test.key.reforge',
          success: true,
          value: 'hello default world',
        })
      })

    // qfg-gv54: a catch-all we CREATE must use the ALWAYS_TRUE spelling.
    // `criteria: []` means the same thing to every evaluator, but only one
    // spelling gets written going forward so readers stop needing to guess.
    // (An existing fallback is edited in place — see the preservation test
    // below — so this only covers newly appended rules.)
    test
      .stdout()
      .command(['set-default', 'targeting-only.config', '--environment=Staging', '--value=hi', '--confirm'])
      .it('appends an environment catch-all with the ALWAYS_TRUE spelling', () => {
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const environments = body.json.config.environments as Array<{id: string; rules: Array<{criteria: unknown[]}>}>
        const stagingEnv = environments.find((e) => e.id === 'Staging')
        expect(stagingEnv, 'staging env missing from update payload').to.exist
        expect(stagingEnv!.rules.at(-1)!.criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
      })

    test
      .stdout()
      .command(['set-default', 'targeting-only.config', '--environment=[default]', '--value=hi', '--confirm'])
      .it('appends a default-block catch-all with the ALWAYS_TRUE spelling', () => {
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const defaultBlock = body.json.config.default as {rules: Array<{criteria: unknown[]}>}
        expect(defaultBlock.rules.at(-1)!.criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
      })

    // qfg-qjdm: an EXISTING fallback is edited in place, criteria untouched —
    // the same thing app-quonfig's upsertFallbackRule does. The bare
    // `criteria: []` spelling is live in production data and is deliberately
    // not normalized on write; every reader accepts both.
    test
      .stdout()
      .command(['set-default', 'jeffreys.test.key.reforge', '--environment=Staging', '--value=hi', '--confirm'])
      .it('edits an existing bare `criteria: []` fallback in place without renaming its spelling', () => {
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const environments = body.json.config.environments as Array<{
          id: string
          rules: Array<{criteria: unknown[]; value: any}>
        }>
        const stagingEnv = environments.find((e) => e.id === 'Staging')
        expect(stagingEnv, 'staging env missing from update payload').to.exist
        expect(stagingEnv!.rules).to.have.length(1)
        expect(stagingEnv!.rules[0].criteria).to.deep.equal([])
        expect(stagingEnv!.rules[0].value).to.deep.equal({type: 'string', value: 'hi'})
      })

    test
      .stdout()
      .command(['set-default', 'jeffreys.test.key.reforge', '--environment=Staging', '--confirm', '--env-var=GREETING'])
      .it('can create a string provided by an env var', (ctx) => {
        expect(ctx.stdout).to.contain(`Set Staging fallback to be provided by \`GREETING\``)
        // qfg-84df: emitted rule value must match ProvidedValueSchema
        // ({type: 'provided', value: {source, lookup}}) — server rejects the
        // legacy {provided: {…}} shape with an `expected string` validation
        // error on config.defaultValue.value.
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const environments = body.json.config.environments as Array<{id: string; rules: Array<{value: any}>}>
        const stagingEnv = environments.find((e) => e.id === 'Staging')
        expect(stagingEnv, 'staging env missing from update payload').to.exist
        expect(stagingEnv!.rules[0].value).to.deep.equal({
          type: 'provided',
          value: {source: 'ENV_VAR', lookup: 'GREETING'},
        })
      })

    test
      .env({
        QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: 'c87ba22d8662282abe8a0e4651327b579cb64a454ab0f4c170b45b15f049a221',
      })
      .stdout()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=Staging',
        '--confirm',
        '--secret',
        '--value=hello',
      ])
      .it('can create a secret string', (ctx) => {
        expect(ctx.stdout).to.contain(`Set Staging fallback to \`hello\` (encrypted)`)
      })

    // Regression for qfg-ytw: a --secret write must persist confidential:true
    // and decryptWith:<keyName> on the rule value. Without these fields the
    // SDK can't decrypt at runtime and the ciphertext is eligible to leak to
    // client SDKs / logs.
    test
      .env({
        QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: 'c87ba22d8662282abe8a0e4651327b579cb64a454ab0f4c170b45b15f049a221',
      })
      .stdout()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=Staging',
        '--confirm',
        '--secret',
        '--value=hello',
      ])
      .it('secret writes include confidential + decryptWith on the emitted rule', () => {
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const environments = body.json.config.environments as Array<{id: string; rules: Array<{value: any}>}>
        const stagingEnv = environments.find((e) => e.id === 'Staging')
        expect(stagingEnv, 'staging env missing from update payload').to.exist
        const ruleValue = stagingEnv!.rules[0].value
        expect(ruleValue.type).to.equal('string')
        expect(ruleValue.value, 'encrypted ciphertext missing').to.match(/--.+--/)
        expect(ruleValue.confidential, 'confidential:true must be set on secret rules').to.equal(true)
        expect(ruleValue.decryptWith, 'decryptWith must point at the secret key name').to.equal(
          'quonfig.secrets.encryption.key',
        )
      })

    test
      .env({
        QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: 'c87ba22d8662282abe8a0e4651327b579cb64a454ab0f4c170b45b15f049a221',
      })
      .stdout()
      .command(['set-default', 'robocop-secret', '--environment=Staging', '--confirm', '--value=hello'])
      .it('uses encryption if any existing value for the key is encrypted', (ctx) => {
        expect(ctx.stdout).to.match(/Set Staging fallback.*encrypted/)
      })

    // Regression for qfg-o4m: per-env encryption key override must be resolved
    // by env slug (environments[].id in the stored config), not by DB UUID.
    test
      .env({
        QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY_PROD:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      })
      .stdout()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=Production',
        '--confirm',
        '--secret',
        '--value=hello',
      ])
      .it('uses the per-environment encryption key for production secrets', (ctx) => {
        expect(ctx.stdout).to.contain('Encrypting with key from env var: QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY_PROD')
        expect(ctx.stdout).to.contain('Set Production fallback to `hello` (encrypted)')
      })

    test
      .stdout()
      .command(['set-default', 'test.json', '--environment=Staging', '--confirm', '--value={"hello":"world"}'])
      .it('can update a json config', (ctx) => {
        expect(ctx.stdout).to.contain(`Set Staging fallback to \`{"hello":"world"}\``)
      })
  })

  // ── Surgical fallback writes (qfg-qjdm) ──────────────────────────────
  //
  // `set-default` used to replace the target scope's ENTIRE rule list with
  // one unconditional rule, silently deleting every targeting rule while the
  // help text claimed the opposite (qfg-97z9). It now edits the fallback in
  // place and reports what it kept; `--replace-targeting` is the explicit
  // opt-in to the old, destructive behavior.
  describe('surgical targeting', () => {
    test
      .stdout()
      .command(['set-default', 'targeted.config', '--environment=Staging', '--value=hi', '--confirm'])
      .it('keeps the environment targeting rules and edits only the fallback', (ctx) => {
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const environments = body.json.config.environments as Array<{id: string; rules: any[]}>
        const stagingEnv = environments.find((e) => e.id === 'Staging')
        expect(stagingEnv, 'staging env missing from update payload').to.exist
        expect(stagingEnv!.rules).to.have.length(2)
        expect(stagingEnv!.rules[0].criteria[0].operator).to.equal('PROP_IS_ONE_OF')
        expect(stagingEnv!.rules[0].value).to.deep.equal({type: 'string', value: 'staging targeted'})
        expect(stagingEnv!.rules[1].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
        expect(stagingEnv!.rules[1].value).to.deep.equal({type: 'string', value: 'hi'})
        expect(ctx.stdout).to.contain('Set Staging fallback to `hi`')
        expect(ctx.stdout).to.contain('Kept 1 targeting rule')
        expect(ctx.stdout).to.contain('--replace-targeting')
      })

    test
      .stdout()
      .command(['set-default', 'targeted.config', '--environment=Development', '--value=hi', '--confirm'])
      .it('seeds an environment with no rules of its own from a clone of default.rules', (ctx) => {
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const environments = body.json.config.environments as Array<{id: string; rules: any[]}>
        const devEnv = environments.find((e) => e.id === 'Development')
        expect(devEnv, 'development env missing from update payload').to.exist
        expect(devEnv!.rules).to.have.length(2)
        expect(devEnv!.rules[0].criteria[0].propertyName).to.equal('user.email')
        expect(devEnv!.rules[0].value, 'the default targeting rule is copied verbatim').to.deep.equal({
          type: 'string',
          value: 'default targeted',
        })
        expect(devEnv!.rules[1].value).to.deep.equal({type: 'string', value: 'hi'})
        // The default block itself is untouched by an environment write.
        expect(body.json.config.default, 'default block must not be sent').to.equal(undefined)
        expect(ctx.stdout).to.contain('copied them from default')
        expect(ctx.stdout).to.contain('Kept 1 targeting rule')
      })

    test
      .stdout()
      .command(['set-default', 'targeting-only.config', '--environment=Staging', '--value=hi', '--confirm'])
      .it('appends a fallback when the environment has targeting but no catch-all', (ctx) => {
        const body = configsUpdateCapture.body
        const environments = body.json.config.environments as Array<{id: string; rules: any[]}>
        const stagingEnv = environments.find((e) => e.id === 'Staging')
        expect(stagingEnv!.rules).to.have.length(2)
        expect(stagingEnv!.rules[0].criteria[0].operator).to.equal('PROP_IS_ONE_OF')
        expect(stagingEnv!.rules[1]).to.deep.equal({
          criteria: [{operator: 'ALWAYS_TRUE'}],
          value: {type: 'string', value: 'hi'},
        })
        expect(ctx.stdout).to.contain('Kept 1 targeting rule')
      })

    test
      .stdout()
      .command([
        'set-default',
        'targeted.config',
        '--environment=Staging',
        '--value=hi',
        '--replace-targeting',
        '--confirm',
      ])
      .it('--replace-targeting collapses the scope to a single unconditional rule', (ctx) => {
        const body = configsUpdateCapture.body
        const environments = body.json.config.environments as Array<{id: string; rules: any[]}>
        const stagingEnv = environments.find((e) => e.id === 'Staging')
        expect(stagingEnv!.rules).to.deep.equal([
          {criteria: [{operator: 'ALWAYS_TRUE'}], value: {type: 'string', value: 'hi'}},
        ])
        expect(ctx.stdout).to.contain('Set Staging to `hi` for everyone')
        expect(ctx.stdout).to.contain('Replaced 1 targeting rule')
        expect(ctx.stdout).to.contain('abc100')
      })

    test
      .stdout()
      .command([
        'set-default',
        'targeted.config',
        '--environment=Staging',
        '--value=hi',
        '--replace-targeting',
        '--confirm',
        '--json',
      ])
      .it('--json reports replacedTargetingRuleCount and previousCommitSha', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.deep.equal({
          environment: {id: '6', name: 'Staging'},
          key: 'targeted.config',
          previousCommitSha: 'abc100',
          replacedTargetingRuleCount: 1,
          success: true,
          value: 'hi',
        })
      })

    test
      .stdout()
      .command(['set-default', 'targeted.config', '--environment=Staging', '--value=hi', '--confirm', '--json'])
      .it('--json reports keptTargetingRuleCount on a surgical write', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.deep.equal({
          environment: {id: '6', name: 'Staging'},
          key: 'targeted.config',
          keptTargetingRuleCount: 1,
          success: true,
          value: 'hi',
        })
      })

    test
      .stdout()
      .command(['set-default', 'targeted.config', '--environment=[default]', '--value=hi', '--confirm'])
      .it('keeps targeting in the [Default] scope too', (ctx) => {
        const body = configsUpdateCapture.body
        const defaultBlock = body.json.config.default as {rules: any[]}
        expect(defaultBlock.rules).to.have.length(2)
        expect(defaultBlock.rules[0].criteria[0].operator).to.equal('PROP_IS_ONE_OF')
        expect(defaultBlock.rules[1].value).to.deep.equal({type: 'string', value: 'hi'})
        expect(ctx.stdout).to.contain('Set the default fallback to `hi`')
        expect(ctx.stdout).to.contain('Kept 1 targeting rule')
      })
  })

  describe('failure', () => {
    test
      .stderr()
      .command(['set-default', 'this.does.not.exist', '--environment=Staging', '--value=hello default world'])
      .catch((error) => {
        expect(error.message).to.contain(`Could not find config named this.does.not.exist`)
      })
      .it('shows an error when the key does not exist', () => {
        // Error assertion done in catch block
      })

    test
      .stderr()
      .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=cake', '--confirm'])
      .catch((error) => {
        expect(error.message).to.contain(`'cake' is not a valid value for feature-flag.simple`)
      })
      .it("shows an error when the value isn't valid for the boolean key", () => {
        // Error assertion done in catch block
      })

    test
      .stdout()
      .command(['set-default', 'jeffreys.test.int', '--environment=[default]', '--confirm', '--value=hello'])
      .catch((error) => {
        expect(error.message).to.contain(`Invalid default value for int: hello`)
      })
      .it("shows an error when the value isn't valid for the int key", () => {
        // Error assertion done in catch block
      })
  })

  describe('parsing errors', () => {
    test
      .command(['set-default', '--no-interactive'])
      .catch((error) => {
        expect(error.message).to.eql("'name' argument is required when interactive mode isn't available.")
      })
      .it("shows an error if no key is provided when things aren't interactive", () => {
        // Error assertion done in catch block
      })

    test
      .command(['set-default', 'feature-flag.simple', '--no-interactive'])
      .catch((error) => {
        expect(error.message).to.eql("'environment' is required when interactive mode isn't available.")
      })
      .it("shows an error if no environment is provided when things aren't interactive", () => {
        // Error assertion done in catch block
      })

    test
      .stderr()
      .command([
        'set-default',
        'jeffreys.test.key.reforge',
        '--environment=Staging',
        '--confirm',
        '--env-var=GREETING',
        '--value=hello world',
      ])
      .catch((error) => {
        expect(error.message).to.contain(`cannot specify both --env-var and --value`)
      })
      .it('shows an error when provided a value and an env-var', () => {
        // Error assertion done in catch block
      })

    // Regression: previously this would show the env-picker arrow-key UI and
    // then crash with "Detected unsettled top-level await" because the TTY
    // check was bypassed by the --interactive default. Now we auto-detect
    // non-TTY stdio and surface a clean, actionable error.
    describe('non-TTY auto-detection', () => {
      let originalStdinTTY: boolean | undefined
      let originalStdoutTTY: boolean | undefined

      before(() => {
        originalStdinTTY = process.stdin.isTTY
        originalStdoutTTY = process.stdout.isTTY
        Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: false})
        Object.defineProperty(process.stdout, 'isTTY', {configurable: true, value: false})
      })
      after(() => {
        Object.defineProperty(process.stdin, 'isTTY', {configurable: true, value: originalStdinTTY})
        Object.defineProperty(process.stdout, 'isTTY', {configurable: true, value: originalStdoutTTY})
      })

      test
        .command(['set-default', 'feature-flag.simple', '--value=true', '--confirm'])
        .catch((error) => {
          expect(error.message).to.contain("'environment' is required when interactive mode isn't available.")
        })
        .it('errors cleanly when environment is missing under non-TTY stdio', () => {
          // Error assertion done in catch block
        })

      test
        .command(['set-default', 'feature-flag.simple', '--environment=Development', '--value=true'])
        .catch((error) => {
          expect(error.message).to.contain('--confirm')
        })
        .it('errors cleanly when --confirm is missing under non-TTY stdio (no hanging confirm prompt)', () => {
          // Error assertion done in catch block
        })
    })
  })
})
