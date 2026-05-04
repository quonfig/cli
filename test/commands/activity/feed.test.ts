import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {FEED_ITEMS, feedRequests, server} from '../../responses/activity.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

// Subcommands with topicSeparator=' ' must be passed as a single string id;
// @oclif/test rewrites the space to a colon. See sdk-key.test.ts for the
// same pattern in this repo.

describe('activity feed', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    feedRequests.length = 0
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['activity feed'])
    .it('renders one block per feed item with author, key, action and a server message', (ctx) => {
      // Asserts the *specific* fields the command pulls from the response —
      // if a future refactor stops rendering authorName/configKey/messages,
      // this fails for the right reason.
      expect(ctx.stdout).to.contain('Alice')
      expect(ctx.stdout).to.contain('my.flag')
      expect(ctx.stdout).to.contain('updated')
      expect(ctx.stdout).to.contain('Updated default rule from false to true')
      // Bot commit (empty authorName) falls back to authorEmail.
      expect(ctx.stdout).to.contain('gitea-bot@quonfig.com')
      expect(ctx.stdout).to.contain('request.timeout')
      // Restored action is surfaced distinctly.
      expect(ctx.stdout).to.contain('restored')
    })

  test
    .stdout()
    .command(['activity feed', '--limit', '7'])
    .it('passes --limit through to the server payload', () => {
      // Direct mechanism test (revert test): if the --limit flag is dropped,
      // the request body won't carry limit=7.
      expect(feedRequests).to.have.length(1)
      expect(feedRequests[0].limit).to.equal(7)
      expect(feedRequests[0].workspaceId).to.equal('workspace-123')
    })

  test
    .stdout()
    .command(['activity feed', '--json'])
    .it('passes the server response through unchanged with --json', (ctx) => {
      const payload = JSON.parse(ctx.stdout)
      expect(payload.items).to.deep.equal(FEED_ITEMS)
    })
})
