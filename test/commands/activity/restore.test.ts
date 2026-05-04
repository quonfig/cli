import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {
  deletionForKeyRequests,
  restoreOnlyDeletedKey,
  restoreRequests,
  server,
  unknownKey,
} from '../../responses/activity.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('activity restore', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    deletionForKeyRequests.length = 0
    restoreRequests.length = 0
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['activity restore', restoreOnlyDeletedKey, '--type', 'feature_flag', '--yes'])
    .it('confirms tombstone, calls restoreItem, prints new commit sha + URL', (ctx) => {
      // Mechanism: both endpoints must be hit, in order. If the command
      // skips the tombstone check it still appears to "work" but loses the
      // friendly "not deleted" guard the bead requires.
      expect(deletionForKeyRequests).to.have.length(1)
      expect(deletionForKeyRequests[0].configKey).to.equal(restoreOnlyDeletedKey)
      expect(deletionForKeyRequests[0].configType).to.equal('feature_flag')

      expect(restoreRequests).to.have.length(1)
      expect(restoreRequests[0].configKey).to.equal(restoreOnlyDeletedKey)

      // Output surfaces the new sha + app URL.
      expect(ctx.stdout).to.contain('ffffffff')
      expect(ctx.stdout).to.contain(`/workspaces/workspace-123/flags/${restoreOnlyDeletedKey}`)
    })

  test
    .stdout()
    .stderr()
    .command(['activity restore', unknownKey, '--type', 'feature_flag', '--yes'])
    .catch((error) => {
      expect(error.message).to.match(/not currently deleted/i)
    })
    .it('errors clearly when the key has no tombstone', () => {
      // Mechanism: when getDeletionForKey returns null, restoreItem must NOT
      // be called.
      expect(restoreRequests).to.have.length(0)
    })
})
