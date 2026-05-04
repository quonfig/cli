import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {feedRequests, knownConfigKey, richHistoryRequests, server} from '../../responses/activity.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

/**
 * The discoverability child (qfg-d6cn.3) ships three top-level wrappers:
 *
 *   qfg audit-log [NAME]   →   activity feed   |   activity history NAME
 *   qfg history NAME       →   activity history NAME
 *   qfg log                →   activity feed
 *
 * These tests assert the dispatch — if a future refactor breaks the routing,
 * the request body to the underlying endpoint won't match.
 */

describe('activity discoverability aliases', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    feedRequests.length = 0
    richHistoryRequests.length = 0
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['audit-log'])
    .it('`qfg audit-log` (no positional) routes to activity feed', () => {
      expect(feedRequests).to.have.length(1)
      expect(richHistoryRequests).to.have.length(0)
    })

  test
    .stdout()
    .command(['audit-log', knownConfigKey])
    .it('`qfg audit-log NAME` routes to activity history', () => {
      expect(richHistoryRequests).to.have.length(1)
      expect(richHistoryRequests[0].configKey).to.equal(knownConfigKey)
      expect(feedRequests).to.have.length(0)
    })

  test
    .stdout()
    .command(['history', knownConfigKey])
    .it('`qfg history NAME` routes to activity history', () => {
      expect(richHistoryRequests).to.have.length(1)
      expect(richHistoryRequests[0].configKey).to.equal(knownConfigKey)
    })

  test
    .stdout()
    .command(['log'])
    .it('`qfg log` routes to activity feed', () => {
      expect(feedRequests).to.have.length(1)
    })
})
