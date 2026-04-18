import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/get.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const validKey = 'my-string-list-key'
const secretKey = 'a.secret.config.reforge'

// 64-char hex key matching the one used in test/util/encryption.test.ts
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
  test
    .do(() => {
      process.env.TEST_CLI_PROVIDED_VAR = 'cli-host-env-value'
    })
    .stdout()
    .command(['get', 'provided.config', '--environment=[default]'])
    .it('resolves a providedBy config from the CLI host process.env', (ctx) => {
      expect(ctx.stdout).to.contain('cli-host-env-value')
    })

  test
    .stdout()
    .command(['get', 'provided.config', '--json', '--environment=[default]'])
    .catch((error: {missingEnvVar?: string} & Error) => {
      expect(error.missingEnvVar).to.equal('TEST_CLI_PROVIDED_VAR')
    })
    .it('errors with missingEnvVar when the providedBy env var is unset')

  // decryptWith: the server returns ciphertext + dependency chain; the CLI
  // reads the encryption key from its own process.env and decrypts locally.
  test
    .do(() => {
      process.env.TEST_CLI_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_HEX
    })
    .stdout()
    .command(['get', 'encrypted.config', '--environment=[default]'])
    .it('decrypts an encrypted config locally using the CLI host env key', (ctx) => {
      expect(ctx.stdout).to.contain('test-secret')
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
})
