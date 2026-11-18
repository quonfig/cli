/**
 * `qfg cr wait` (qfg-5bjew.37): polls changeRequests.get until the request
 * is merged (exit 0), closed (2), blocked by a conflict with main (4) or the
 * timeout passes (124). There is no exit 3: there is no review step.
 */

import {expect} from 'chai'

import type {ChangeRequestDetail} from '../../src/change-requests/types.js'

import {ChangeRequestApiError} from '../../src/change-requests/client.js'
import {CrCommandError} from '../../src/change-requests/merge-flow.js'
import {
  CLONE_CONFLICT_FIX,
  crConflictFix,
  WAIT_EXIT_CODES,
  parseDuration,
  runCrWait,
} from '../../src/change-requests/wait-flow.js'
import {detail as fixture} from '../responses/change-requests.js'

const d = (over: Record<string, unknown>) => fixture(over) as unknown as ChangeRequestDetail

function harness(sequence: Array<ChangeRequestDetail | Error>) {
  let clock = 0
  const calls = {get: 0, sleeps: [] as number[], logs: [] as string[]}
  const deps = {
    async get() {
      const next = sequence[Math.min(calls.get, sequence.length - 1)]
      calls.get += 1
      if (next instanceof Error) throw next
      return next
    },
    now: () => clock,
    async sleep(ms: number) {
      calls.sleeps.push(ms)
      clock += ms
    },
    warn: (line: string) => calls.logs.push(line),
  }
  return {calls, deps}
}

describe('cr wait flow (qfg-5bjew.37)', () => {
  it('exit codes are 0 merged, 2 closed, 4 conflict, 124 timeout (no 3)', () => {
    expect(WAIT_EXIT_CODES).to.deep.equal({merged: 0, closed: 2, conflict: 4, timeout: 124})
  })

  it('polls at the interval until merged, then exits 0', async () => {
    const {calls, deps} = harness([
      d({}),
      d({}),
      d({status: 'merged', merged: {at: 'x', by: 'y', commitSha: 'z', selfMerged: false}}),
    ])
    const result = await runCrWait({intervalMs: 10_000, timeoutMs: 60_000}, deps)
    expect(result.outcome).to.equal('merged')
    expect(result.exitCode).to.equal(0)
    expect(calls.get).to.equal(3)
    expect(calls.sleeps).to.deep.equal([10_000, 10_000])
  })

  it('closed exits 2', async () => {
    const {deps} = harness([d({status: 'closed', closed: {at: 'x', by: 'y', note: null}})])
    const result = await runCrWait({intervalMs: 1000, timeoutMs: 5000}, deps)
    expect(result).to.include({outcome: 'closed', exitCode: 2})
  })

  it('a conflict on a server-built cr/ request exits 4 with "close it and propose again"', async () => {
    const {deps} = harness([
      d({branch: 'cr/12', number: 12, mergeable: false, blockedBy: {reason: 'conflict', conflicts: []}}),
    ])
    const result = await runCrWait({intervalMs: 1000, timeoutMs: 5000}, deps)
    expect(result).to.include({outcome: 'conflict', exitCode: 4})
    expect(result.fix).to.equal(crConflictFix(12))
    expect(result.fix).to.equal(
      'Fix: close it and propose again from current main (qfg cr close 12, then run your change again with --propose).',
    )
  })

  it('a conflict on a clone-pushed request exits 4 with the resolve-by-hand hint', async () => {
    const {deps} = harness([d({branch: 'my-branch', mergeable: false, blockedBy: {reason: 'conflict', conflicts: []}})])
    const result = await runCrWait({intervalMs: 1000, timeoutMs: 5000}, deps)
    expect(result).to.include({outcome: 'conflict', exitCode: 4})
    expect(result.fix).to.equal(CLONE_CONFLICT_FIX)
    expect(result.fix).to.contain('by hand')
  })

  it('other blocks (someone with rights must merge) keep waiting', async () => {
    const {calls, deps} = harness([
      d({mergeable: true, callerCanMerge: false}),
      d({mergeable: false, blockedBy: {reason: 'unauthorized', denials: []}}),
      d({status: 'merged', merged: {at: 'x', by: 'y', commitSha: 'z', selfMerged: false}}),
    ])
    const result = await runCrWait({intervalMs: 1000, timeoutMs: 60_000}, deps)
    expect(result.outcome).to.equal('merged')
    expect(calls.get).to.equal(3)
  })

  it('times out with 124, never sleeping past the deadline', async () => {
    const {calls, deps} = harness([d({})])
    const result = await runCrWait({intervalMs: 4000, timeoutMs: 10_000}, deps)
    expect(result).to.include({outcome: 'timeout', exitCode: 124})
    expect(calls.sleeps).to.deep.equal([4000, 4000, 2000])
    expect(calls.get).to.equal(4)
  })

  it('a transient server error is retried until the timeout', async () => {
    const {calls, deps} = harness([
      new ChangeRequestApiError(502, 'bad gateway'),
      d({status: 'merged', merged: {at: 'x', by: 'y', commitSha: 'z', selfMerged: false}}),
    ])
    const result = await runCrWait({intervalMs: 1000, timeoutMs: 60_000}, deps)
    expect(result.outcome).to.equal('merged')
    expect(calls.logs).to.have.length(1)
  })

  it('a 4xx (for example not found) fails at once', async () => {
    const {deps} = harness([new ChangeRequestApiError(404, 'not found')])
    try {
      await runCrWait({intervalMs: 1000, timeoutMs: 60_000}, deps)
      expect.fail('expected a throw')
    } catch (error) {
      expect(error).to.be.instanceOf(ChangeRequestApiError)
    }
  })

  describe('parseDuration', () => {
    it('reads ms, s, m, h and bare seconds', () => {
      expect(parseDuration('30m', '--timeout')).to.equal(1_800_000)
      expect(parseDuration('10s', '--interval')).to.equal(10_000)
      expect(parseDuration('1h', '--timeout')).to.equal(3_600_000)
      expect(parseDuration('250ms', '--interval')).to.equal(250)
      expect(parseDuration('45', '--interval')).to.equal(45_000)
    })

    it('refuses anything else', () => {
      expect(() => parseDuration('soon', '--timeout')).to.throw(
        CrCommandError,
        '--timeout: expected a duration like 30m, 10s, 1h or 500ms, got soon',
      )
    })
  })
})
