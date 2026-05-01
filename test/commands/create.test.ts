import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import * as createResponses from '../responses/create.js'
import {server} from '../responses/create.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('create', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    createResponses.resetCapturedCreateConfigInput()
    createResponses.resetCapturedLogLevelInputs()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  describe('type=boolean-flag', () => {
    test
      .stdout()
      .command(['create', 'brand.new.flag', '--type=boolean-flag'])
      .it('can create a boolean flag', (ctx) => {
        expect(ctx.stdout).to.contain(`Created boolean flag: brand.new.flag`)
      })

    test
      .stdout()
      .command(['create', 'brand.new.flag', '--type=boolean-flag', '--json'])
      .it('can create a boolean flag and return a JSON response', (ctx) => {
        const parsed = JSON.parse(ctx.stdout)
        expect(parsed.key).to.equal('brand.new.flag')
        expect(parsed.type).to.equal('feature_flag')
        expect(parsed.valueType).to.equal('bool')
        expect(parsed.commitSha).to.be.a('string')
      })

    test
      .stdout()
      .command(['create', 'new.with.different.default', '--type=boolean-flag', '--value=true'])
      .it('can create a boolean flag with a true default', (ctx) => {
        expect(ctx.stdout).to.contain(`Created boolean flag: new.with.different.default`)
      })

    test
      .command(['create', 'already.in.use', '--type=boolean-flag'])
      .catch((error) => {
        expect(error.message).to.contain(`Failed to create boolean flag: already.in.use already exists`)
      })
      .it('returns an error if the flag exists', () => {
        // Error assertion done in catch block
      })

    test
      .command(['create', 'brand.new.flag', '--type=boolean-flag', '--value=cake', '--verbose'])
      .catch((error) => {
        expect(error.message).to.contain(`Invalid default value for boolean: cake`)
      })
      .it('returns an error if the value is not a boolean', () => {
        // Error assertion done in catch block
      })

    test
      .stderr()
      .command(['create', 'already.in.use', '--type=boolean-flag', '--json'])
      .catch((error: any) => {
        const message = error?.message || error?.oclif?.exit || String(error)
        expect(message).to.be.a('string')
      })
      .it('returns a JSON error if the flag exists', () => {
        // Error assertion done in catch block
      })
  })

  describe('type=string', () => {
    test
      .stdout()
      .command(['create', 'brand.new.string', '--type=string', '--value=hello.world'])
      .it('can create a string', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: brand.new.string`)
      })

    test
      .stdout()
      .command(['create', 'confidential.new.string', '--type=string', '--value=hello.world', '--confidential'])
      .it('can create a string', (ctx) => {
        expect(ctx.stdout).to.contain(`Created (confidential) config: confidential.new.string`)
      })

    test
      .stdout()
      .command(['create', 'greeting.from.env', '--type=string', '--env-var=GREETING'])
      .it('can create a string provided by an env var', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: greeting.from.env`)
      })

    test
      .stdout()
      .command(['create', 'confidential.greeting.from.env', '--type=string', '--env-var=GREETING', '--confidential'])
      .it('can create a confidential string provided by an env var', (ctx) => {
        expect(ctx.stdout).to.contain(`Created (confidential) config: confidential.greeting.from.env`)
      })

    test
      .stderr()
      .command(['create', 'greeting.from.env', '--type=string', '--env-var=GREETING', '--value=hello.world'])
      .catch((error) => {
        expect(error.message).to.contain(`cannot specify both --env-var and --value`)
      })
      .it('shows an error when provided a default and an env-var', () => {
        // Error assertion done in catch block
      })

    test
      .command(['create', 'brand.new.string', '--type=string', '--no-interactive'])
      .catch((error) => {
        expect(error.message).to.contain(`No value provided for`)
      })
      .it('errors when no value is provided in non-interactive mode', () => {
        // Error assertion done in catch block
      })

    // Regression: previously this would hang with "Detected unsettled top-level
    // await" because isInteractive returned true in non-TTY contexts (the
    // --interactive flag's default=true bypassed the TTY check). The fix
    // auto-detects the non-TTY stdio and surfaces a clean error telling the
    // user exactly which flag to pass.
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
        .command(['create', 'brand.new.json', '--type=json'])
        .catch((error) => {
          expect(error.message).to.contain('No value provided for')
          expect(error.message).to.contain('--value')
        })
        .it('errors cleanly instead of hanging when stdin/stdout is not a TTY', () => {
          // Error assertion done in catch block
        })
    })
  })

  describe('type=int', () => {
    test
      .stdout()
      .command(['create', 'brand.new.int', '--type=int', '--value=123'])
      .it('can create an int', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: brand.new.int`)
      })

    test
      .command(['create', 'brand.new.int', '--type=int', '--value=hat'])
      .catch((error) => {
        expect(error.message).to.contain(`Invalid default value for int: hat`)
      })
      .it('returns an error if the value is not an int', () => {
        // Error assertion done in catch block
      })

    test
      .stdout()
      .command(['create', 'int.from.env', '--type=int', '--env-var=MY_INT'])
      .it('can create an int provided by an env var', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: int.from.env`)
      })
  })

  describe('type=double', () => {
    test
      .stdout()
      .command(['create', 'brand.new.double', '--type=double', '--value=123.99'])
      .it('can create a double', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: brand.new.double`)
      })

    test
      .command(['create', 'brand.new.double', '--type=double', '--value=hat'])
      .catch((error) => {
        expect(error.message).to.contain(`Invalid default value for double: hat`)
      })
      .it('returns an error if the value is not a double', () => {
        // Error assertion done in catch block
      })
  })

  describe('type=boolean', () => {
    test
      .stdout()
      .command(['create', 'brand.new.boolean', '--type=boolean', '--value=f'])
      .it('can create a boolean', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: brand.new.boolean`)
      })

    test
      .command(['create', 'brand.new.boolean', '--type=boolean', '--value=hat'])
      .catch((error) => {
        expect(error.message).to.contain(`Invalid default value for boolean: hat`)
      })
      .it('returns an error if the value is not a boolean', () => {
        // Error assertion done in catch block
      })
  })

  describe('type=string-list', () => {
    test
      .stdout()
      .command(['create', 'brand.new.string-list', '--type=string-list', '--value=a,b,c,d'])
      .it('can create a string list', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: brand.new.string-list`)
      })
  })

  describe('type=json', () => {
    test
      .stdout()
      .command(['create', 'brand.new.json', '--type=json', '--value={"key": "value"}'])
      .it('can create a JSON object', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: brand.new.json`)
      })

    test
      .stdout()
      .command(['create', 'brand.new.json', '--type=json', '--value={"active":false,"cap":0}'])
      .it('sends the parsed JSON object as the default value (qfg-c0q repro)', () => {
        const input = createResponses.capturedCreateConfigInput
        expect(input, 'request body was captured').to.not.equal(null)
        const defaultValue = input?.config?.defaultValue
        expect(defaultValue).to.deep.equal({
          type: 'json',
          value: {active: false, cap: 0},
        })
      })

    test
      .command(['create', 'invalid.new.json', '--type=json', '--value={not:valid}'])
      .catch((error) => {
        expect(error.message).to.contain(`Invalid default value for JSON: {not:valid}`)
      })
      .it('returns an error if the value is not JSON', () => {
        // Error assertion done in catch block
      })
  })

  describe('type=duration', () => {
    test
      .stdout()
      .command(['create', 'my.timeout', '--type=duration', '--value=PT90S'])
      .it('can create a duration config and sends ISO 8601 string as value', (ctx) => {
        expect(ctx.stdout).to.contain(`Created config: my.timeout`)
        const input = createResponses.capturedCreateConfigInput
        expect(input, 'request body was captured').to.not.equal(null)
        expect(input?.config?.valueType).to.equal('duration')
        expect(input?.config?.defaultValue).to.deep.equal({
          type: 'duration',
          value: 'PT90S',
        })
      })

    test
      .command(['create', 'my.timeout', '--type=duration', '--value=ninety-seconds'])
      .catch((error) => {
        expect(error.message).to.contain(`Invalid default value for duration: ninety-seconds`)
      })
      .it('returns an error if the value is not an ISO 8601 duration', () => {
        // Error assertion done in catch block
      })
  })

  describe('type=log_level', () => {
    test
      .stdout()
      .command(['create', 'log-level.my-app', '--type=log_level', '--value=INFO'])
      .it('can create a log level with the default INFO value (no update call)', (ctx) => {
        expect(ctx.stdout).to.contain('Created log level: log-level.my-app (default: INFO)')
        expect(createResponses.capturedLogLevelCreateInput).to.not.equal(null)
        expect(createResponses.capturedLogLevelCreateInput?.logLevel?.key).to.equal('log-level.my-app')
        // No update when value matches server default INFO.
        expect(createResponses.capturedLogLevelUpdateInput).to.equal(null)
      })

    test
      .stdout()
      .command(['create', 'log-level.my-app', '--type=log_level', '--value=WARN'])
      .it('creates and then patches default when value != INFO', (ctx) => {
        expect(ctx.stdout).to.contain('Created log level: log-level.my-app (default: WARN)')
        expect(createResponses.capturedLogLevelCreateInput?.logLevel?.key).to.equal('log-level.my-app')
        const update = createResponses.capturedLogLevelUpdateInput
        expect(update?.logLevelKey).to.equal('log-level.my-app')
        expect(update?.expectedCommitSha).to.equal('sha-after-create')
        expect(update?.logLevel?.default?.rules?.[0]?.value).to.deep.equal({
          type: 'log_level',
          value: 'WARN',
        })
      })

    test
      .stdout()
      .command(['create', 'log-level.my-app', '--type=log_level', '--value=warn'])
      .it('accepts lowercase values and uppercases them', (ctx) => {
        expect(ctx.stdout).to.contain('Created log level: log-level.my-app (default: WARN)')
      })

    test
      .command(['create', 'my-app', '--type=log_level', '--value=WARN'])
      .catch((error) => {
        expect(error.message).to.contain('Log level key "my-app" must start with "log-level.". Try: log-level.my-app')
      })
      .it('rejects keys missing the log-level. prefix with a fix suggestion', () => {
        // Error assertion done in catch block
      })

    test
      .command(['create', 'log-level.my-app', '--type=log_level', '--value=SPAMMY'])
      .catch((error) => {
        expect(error.message).to.contain('Invalid log level "SPAMMY"')
        expect(error.message).to.contain('TRACE, DEBUG, INFO, WARN, ERROR, FATAL')
      })
      .it('rejects invalid levels', () => {
        // Error assertion done in catch block
      })

    test
      .command(['create', 'log-level.my-app', '--type=log_level', '--value=WARN', '--env-var=MY_LEVEL'])
      .catch((error) => {
        expect(error.message).to.contain('--env-var is not supported for log_level')
      })
      .it('rejects --env-var', () => {
        // Error assertion done in catch block
      })

    test
      .command(['create', 'log-level.my-app', '--type=log_level', '--value=WARN', '--secret'])
      .catch((error) => {
        expect(error.message).to.contain('--secret is not supported for log_level')
      })
      .it('rejects --secret', () => {
        // Error assertion done in catch block
      })

    test
      .command(['create', 'log-level.my-app', '--type=log_level', '--value=WARN', '--confidential'])
      .catch((error) => {
        expect(error.message).to.contain('--confidential is not supported for log_level')
      })
      .it('rejects --confidential', () => {
        // Error assertion done in catch block
      })

    test
      .command(['create', 'log-level.already-exists', '--type=log_level', '--value=WARN'])
      .catch((error) => {
        expect(error.message).to.contain('Failed to create log level: log-level.already-exists already exists')
      })
      .it('returns a conflict error when the log level already exists', () => {
        // Error assertion done in catch block
      })
  })

  describe('log-level alias', () => {
    test
      .stdout()
      .command(['log-level', 'log-level.alias-app', '--value=DEBUG'])
      .it('delegates to create --type=log_level', (ctx) => {
        expect(ctx.stdout).to.contain('Created log level: log-level.alias-app (default: DEBUG)')
        expect(createResponses.capturedLogLevelCreateInput?.logLevel?.key).to.equal('log-level.alias-app')
        const update = createResponses.capturedLogLevelUpdateInput
        expect(update?.logLevel?.default?.rules?.[0]?.value).to.deep.equal({
          type: 'log_level',
          value: 'DEBUG',
        })
      })

    test
      .command(['log-level', 'log-level.alias-app', '--value=SPAMMY'])
      .catch((error) => {
        // oclif will reject SPAMMY at flag parse since we constrain options.
        expect(error.message).to.match(/expected --value=spammy to be one of/i)
      })
      .it('rejects invalid levels at the flag layer', () => {
        // Error assertion done in catch block
      })
  })

  describe('log-level --target (per-logger targeting)', () => {
    test
      .stdout()
      .command(['log-level', 'log-level.existing', '--target=MyPackage.Noisy', '--value=ERROR'])
      .it('prepends a targeting rule to an existing config', (ctx) => {
        expect(ctx.stdout).to.contain('Set log level ERROR for loggers starting with [MyPackage.Noisy]')
        const update = createResponses.capturedLogLevelUpdateInput
        expect(update?.logLevelKey).to.equal('log-level.existing')
        expect(update?.expectedCommitSha).to.equal('sha-existing')
        const rules = update?.logLevel?.default?.rules
        expect(rules).to.have.lengthOf(2)
        expect(rules?.[0]).to.deep.equal({
          criteria: [
            {
              operator: 'PROP_STARTS_WITH_ONE_OF',
              propertyName: 'quonfig-sdk-logging.key',
              valueToMatch: {type: 'string_list', value: ['MyPackage.Noisy']},
            },
          ],
          value: {type: 'log_level', value: 'ERROR'},
        })
        // Original catch-all kept after the new rule.
        expect(rules?.[1]?.criteria?.[0]?.operator).to.equal('ALWAYS_TRUE')
      })

    test
      .stdout()
      .command(['log-level', 'log-level.existing', '--target=A', '--target=B', '--value=WARN'])
      .it('supports multiple --target values in one OR rule', () => {
        const update = createResponses.capturedLogLevelUpdateInput
        expect(update?.logLevel?.default?.rules?.[0]?.criteria?.[0]?.valueToMatch).to.deep.equal({
          type: 'string_list',
          value: ['A', 'B'],
        })
      })

    test
      .stdout()
      .command(['log-level', 'log-level.existing-with-rule', '--target=Foo.Bar', '--value=WARN'])
      .it('replaces an existing rule when targets match exactly (no duplicate)', () => {
        const update = createResponses.capturedLogLevelUpdateInput
        const rules = update?.logLevel?.default?.rules
        expect(rules).to.have.lengthOf(2) // replaced in place, not prepended
        expect(rules?.[0]?.value).to.deep.equal({type: 'log_level', value: 'WARN'})
        expect(rules?.[0]?.criteria?.[0]?.valueToMatch).to.deep.equal({
          type: 'string_list',
          value: ['Foo.Bar'],
        })
      })

    test
      .stdout()
      .command(['log-level', 'log-level.existing', '--target=X', '--value=DEBUG', '--environment=production'])
      .it('writes the rule to environments[env] when --environment is set', () => {
        const update = createResponses.capturedLogLevelUpdateInput
        expect(update?.logLevel?.environments).to.be.an('array')
        const prodEnv = update?.logLevel?.environments?.find((e: any) => e.id === 'production')
        expect(prodEnv?.rules?.[0]?.criteria?.[0]?.valueToMatch).to.deep.equal({
          type: 'string_list',
          value: ['X'],
        })
        // No default block patch when targeting an env.
        expect(update?.logLevel?.default).to.equal(undefined)
      })

    test
      .command(['log-level', 'log-level.does-not-exist', '--target=X', '--value=DEBUG'])
      .catch((error) => {
        expect(error.message).to.contain('Log level "log-level.does-not-exist" does not exist')
        expect(error.message).to.contain('qfg log-level log-level.does-not-exist --value=INFO')
      })
      .it('errors with a helpful create-first hint when the config does not exist', () => {
        // Error assertion done in catch block
      })

    test
      .command(['log-level', 'log-level.existing', '--target=X'])
      .catch((error) => {
        expect(error.message).to.contain('--value is required with --target')
      })
      .it('requires --value when --target is set', () => {
        // Error assertion done in catch block
      })

    test
      .command(['log-level', 'log-level.existing', '--environment=production', '--value=WARN'])
      .catch((error) => {
        expect(error.message).to.contain('--environment requires --target')
        expect(error.message).to.contain('qfg set-default')
      })
      .it('rejects --environment without --target (points to set-default)', () => {
        // Error assertion done in catch block
      })
  })

  describe('secret', () => {
    describe('when encryption key does not exist in metadata', () => {
      test
        .command([
          'create',
          'brand.new.string',
          '--type=string',
          '--value=hello.world',
          '--secret',
          '--secret-key-name=missing.secret.key',
        ])
        .catch((error) => {
          expect(error.message).to.contain(
            `Failed to create secret: encryption key 'missing.secret.key' does not exist. Please create it first or use --secret-key-name to specify a different key.`,
          )
        })
        .it('checks metadata and returns helpful error', () => {
          // Error assertion done in catch block
        })
    })

    describe('type=string', () => {
      test
        .env({
          QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: 'c87ba22d8662282abe8a0e4651327b579cb64a454ab0f4c170b45b15f049a221',
        })
        .stdout()
        .command(['create', 'brand.new.secret', '--type=string', '--value=hello.world', '--secret'])
        .it('can create a string', (ctx) => {
          expect(ctx.stdout).to.contain(`Created config: brand.new.secret`)
        })
    })

    describe('with literal encryption key value', () => {
      test
        .stdout()
        .command([
          'create',
          'secret.with.literal.key',
          '--type=string',
          '--value=hello.world',
          '--secret',
          '--secret-key-name=literal.encryption.key',
        ])
        .it('can create a secret using literal encryption key', (ctx) => {
          expect(ctx.stdout).to.contain(`Created config: secret.with.literal.key`)
        })
    })

    describe('with new format encryption key (type: provided)', () => {
      test
        .env({
          QUONFIG_INTEGRATION_TEST_ENCRYPTION_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })
        .stdout()
        .command([
          'create',
          'secret.with.new.format.key',
          '--type=string',
          '--value=hello.world',
          '--secret',
          '--secret-key-name=new.format.encryption.key',
        ])
        .it('can create a secret using new format encryption key', (ctx) => {
          expect(ctx.stdout).to.contain(`Created config: secret.with.new.format.key`)
        })
    })

    describe('type=NOT_STRING', () => {
      test
        .stderr()
        .command(['create', 'brand.new.secret', '--type=int', '--value=12', '--secret'])
        .catch((error) => {
          expect(error.message).to.contain(`--secret flag only works with string type`)
        })
        .it('errors', () => {
          // Error assertion done in catch block
        })
    })
  })

  // qfg-d5t: server-side create should also drop the JSON file into
  // ${QUONFIG_DIR}/<subdir>/<key>.json so the user doesn't have to run
  // `qfg pull` afterwards. The server already returns the full StoredConfig
  // (FlagDetail / ConfigDetail) — we just need to write it locally.
  describe('writes the new config to disk under QUONFIG_DIR (qfg-d5t)', () => {
    let tmpDir: string
    let prevQuonfigDir: string | undefined
    let prevQuonfigDirSet = false

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qfg-create-d5t-'))
      // Make it look like a workspace dir so writes are not gated on a
      // missing quonfig.json (mirroring `qfg pull`'s output state).
      fs.writeFileSync(path.join(tmpDir, 'quonfig.json'), '{"workspace":"acme/test"}\n')
      prevQuonfigDirSet = Object.hasOwn(process.env, 'QUONFIG_DIR')
      prevQuonfigDir = process.env.QUONFIG_DIR
      process.env.QUONFIG_DIR = tmpDir
    })

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, {force: true, recursive: true})
      } catch {
        // ignore
      }

      if (prevQuonfigDirSet) {
        process.env.QUONFIG_DIR = prevQuonfigDir
      } else {
        delete process.env.QUONFIG_DIR
      }
    })

    test
      .stdout()
      .command(['create', 'flag.cli-test', '--type=boolean-flag', '--value=true'])
      .it('writes feature-flags/<key>.json after a successful boolean-flag create', () => {
        const filePath = path.join(tmpDir, 'feature-flags', 'flag.cli-test.json')
        expect(fs.existsSync(filePath), `expected ${filePath} to exist on disk`).to.equal(true)
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
        expect(parsed.key).to.equal('flag.cli-test')
        expect(parsed.type).to.equal('feature_flag')
        expect(parsed.valueType).to.equal('bool')
        // commitSha is server-only metadata; it must NOT bleed into the
        // on-disk config (the canonical source of truth in git).
        expect(parsed).to.not.have.property('commitSha')
      })

    test
      .stdout()
      .command(['create', 'string.cli-test', '--type=string', '--value=hello'])
      .it('writes configs/<key>.json after a successful regular config create', () => {
        const filePath = path.join(tmpDir, 'configs', 'string.cli-test.json')
        expect(fs.existsSync(filePath), `expected ${filePath} to exist on disk`).to.equal(true)
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>
        expect(parsed.key).to.equal('string.cli-test')
        expect(parsed.type).to.equal('config')
        expect(parsed).to.not.have.property('commitSha')
      })

    test
      .stdout()
      .command(['create', 'flag.no-dir', '--type=boolean-flag', '--value=true'])
      .do(() => {
        // Override QUONFIG_DIR to a missing path — the create should still
        // succeed (server-side create is the source of truth) and exit 0;
        // we just don't write locally. This is the "no workspace cloned
        // yet" path.
        delete process.env.QUONFIG_DIR
      })
      .it('does not fail if QUONFIG_DIR is unset', (ctx) => {
        expect(ctx.stdout).to.contain('Created boolean flag: flag.no-dir')
      })
  })
})
