import {expect, test} from '@oclif/test'
import {createHash} from 'node:crypto'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/get.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const validKey = 'my-string-list-key'
const secretKey = 'a.secret.config.reforge'

// 64-char hex key matching the one used in test/util/encryption.test.ts
const CIPHERTEXT = '652cf03ad4e252bb9b69c9--03bbdb754d1923b2a3c5bfc3--ebb8c20805482ce013b1fd68cad57d69'
const CIPHERTEXT_FINGERPRINT = `*****${createHash('md5').update(CIPHERTEXT).digest('hex').slice(0, 5)}`

const TEST_ENCRYPTION_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('get', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    delete process.env.TEST_CLI_PROVIDED_VAR
    delete process.env.TEST_CLI_ENCRYPTION_KEY
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })
  test
    .stdout()
    .command(['get', validKey, '--environment=[default]'])
    .it('returns a value for a valid name', (ctx) => {
      expect(ctx.stdout).to.eql("[ 'a', 'b', 'c' ]\n")
    })

  test
    .stdout()
    .command(['get', validKey, '--json', '--environment=[default]'])
    .it('returns JSON for a value for a valid name', (ctx) => {
      expect(JSON.parse(ctx.stdout)).to.eql({[validKey]: ['a', 'b', 'c']})
    })

  test
    .stdout()
    .command(['get', secretKey, '--environment=[default]'])
    .it('returns a normal config value', (ctx) => {
      expect(ctx.stdout).to.eql('hello.world\n')
    })

  // providedBy: the server returns the dependency pointer only; the CLI reads
  // the env var from the CLI host and returns the resolved value.
  //
  // qfg-zvef: stdout must be the bare value and NOTHING else — `qfg get` is
  // routinely used inside a shell command substitution, and diagnostics on
  // stdout get captured into the value (that is how a decrypted prod secret
  // ended up in a Bearer header). Diagnostics belong on stderr.
  test
    .do(() => {
      process.env.TEST_CLI_PROVIDED_VAR = 'cli-host-env-value'
    })
    .stdout()
    .stderr()
    .command(['get', 'provided.config', '--environment=[default]'])
    .it('resolves a providedBy config from the CLI host process.env', (ctx) => {
      expect(ctx.stdout).to.eql('cli-host-env-value\n')
      expect(ctx.stderr).to.contain("This config is provided by env var 'TEST_CLI_PROVIDED_VAR'")
      expect(ctx.stderr).to.contain("Successfully resolved config 'provided.config' from env var")
    })

  test
    .stdout()
    .command(['get', 'provided.config', '--json', '--environment=[default]'])
    .catch((error: {missingEnvVar?: string} & Error) => {
      expect(error.missingEnvVar).to.equal('TEST_CLI_PROVIDED_VAR')
    })
    .it('errors with missingEnvVar when the providedBy env var is unset')

  // qfg-hzmb: the caller's structured payload (the second argument to
  // `this.err`) has to survive onto stdout, not just onto the thrown object —
  // an agent reading `--json` output can only see stdout.
  test
    .stdout()
    .command(['get', 'provided.config', '--json', '--environment=[default]'])
    .catch(/.*/)
    .it('carries the err() payload into the JSON error envelope on stdout', (ctx) => {
      expect(ctx.stdout.trim(), 'stdout must not be empty on a --json failure').to.not.equal('')

      const output = JSON.parse(ctx.stdout) as {error: {message: string; missingEnvVar?: string}}
      expect(output.error.missingEnvVar).to.equal('TEST_CLI_PROVIDED_VAR')
      expect(output.error.message).to.be.a('string').and.to.have.length.greaterThan(0)
    })

  // decryptWith: the server returns ciphertext + dependency chain; the CLI
  // reads the encryption key from its own process.env and decrypts locally.
  // qfg-zvef: the decrypted plaintext must be the ONLY thing on stdout.
  // qfg-38lp: a secret prints redacted by default; --reveal prints the plaintext.
  // The fingerprint hashes the CIPHERTEXT, matching what SDK telemetry reports.
  test
    .do(() => {
      process.env.TEST_CLI_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_HEX
    })
    .stdout()
    .stderr()
    .command(['get', 'encrypted.config', '--environment=[default]'])
    .it('prints a secret redacted by default, with a --reveal hint on stderr', (ctx) => {
      expect(ctx.stdout).to.eql(`[encrypted ${CIPHERTEXT_FINGERPRINT}, 11 chars]\n`)
      expect(ctx.stdout + ctx.stderr).to.not.contain('test-secret')
      expect(ctx.stderr).to.contain('pass --reveal to print the plaintext')
    })

  // decryptWith: the server returns ciphertext + dependency chain; the CLI
  // reads the encryption key from its own process.env and decrypts locally.
  // qfg-zvef: the decrypted plaintext must be the ONLY thing on stdout.
  test
    .do(() => {
      process.env.TEST_CLI_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_HEX
    })
    .stdout()
    .stderr()
    .command(['get', 'encrypted.config', '--reveal', '--environment=[default]'])
    .it('decrypts an encrypted config locally using the CLI host env key with --reveal', (ctx) => {
      expect(ctx.stdout).to.eql('test-secret\n')
      expect(ctx.stderr).to.contain(
        "This config is encrypted by key 'quonfig.encryption.key' that should be found in env var 'TEST_CLI_ENCRYPTION_KEY'",
      )
      expect(ctx.stderr).to.contain("Successfully decrypted config 'encrypted.config'")
    })

  // --json output must stay on stdout and stay parseable: the diagnostics are
  // suppressed entirely under --json (oclif's jsonEnabled() guard).
  test
    .do(() => {
      process.env.TEST_CLI_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_HEX
    })
    .stdout()
    .stderr()
    .command(['get', 'encrypted.config', '--json', '--environment=[default]'])
    .it('emits a redacted JSON summary by default for a secret', (ctx) => {
      expect(JSON.parse(ctx.stdout)).to.eql({
        'encrypted.config': {encrypted: true, fingerprint: CIPHERTEXT_FINGERPRINT, length: 11, redacted: true},
      })
      expect(ctx.stderr).to.eql('')
    })

  test
    .do(() => {
      process.env.TEST_CLI_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_HEX
    })
    .stdout()
    .stderr()
    .command(['get', 'encrypted.config', '--json', '--reveal', '--environment=[default]'])
    .it('emits only the plaintext JSON on stdout for --json --reveal', (ctx) => {
      expect(JSON.parse(ctx.stdout)).to.eql({'encrypted.config': 'test-secret'})
      expect(ctx.stderr).to.eql('')
    })

  test
    .stdout()
    .command(['get', 'encrypted.config', '--json', '--environment=[default]'])
    .catch((error: {missingEnvVar?: string} & Error) => {
      expect(error.missingEnvVar).to.equal('TEST_CLI_ENCRYPTION_KEY')
    })
    .it('errors with missingEnvVar when the decryptWith key env var is unset')

  test
    .command(['get', 'this-does-not-exist', '--environment=[default]'])
    .catch((error) => {
      expect(error.message).to.eql(`this-does-not-exist does not exist`)
    })
    .it('shows an error if the key is invalid', () => {
      // Error assertion done in catch block
    })

  test
    .command(['get', '--no-interactive'])
    .catch((error) => {
      expect(error.message).to.eql('Key is required')
    })
    .it("shows an error if no key is provided when things aren't interactive", () => {
      // Error assertion done in catch block
    })

  // qfg-38lp fix pass: --verbose dumped the whole evaluate response, which
  // carries every confidential plaintext in the workspace.
  test
    .stdout()
    .stderr()
    .command(['get', validKey, '--environment=[default]', '--verbose'])
    .it('--verbose does not leak other keys confidential plaintext', (ctx) => {
      expect(ctx.stdout + ctx.stderr).to.not.contain('FAKE_CONF_PLAINTEXT_0001')
      expect(ctx.stderr).to.contain('[ApiClient]')
    })

  // A redacted read should not announce that it decrypted anything.
  test
    .do(() => {
      process.env.TEST_CLI_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_HEX
    })
    .stdout()
    .stderr()
    .command(['get', 'encrypted.config', '--environment=[default]'])
    .it('a redacted get does not print the "Successfully decrypted" diagnostics', (ctx) => {
      expect(ctx.stderr).to.not.contain('Successfully decrypted')
      expect(ctx.stderr).to.not.contain('should be found in env var')
    })
})
