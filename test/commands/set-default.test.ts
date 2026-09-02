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
        expect(ctx.stdout).to.contain('Successfully changed default to `true`')
      })

    test
      .stdout()
      .command(['toggle', 'feature-flag.simple', '--environment=Development', '--value=true', '--confirm'])
      .it('supports `toggle` alias', (ctx) => {
        expect(ctx.stdout).to.contain('Successfully changed default to `true`')
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
        expect(ctx.stdout).to.contain('Successfully changed default to `hello default world`')
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

    // qfg-gv54: the catch-all we write must use the ALWAYS_TRUE spelling.
    // `criteria: []` means the same thing to every evaluator, but only one
    // spelling gets written going forward so readers stop needing to guess.
    test
      .stdout()
      .command(['set-default', 'jeffreys.test.key.reforge', '--environment=Staging', '--value=hi', '--confirm'])
      .it('writes an environment catch-all with the ALWAYS_TRUE spelling', () => {
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const environments = body.json.config.environments as Array<{id: string; rules: Array<{criteria: unknown[]}>}>
        const stagingEnv = environments.find((e) => e.id === 'Staging')
        expect(stagingEnv, 'staging env missing from update payload').to.exist
        expect(stagingEnv!.rules[0].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
      })

    test
      .stdout()
      .command(['set-default', 'jeffreys.test.key.reforge', '--environment=[default]', '--value=hi', '--confirm'])
      .it('writes a default-block catch-all with the ALWAYS_TRUE spelling', () => {
        const body = configsUpdateCapture.body
        expect(body, 'configs/update was never called').to.not.be.null
        const defaultBlock = body.json.config.default as {rules: Array<{criteria: unknown[]}>}
        expect(defaultBlock.rules[0].criteria).to.deep.equal([{operator: 'ALWAYS_TRUE'}])
      })

    test
      .stdout()
      .command(['set-default', 'jeffreys.test.key.reforge', '--environment=Staging', '--confirm', '--env-var=GREETING'])
      .it('can create a string provided by an env var', (ctx) => {
        expect(ctx.stdout).to.contain(`Successfully changed default to be provided by \`GREETING\``)
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
        expect(ctx.stdout).to.contain(`Successfully changed default to \`hello\` (encrypted)`)
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
        expect(ctx.stdout).to.match(/Successfully changed default.*encrypted/)
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
        expect(ctx.stdout).to.contain('Successfully changed default to `hello` (encrypted)')
      })

    test
      .stdout()
      .command(['set-default', 'test.json', '--environment=Staging', '--confirm', '--value={"hello":"world"}'])
      .it('can update a json config', (ctx) => {
        expect(ctx.stdout).to.contain(`Successfully changed default to \`{"hello":"world"}\``)
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
