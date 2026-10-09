import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {CONTEXT_MATCHES, failingQuery, searchKeysRequests, server, unknownQuery} from '../../responses/contexts.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

// Subcommands with topicSeparator=' ' are passed as a single string id
// (see activity/feed.test.ts).

describe('contexts search (qfg-dpzk.2)', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    searchKeysRequests.length = 0
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['contexts search', 'organization', 'formhealth'])
    .it('prints each match key and name and the targeting property', (ctx) => {
      expect(ctx.stdout).to.contain('org_formhealth')
      expect(ctx.stdout).to.contain('Form Health')
      // A match with no name still prints its key.
      expect(ctx.stdout).to.contain('org_formhealth_eu')
      // Tells the user what to put in the rule.
      expect(ctx.stdout).to.contain('organization.key')
    })

  test
    .stdout()
    .command(['contexts search', 'organization', 'formhealth'])
    .it('prints a KEY / NAME / EMAIL table, leaving a missing name or email blank', (ctx) => {
      const lines = ctx.stdout.split('\n')
      const header = lines.find((line) => line.startsWith('KEY'))
      expect(header).to.match(/^KEY\s+NAME\s+EMAIL$/)
      const row = (key: string) => lines.find((line) => line.startsWith(`${key} `) || line === key)
      expect(row('org_formhealth')).to.match(/^org_formhealth\s+Form Health\s+ops@formhealth\.example$/)
      // No name: the NAME column is blank, the email still lines up under EMAIL.
      const eu = row('org_formhealth_eu')!
      expect(eu).to.match(/^org_formhealth_eu\s+eu@formhealth\.example$/)
      expect(eu.indexOf('eu@formhealth.example')).to.equal(header!.indexOf('EMAIL'))
      // Neither: just the key, nothing invented from other properties.
      expect(row('org_formhealth_bare')).to.equal('org_formhealth_bare')
      expect(ctx.stdout).not.to.contain('no name reported')
    })

  test
    .stdout()
    .command(['contexts search', 'organization', 'formhealth', '--environment', 'production', '--limit', '5'])
    .it('sends workspace, contextType, query, environment and limit to contexts.searchKeys', () => {
      expect(searchKeysRequests).to.have.length(1)
      expect(searchKeysRequests[0]).to.deep.equal({
        contextType: 'organization',
        environment: 'production',
        limit: 5,
        query: 'formhealth',
        workspaceId: 'workspace-123',
      })
    })

  test
    .stdout()
    .command(['contexts search', 'organization', 'formhealth', '--json'])
    .it('passes the {key, name, email?} shape through with --json', (ctx) => {
      const payload = JSON.parse(ctx.stdout)
      expect(payload.contexts).to.deep.equal(CONTEXT_MATCHES)
      // email stays absent (not null, not "") when the server omitted it.
      expect(payload.contexts[2]).not.to.have.property('email')
    })

  test
    .stdout()
    .command(['contexts search', 'organization', unknownQuery])
    .it('says plainly that an empty result means the key is unknown — no slug fallback', (ctx) => {
      expect(ctx.stdout).to.match(/no context .*matched/i)
      expect(ctx.stdout).to.match(/telemetry|sdk/i)
      expect(ctx.stdout).to.match(/key is unknown/i)
      expect(ctx.stdout).to.match(/slug/i)
    })

  test
    .command(['contexts search', 'organization', failingQuery])
    .catch((error) => {
      expect(error.message).to.match(/ClickHouse unavailable|500/)
    })
    .it('surfaces a server failure as an error, not as an empty result')
})
