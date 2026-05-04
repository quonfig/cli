import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {DELETED_ITEMS, server} from '../../responses/activity.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('activity deleted', () => {
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
    .command(['activity deleted'])
    .it('renders a row per tombstoned item with type, key, deletedBy, deletedAt', (ctx) => {
      expect(ctx.stdout).to.contain('tombstoned.flag')
      expect(ctx.stdout).to.contain('feature_flag')
      expect(ctx.stdout).to.contain('Alice')
      expect(ctx.stdout).to.contain('gone.config')
      expect(ctx.stdout).to.contain('Bob')
    })

  test
    .stdout()
    .command(['activity deleted', '--json'])
    .it('passes the server response through with --json', (ctx) => {
      const payload = JSON.parse(ctx.stdout)
      expect(payload.items).to.deep.equal(DELETED_ITEMS)
    })
})
