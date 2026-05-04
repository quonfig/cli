import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {RICH_HISTORY_ITEMS, knownConfigKey, richHistoryRequests, server, unknownKey} from '../../responses/activity.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('activity history', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    richHistoryRequests.length = 0
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['activity history', knownConfigKey])
    .it('resolves NAME → configType via metadata/list and renders per-commit entries', (ctx) => {
      // Mechanism: the server requires configType, so the CLI must look it up
      // — the request body shows the resolved type.
      expect(richHistoryRequests).to.have.length(1)
      expect(richHistoryRequests[0].configKey).to.equal(knownConfigKey)
      expect(richHistoryRequests[0].configType).to.equal('feature_flag')

      // Render: each entry shows sha, author, date, action, message.
      expect(ctx.stdout).to.contain('Alice')
      expect(ctx.stdout).to.contain('Carol')
      expect(ctx.stdout).to.contain('Updated default rule from false to true')
      expect(ctx.stdout).to.contain('Restored flag "my.flag"')
      // Restore action is rendered distinctly.
      expect(ctx.stdout).to.contain('restored')
    })

  test
    .stdout()
    .command(['activity history', knownConfigKey, '--json'])
    .it('passes the server response through with --json', (ctx) => {
      const payload = JSON.parse(ctx.stdout)
      expect(payload.configKey).to.equal(knownConfigKey)
      expect(payload.configType).to.equal('feature_flag')
      expect(payload.entries).to.deep.equal(RICH_HISTORY_ITEMS)
    })

  test
    .command(['activity history', unknownKey])
    .catch((error) => {
      expect(error.message).to.match(new RegExp(unknownKey))
    })
    .it('errors when the key is not found in metadata/list')
})
