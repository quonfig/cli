/**
 * `qfg cr merge` flow (qfg-5bjew.17, T10; rule 2.1): show the summary,
 * confirm, then merge with expectedHeadSha = the head the user was shown.
 */

import {expect} from 'chai'

import {CrCommandError, runCrMerge, type MergeFlowDeps} from '../../src/change-requests/merge-flow.js'
import type {ChangeRequestDetail} from '../../src/change-requests/types.js'

const HEAD = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'

const detail = (over: Partial<ChangeRequestDetail> = {}): ChangeRequestDetail => ({
  number: 7,
  url: '/workspaces/w/change-requests/7',
  title: 'cr smoke',
  status: 'open',
  branch: 'cr-smoke',
  headSha: HEAD,
  baseSha: 'b'.repeat(40),
  proposer: {label: 'Dana', email: 'dana@x.test', channel: 'cli'},
  proposedByCaller: false,
  createdAt: '2026-11-13T10:00:00.000Z',
  updatedAt: '2026-11-13T10:00:00.000Z',
  merged: null,
  closed: null,
  description: null,
  mainSha: 'a'.repeat(40),
  mergeBase: 'b'.repeat(40),
  files: [{path: 'feature-flags/x.json', kind: 'modify', beforeOid: null, afterOid: null, before: 'a\n', after: 'b\n'}],
  filesSource: 'main',
  mergeable: true,
  blockedBy: null,
  conflicts: [],
  callerCanMerge: true,
  callerDenials: [],
  callerCanClose: true,
  ...over,
})

function deps(opts: {detail?: ChangeRequestDetail; confirm?: boolean}) {
  const calls = {confirm: [] as string[], merge: [] as Array<{expectedHeadSha: string; number: number}>}
  const logs: string[] = []
  const d: MergeFlowDeps = {
    get: async () => opts.detail ?? detail(),
    async merge(number, expectedHeadSha) {
      calls.merge.push({number, expectedHeadSha})
      return {
        number,
        url: '/workspaces/w/change-requests/7',
        mergeCommitSha: 'beefcafe11111111111111111111111111111111',
        mergedAt: '2026-11-13T12:00:00.000Z',
        selfMerged: true,
      }
    },
    async confirm(prompt) {
      calls.confirm.push(prompt)
      return opts.confirm ?? false
    },
    log: (l) => logs.push(l),
  }
  return {d, calls, logs}
}

describe('runCrMerge (qfg-5bjew.17)', () => {
  it('prints the summary before asking, and a decline never calls merge', async () => {
    const {d, calls, logs} = deps({confirm: false})
    const res = await runCrMerge({number: 7, yes: false, canPrompt: true}, d)
    expect(res.kind).to.equal('declined')
    expect(calls.merge).to.have.length(0)
    expect(calls.confirm).to.deep.equal(['Merge change request #7 into main? It goes live. [y/N] '])
    expect(logs.join('\n')).to.include('M feature-flags/x.json')
  })

  it('a yes sends expectedHeadSha equal to the head it showed', async () => {
    const {d, calls, logs} = deps({confirm: true})
    const res = await runCrMerge({number: 7, yes: false, canPrompt: true}, d)
    expect(calls.merge).to.deep.equal([{number: 7, expectedHeadSha: HEAD}])
    expect(res.kind).to.equal('merged')
    expect(logs).to.include('Merged change request #7 into main as beefcaf. It is live. Self-merged.')
  })

  it('--yes skips the prompt and still sends the sha', async () => {
    const {d, calls} = deps({})
    await runCrMerge({number: 7, yes: true, canPrompt: false}, d)
    expect(calls.confirm).to.have.length(0)
    expect(calls.merge).to.deep.equal([{number: 7, expectedHeadSha: HEAD}])
  })

  it('cannot prompt and no --yes: refused, never merges', async () => {
    const {d, calls} = deps({})
    let caught: unknown
    try {
      await runCrMerge({number: 7, yes: false, canPrompt: false}, d)
    } catch (error) {
      caught = error
    }
    expect(caught).to.be.instanceOf(CrCommandError)
    expect((caught as Error).message).to.equal(
      'Refusing to merge #7 without confirmation. Pass --yes or run interactively.',
    )
    expect(calls.merge).to.have.length(0)
  })

  it('refuses locally when the request is not open or not mergeable', async () => {
    for (const [over, msg] of [
      [{status: 'merged' as const}, 'Change request #7 is merged; there is nothing to merge.'],
      [
        {mergeable: false, blockedBy: {reason: 'conflict'}},
        'Change request #7 cannot be merged right now (conflict). Run qfg cr show 7 for details.',
      ],
    ] as const) {
      const {d, calls} = deps({detail: detail(over as Partial<ChangeRequestDetail>)})
      let caught: unknown
      try {
        await runCrMerge({number: 7, yes: true, canPrompt: false}, d)
      } catch (error) {
        caught = error
      }
      expect((caught as Error).message).to.equal(msg)
      expect(calls.merge).to.have.length(0)
    }
  })
})
