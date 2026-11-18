/**
 * `qfg cr wait <n|branch>` (qfg-5bjew.37) against a stubbed
 * changeRequests.get sequence. Command tests run dist/: `yarn build` first.
 */

import {expect, test} from '@oclif/test'
import {HttpResponse, http} from 'msw'

import {getAppUrl} from '../../src/util/domain-urls.js'
import {WS, detail, server} from '../responses/change-requests.js'
import {getApiBase} from '../test-domain-helper.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const route = (name: string) => `${getApiBase()}/api/v1/changeRequests/${name}`
const MERGED = {
  status: 'merged',
  merged: {at: '2026-11-18T12:00:00.000Z', by: 'Lee', commitSha: 'beefcafe', selfMerged: false},
}

const seen: any[] = []
const sequence =
  (...steps: Record<string, unknown>[]) =>
  () => {
    let i = 0
    server.use(
      http.post(route('get'), async ({request}) => {
        const body = (await request.json()) as {json: unknown}
        seen.push(body.json)
        const step = steps[Math.min(i, steps.length - 1)]
        i += 1
        return HttpResponse.json({json: detail(step)})
      }),
    )
  }

describe('qfg cr wait (qfg-5bjew.37)', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    seen.length = 0
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .add('seq', sequence({}, {}, MERGED))
    .stdout()
    .stderr()
    .command(['cr wait', '7', '--interval', '1ms', '--timeout', '5s'])
    .it('polls until merged, exits 0 and prints the final cr show', (ctx) => {
      expect(seen).to.have.length(3)
      expect(seen[0]).to.deep.equal({workspaceId: WS, number: 7})
      expect(ctx.stdout).to.contain('Change request #7 [merged]')
      expect(ctx.stdout).to.contain('Merged by Lee')
    })

  test
    .add('seq', sequence({}, {status: 'closed', closed: {at: '2026-11-18T12:00:00.000Z', by: 'Lee', note: null}}))
    .stdout()
    .stderr()
    .command(['cr wait', '7', '--interval', '1ms'])
    .exit(2)
    .it('exits 2 when the request is closed')

  test
    .add(
      'seq',
      sequence({
        branch: 'cr/7',
        mergeable: false,
        blockedBy: {reason: 'conflict'},
        conflicts: [{path: 'feature-flags/checkout.json', mainCommit: 'aaaa1111'}],
      }),
    )
    .stdout()
    .stderr()
    .command(['cr wait', '7', '--interval', '1ms'])
    .exit(4)
    .it('exits 4 on a conflict with main and prints the fix for a cr/ request', (ctx) => {
      expect(ctx.stdout).to.contain('Conflicts with main: feature-flags/checkout.json')
      expect(ctx.stdout).to.contain(
        'Fix: close it and propose again from the current state of main (qfg cr close 7, then run your change again with --propose).',
      )
    })

  test
    .add('seq', sequence({}))
    .stdout()
    .stderr()
    .command(['cr wait', '7', '--interval', '1ms', '--timeout', '20ms'])
    .exit(124)
    .it('exits 124 on timeout', (ctx) => {
      expect(ctx.stdout).to.contain('Change request #7 [open]')
      expect(ctx.stderr).to.contain('Timed out after 20ms waiting for change request #7; it is still open.')
    })

  test
    .add('seq', sequence({status: 'closed', closed: {at: null, by: 'Lee', note: null}}))
    .stdout()
    .stderr()
    .command(['cr wait', 'cr-smoke', '--interval', '1ms', '--json'])
    .exit(2)
    .it('looks up a branch; --json prints the detail with the wait outcome before exiting', (ctx) => {
      expect(seen[0]).to.deep.equal({workspaceId: WS, branch: 'cr-smoke'})
      const out = JSON.parse(ctx.stdout)
      expect(out.number).to.equal(7)
      expect(out.url).to.equal(`${getAppUrl()}/workspaces/${WS}/change-requests/7`)
      expect(out.wait).to.deep.equal({outcome: 'closed', exitCode: 2})
    })

  test
    .stdout()
    .stderr()
    .command(['cr wait', '404', '--interval', '1ms'])
    .catch((error) => {
      expect(error.message).to.equal('Change request #404 not found in this workspace.')
    })
    .it('an unknown request fails (exit 1)')

  test
    .stdout()
    .stderr()
    .command(['cr wait', '7', '--timeout', 'soon'])
    .catch((error) => {
      expect(error.message).to.equal('--timeout: expected a duration like 30m, 10s, 1h or 500ms, got soon')
    })
    .it('refuses a bad duration')
})
