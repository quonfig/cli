/**
 * `qfg cr list|show|merge|close` (qfg-5bjew.17) against mocked
 * changeRequests.* routes. Command tests run dist/: `yarn build` first.
 */

import {expect, test} from '@oclif/test'
import {HttpResponse, http} from 'msw'

import {getAppUrl} from '../../src/util/domain-urls.js'
import {
  HEAD_SHA,
  MERGE_SHA,
  WS,
  captured,
  detail,
  orpcError,
  resetCaptured,
  server,
} from '../responses/change-requests.js'
import {getApiBase} from '../test-domain-helper.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

const crUrl = () => `${getAppUrl()}/workspaces/${WS}/change-requests/7`
const route = (name: string) => `${getApiBase()}/api/v1/changeRequests/${name}`

describe('qfg cr (qfg-5bjew.17)', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetCaptured()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  describe('cr list (T8)', () => {
    test
      .stdout()
      .command(['cr list'])
      .it('prints one row per request; sends only the workspace by default', (ctx) => {
        expect(captured.list).to.deep.equal([{workspaceId: WS}])
        const lines = ctx.stdout.trim().split('\n')
        expect(lines[0]).to.equal('#7  open  cr-smoke  Dana Kim  2026-11-13  cr smoke')
        expect(lines[1]).to.equal('#5  open  b5  Dana Kim  2026-11-13  older')
      })

    test
      .stdout()
      .command(['cr list', '--mine', '--status', 'merged', '--limit', '3'])
      .it('sends --mine, --status and --limit', () => {
        expect(captured.list).to.deep.equal([{workspaceId: WS, mine: true, status: 'merged', limit: 3}])
      })

    test
      .stdout()
      .command(['cr list', '--json'])
      .it('--json returns {changeRequests} with absolute urls', (ctx) => {
        const out = JSON.parse(ctx.stdout)
        expect(out.changeRequests).to.have.length(2)
        expect(out.changeRequests[0].number).to.equal(7)
        expect(out.changeRequests[0].url).to.equal(crUrl())
        expect(out.changeRequests[0].headSha).to.equal(HEAD_SHA)
      })

    test
      .add('empty', () => server.use(http.post(route('list'), () => HttpResponse.json({json: {changeRequests: []}}))))
      .stdout()
      .command(['cr list', '--status', 'closed'])
      .it('says when there are none', (ctx) => {
        expect(ctx.stdout.trim()).to.equal('No closed change requests.')
      })
  })

  describe('cr show (T9)', () => {
    test
      .stdout()
      .command(['cr show', '7'])
      .it('leads with the computed diff, then status, title, proposer, merge/close rights, url', (ctx) => {
        expect(captured.get).to.deep.equal([{workspaceId: WS, number: 7}])
        const lines = ctx.stdout.split('\n')
        expect(lines[0]).to.equal('Changes against main (what a merge would land):')
        expect(ctx.stdout).to.contain('  M feature-flags/checkout.json')
        expect(ctx.stdout).to.contain('    -   "value": false')
        expect(ctx.stdout).to.contain('    +   "value": true')
        expect(ctx.stdout.indexOf('"value": true')).to.be.lessThan(ctx.stdout.indexOf('Change request #7 [open]'))
        expect(ctx.stdout).to.contain('Title (as written by the proposer): cr smoke')
        expect(ctx.stdout).to.contain('Proposed by Dana Kim <dana@quonfig.test> via cli')
        expect(ctx.stdout).to.contain('Mergeable: yes')
        expect(ctx.stdout).to.contain('You can merge: yes')
        expect(ctx.stdout).to.contain('You can close: yes')
        expect(ctx.stdout).to.contain(crUrl())
      })

    test
      .stdout()
      .command(['cr show', 'refs/heads/cr-smoke'])
      .it('looks a branch up by name (refs/heads/ stripped)', () => {
        expect(captured.get).to.deep.equal([{workspaceId: WS, branch: 'cr-smoke'}])
      })

    test
      .add('conflicted', () =>
        server.use(
          http.post(route('get'), () =>
            HttpResponse.json({
              json: detail({
                filesSource: 'fork_point',
                mergeable: false,
                blockedBy: {
                  reason: 'conflict',
                  conflicts: [{path: 'feature-flags/checkout.json', mainCommit: 'abcdef1234567890'}],
                },
                conflicts: [{path: 'feature-flags/checkout.json', mainCommit: 'abcdef1234567890'}],
                callerCanMerge: false,
                callerDenials: [
                  {path: 'feature-flags/checkout.json', reason: 'x', requiredPermission: 'config.edit.protected'},
                ],
              }),
            }),
          ),
        ),
      )
      .stdout()
      .command(['cr show', '7'])
      .it('shows conflicts and who can merge', (ctx) => {
        expect(ctx.stdout).to.contain('Conflicts with main: feature-flags/checkout.json (changed in abcdef1)')
        expect(ctx.stdout).to.contain('Mergeable: no (conflict)')
        expect(ctx.stdout).to.contain(
          'You can merge: no (Requires: config.edit.protected on feature-flags/checkout.json)',
        )
      })

    test
      .stdout()
      .command(['cr show', '7', '--json'])
      .it('--json is the server object with an absolute url', (ctx) => {
        const out = JSON.parse(ctx.stdout)
        expect(out.number).to.equal(7)
        expect(out.url).to.equal(crUrl())
        expect(out.files[0].path).to.equal('feature-flags/checkout.json')
        expect(out.callerCanMerge).to.equal(true)
      })

    test
      .stdout()
      .stderr()
      .command(['cr show', '404'])
      .catch((error) => {
        expect(error.message).to.equal('Change request #404 not found in this workspace.')
      })
      .it('404 prints a clear message')

    test
      .stdout()
      .stderr()
      .command(['cr show', '99999999999'])
      .catch((error) => {
        expect(error.message).to.equal('Not a change request number: 99999999999')
      })
      .it('an out-of-range number is refused locally, never sent', () => {
        expect(captured.get).to.have.length(0)
      })

    test
      .stdout()
      .command(['cr show', 'refs/heads/123'])
      .it('a branch named like a number is looked up with refs/heads/', () => {
        expect(captured.get).to.deep.equal([{workspaceId: WS, branch: '123'}])
      })
  })

  describe('cr merge (T10)', () => {
    test
      .stdout()
      .command(['cr merge', '7', '--yes'])
      .it('prints the summary and sends expectedHeadSha = the head it just showed', (ctx) => {
        expect(captured.get).to.deep.equal([{workspaceId: WS, number: 7}])
        expect(captured.merge).to.deep.equal([{workspaceId: WS, number: 7, expectedHeadSha: HEAD_SHA}])
        expect(ctx.stdout).to.contain('M feature-flags/checkout.json')
        expect(ctx.stdout).to.contain(`Merged change request #7 into main as ${MERGE_SHA.slice(0, 7)}. It is live.`)
      })

    test
      .stdout()
      .command(['cr merge', '7', '--yes', '--json'])
      .it('--json shape', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.deep.equal({
          merged: true,
          number: 7,
          url: crUrl(),
          mergeCommitSha: MERGE_SHA,
          mergedAt: '2026-11-13T12:00:00.000Z',
          selfMerged: false,
          expectedHeadSha: HEAD_SHA,
        })
      })

    test
      .stdout()
      .stderr()
      .command(['cr merge', '7'])
      .catch((error) => {
        expect(error.message).to.equal('Refusing to merge #7 without confirmation. Pass --yes or run interactively.')
      })
      .it('non-interactive without --yes is refused and never merges', () => {
        expect(captured.merge).to.have.length(0)
      })

    test
      .add('moved', () =>
        server.use(
          http.post(route('merge'), () =>
            orpcError(409, 'CONFLICT', 'the change request changed since you viewed it', {
              reason: 'HeadMoved',
              expected: HEAD_SHA,
              current: 'dddddddddddddddddddddddddddddddddddddddd',
            }),
          ),
        ),
      )
      .stdout()
      .stderr()
      .command(['cr merge', '7', '--yes'])
      .catch((error) => {
        expect(error.message).to.equal(
          'Change request #7 changed since you viewed it (head c0ffee0 -> ddddddd). Nothing merged. Run qfg cr show 7 and merge again.',
        )
      })
      .it('409 HeadMoved says nothing merged')

    test
      .add('denied', () =>
        server.use(
          http.post(route('get'), () =>
            HttpResponse.json({
              json: detail({
                callerCanMerge: false,
                callerDenials: [
                  {path: 'feature-flags/checkout.json', reason: 'x', requiredPermission: 'config.edit.protected'},
                ],
              }),
            }),
          ),
        ),
      )
      .stdout()
      .stderr()
      .command(['cr merge', '7', '--yes'])
      .catch((error) => {
        expect(error.message).to.equal(
          'You cannot merge change request #7. Requires: config.edit.protected on feature-flags/checkout.json',
        )
      })
      .it('refuses locally when the caller cannot merge', () => {
        expect(captured.merge).to.have.length(0)
      })
  })

  describe('cr close (T11)', () => {
    test
      .stdout()
      .command(['cr close', '7', '--note', 'superseded by #8'])
      .it('closes, sends the note', (ctx) => {
        expect(captured.close).to.deep.equal([{workspaceId: WS, number: 7, note: 'superseded by #8'}])
        expect(ctx.stdout).to.contain('Closed change request #7.')
        expect(ctx.stdout).to.contain('Its branch was deleted on the server.')
      })

    test
      .stdout()
      .command(['cr close', '7', '--json'])
      .it('--json shape', (ctx) => {
        expect(JSON.parse(ctx.stdout)).to.deep.equal({
          closed: true,
          number: 7,
          url: crUrl(),
          closedAt: '2026-11-13T12:00:00.000Z',
          branchDeleted: true,
        })
      })

    test
      .add('forbidden', () =>
        server.use(
          http.post(route('close'), () =>
            orpcError(
              403,
              'FORBIDDEN',
              'Only the proposer of change request #7, or someone allowed to merge it, can close it. Requires: config.edit.protected',
            ),
          ),
        ),
      )
      .stdout()
      .stderr()
      .command(['cr close', '7'])
      .catch((error) => {
        expect(error.message).to.contain('Only the proposer of change request #7')
      })
      .it('403 prints the server message')
  })
})
