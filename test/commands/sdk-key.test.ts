import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server, deleteNotFoundHandler} from '../responses/sdk-key.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

// Subcommands with topicSeparator=' ' must be passed as a single string, not an array.
// @oclif/test calls `toStandardizedId(id, config)` which replaces spaces with ':'
// so 'sdk-key list' → 'sdk-key:list'.

describe('sdk-key list', () => {
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
    .command(['sdk-key list'])
    .it('lists all SDK keys', (ctx) => {
      expect(ctx.stdout).to.contain('key-uuid-1')
      expect(ctx.stdout).to.contain('key-uuid-2')
      expect(ctx.stdout).to.contain('production')
      expect(ctx.stdout).to.contain('staging')
      expect(ctx.stdout).to.contain('server')
      expect(ctx.stdout).to.contain('browser')
      expect(ctx.stdout).to.contain('qf_sk_production_...')
      expect(ctx.stdout).to.contain('qf_pk_staging_...')
    })

  test
    .stdout()
    .command(['sdk-key list', '--environment', 'production'])
    .it('filters by environment', (ctx) => {
      expect(ctx.stdout).to.contain('key-uuid-1')
      expect(ctx.stdout).to.contain('production')
      expect(ctx.stdout).to.not.contain('key-uuid-2')
      expect(ctx.stdout).to.not.contain('staging')
    })

  test
    .stdout()
    .command(['sdk-key list', '--environment', 'nonexistent'])
    .it('shows empty message for unknown environment filter', (ctx) => {
      expect(ctx.stdout).to.contain('No SDK keys found')
      expect(ctx.stdout).to.contain('nonexistent')
    })
})

describe('sdk-key create', () => {
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
    .command(['sdk-key create', '--environment', 'production', '--type', 'server'])
    .it('creates a server key and shows the raw key once', (ctx) => {
      expect(ctx.stdout).to.contain('SDK key created successfully')
      expect(ctx.stdout).to.contain('production')
      expect(ctx.stdout).to.contain('server')
      expect(ctx.stdout).to.contain('qf_sk_production_abcd1234')
      expect(ctx.stdout).to.contain('key-uuid-new')
      expect(ctx.stdout).to.contain('shown only once')
    })

  test
    .stdout()
    .command(['sdk-key create', '--environment', 'staging', '--type', 'browser'])
    .it('creates a browser key', (ctx) => {
      expect(ctx.stdout).to.contain('SDK key created successfully')
    })

  test
    .stdout()
    .command(['sdk-key create', '--environment', 'nonexistent', '--type', 'server'])
    .catch(/not found/)
    .it('errors on unknown environment')
})

describe('sdk-key revoke', () => {
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
    .command(['sdk-key revoke', 'key-uuid-1'])
    .it('revokes a key by ID', (ctx) => {
      expect(ctx.stdout).to.contain('key-uuid-1')
      expect(ctx.stdout).to.contain('revoked')
    })

  test
    .stdout()
    .do(() => {
      server.use(deleteNotFoundHandler)
    })
    .command(['sdk-key revoke', 'nonexistent-key'])
    .catch(/not found|already revoked/)
    .it('errors when key not found')
})
