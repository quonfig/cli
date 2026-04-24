import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {conflictHandler, multiOrgHandler, server, unauthorizedHandler} from '../../responses/workspace-create.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

// Subcommands with topicSeparator=' ' must be passed as a single id string.
// See sdk-key.test.ts for the same pattern.

describe('workspace create', () => {
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
    .command(['workspace create', 'lt-21-smoke'])
    .it('prints the new workspace on 201 success', (ctx) => {
      expect(ctx.stdout).to.contain('Workspace created.')
      expect(ctx.stdout).to.contain('ws-uuid-new')
      expect(ctx.stdout).to.contain('lt-21-smoke')
      expect(ctx.stdout).to.contain('test-organization')
      expect(ctx.stdout).to.contain('production')
      expect(ctx.stdout).to.contain('staging')
      expect(ctx.stdout).to.contain('development')
    })

  test
    .stdout()
    .stderr()
    .do(() => {
      server.use(conflictHandler)
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('already exists')
      expect(error.message).to.contain('Pick a different slug')
    })
    .it('reports 409 slug collision with a helpful suggestion')

  test
    .stdout()
    .stderr()
    .do(() => {
      server.use(unauthorizedHandler)
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('Authentication')
      expect(error.message).to.contain('qfg login')
    })
    .it('reports 401 with a login hint')

  test
    .stdout()
    .stderr()
    .do(() => {
      server.use(multiOrgHandler)
    })
    .command(['workspace create', 'lt-21-smoke'])
    .catch((error: Error) => {
      expect(error.message).to.contain('more than one organization')
      expect(error.message).to.contain('--org')
    })
    .it('reports 400 multi-org with --org guidance')
})
