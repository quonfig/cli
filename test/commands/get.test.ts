import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/get.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const validKey = 'my-string-list-key'
const secretKey = 'a.secret.config.reforge'

describe('get', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
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

  // In the new oRPC API, provided configs are resolved server-side.
  // The evaluation response returns the resolved value directly.
  test
    .stdout()
    .command(['get', 'provided.config', '--environment=[default]'])
    .it('returns a provided config value resolved by the server', (ctx) => {
      expect(ctx.stdout).to.contain('server-resolved-value')
    })

  // In the new oRPC API, encrypted configs are decrypted server-side.
  // The evaluation response returns the decrypted value directly.
  test
    .stdout()
    .command(['get', 'encrypted.config', '--environment=[default]'])
    .it('returns a decrypted config value resolved by the server', (ctx) => {
      expect(ctx.stdout).to.contain('test-secret')
    })

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
