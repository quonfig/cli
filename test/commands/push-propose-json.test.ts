/**
 * `qfg push --json` shapes (qfg-5bjew.17, T2). The plain-push shape is
 * unchanged; a propose push reports {proposed:true, applied:false, ...}.
 */

import {expect} from 'chai'

import {pushResultJson} from '../../src/commands/push.js'

const APP = 'https://app.example.test'
const CR = {number: 7, url: '/workspaces/w/change-requests/7', status: 'open' as const}

describe('push --json shapes (qfg-5bjew.17)', () => {
  const saved = process.env.QUONFIG_APP_BASE_URL_OVERRIDE
  beforeEach(() => {
    process.env.QUONFIG_APP_BASE_URL_OVERRIDE = APP
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.QUONFIG_APP_BASE_URL_OVERRIDE
    else process.env.QUONFIG_APP_BASE_URL_OVERRIDE = saved
  })

  it('propose: {proposed:true, applied:false, branch, commitSha, changeRequest(full url)}', () => {
    expect(
      pushResultJson(
        {kind: 'pushed', dispatchedAs: 'clone-path', commitSha: 'abc', branch: 'cr-smoke', changeRequest: CR},
        true,
      ),
    ).to.deep.equal({
      proposed: true,
      applied: false,
      branch: 'cr-smoke',
      commitSha: 'abc',
      changeRequest: {number: 7, url: `${APP}/workspaces/w/change-requests/7`, status: 'open'},
    })
  })

  it('plain push without a change request: unchanged {pushed, via, commitSha}', () => {
    expect(pushResultJson({kind: 'pushed', dispatchedAs: 'clone-path', commitSha: 'abc'}, false)).to.deep.equal({
      pushed: true,
      via: 'clone-path',
      commitSha: 'abc',
    })
    expect(pushResultJson({kind: 'pushed', dispatchedAs: 'bare-path'}, false)).to.deep.equal({
      pushed: true,
      via: 'bare-path',
      commitSha: null,
    })
  })

  it('plain push to a branch with an open request adds changeRequest', () => {
    expect(
      pushResultJson(
        {kind: 'pushed', dispatchedAs: 'clone-path', commitSha: 'abc', branch: 'b', changeRequest: CR},
        false,
      ),
    ).to.deep.equal({
      pushed: true,
      via: 'clone-path',
      commitSha: 'abc',
      changeRequest: {number: 7, url: `${APP}/workspaces/w/change-requests/7`, status: 'open'},
    })
  })
})
