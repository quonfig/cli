import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/override.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('override', () => {
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
    .command(['override', 'feature-flag.simple', '--value=true', '--environment=Development'])
    .it('overrides a boolean flag when given a valid key and value', (ctx) => {
      expect(ctx.stdout).to.contain(`Override set`)
    })

  test
    .stdout()
    .command(['override', 'my-double-key', '--value=42.1', '--environment=Development'])
    .it('overrides a double config when given a valid key and value', (ctx) => {
      expect(ctx.stdout).to.contain(`Override set`)
    })

  test
    .stdout()
    .command(['override', 'my-string-list-key', '--value=a,b,c,d', '--environment=Development'])
    .it('overrides a string list config when given a valid key and value', (ctx) => {
      expect(ctx.stdout).to.contain(`Override set`)
    })

  test
    .stderr()
    .command(['override', 'my-double-key', '--value=pumpkin', '--environment=Development'])
    .catch((error) => {
      expect(error.message).to.contain(`Failed to override value: 400 -- is pumpkin a valid double?`)
    })
    .it('shows an error when the value type is wrong', () => {
      // Error assertion done in catch block
    })

  test
    .stderr()
    .command(['override', 'this.does.not.exist', '--value=true', '--environment=Development'])
    .catch((error) => {
      expect(error.message).to.contain(`Could not find config named this.does.not.exist`)
    })
    .it('shows an error when the key does not exist', () => {
      // Error assertion done in catch block
    })

  test
    .command(['override', 'this.does.not.exist', '--value=true', '--remove'])
    .catch((error) => {
      expect(error.message).to.contain(`remove and value flags are mutually exclusive`)
    })
    .it('shows an error when given remove and a value', () => {
      // Error assertion done in catch block
    })

  test
    .stdout()
    .command(['override', 'jeffreys.test.key.reforge', '--remove', '--environment=Development'])
    .it('removes an override successfully', (ctx) => {
      expect(ctx.stdout).to.contain(`Override removed`)
    })

  test
    .stdout()
    .command(['override', 'my-double-key', '--remove', '--environment=Development'])
    .it('succeeds when trying to remove an override that does not exist', (ctx) => {
      expect(ctx.stdout).to.contain(`No override found for my-double-key`)
    })
})
