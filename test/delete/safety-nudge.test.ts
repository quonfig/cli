import {expect} from 'chai'

import {checkRecentEvalsSafetyNudge, countEvalsLast24h} from '../../src/delete/safety-nudge.js'

const today = new Date().toISOString().slice(0, 10)
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

describe('delete/safety-nudge', () => {
  describe('countEvalsLast24h', () => {
    it('returns 0 for empty rows', () => {
      expect(countEvalsLast24h([])).to.equal(0)
    })

    it('sums counts in today’s bucket across environments', () => {
      const rows = [
        {environment: 'production', days: [today, yesterday], counts: [5, 99]},
        {environment: 'staging', days: [today], counts: [2]},
      ]
      expect(countEvalsLast24h(rows)).to.equal(7)
    })

    it('ignores buckets older than today', () => {
      const rows = [{environment: 'production', days: [yesterday, twoDaysAgo], counts: [10, 20]}]
      expect(countEvalsLast24h(rows)).to.equal(0)
    })

    it('ignores rows with malformed day strings', () => {
      const rows = [{environment: 'production', days: ['not-a-date', today], counts: [5, 3]}]
      expect(countEvalsLast24h(rows)).to.equal(3)
    })

    it('treats negative counts as zero', () => {
      const rows = [{environment: 'production', days: [today, today], counts: [-1, 4]}]
      expect(countEvalsLast24h(rows)).to.equal(4)
    })
  })

  describe('checkRecentEvalsSafetyNudge', () => {
    it('returns proceed=true without prompting when evals_24h is zero', async () => {
      let promptCalled = false
      const result = await checkRecentEvalsSafetyNudge({
        key: 'my.flag',
        fetchSparklines: async () => ({ok: true, rows: []}),
        async prompt() {
          promptCalled = true
          return true
        },
        warn() {},
      })
      expect(result).to.deep.equal({proceed: true, evals24h: 0, telemetryFailed: false})
      expect(promptCalled).to.equal(false)
    })

    it('prompts when evals_24h > 0 and proceeds when user confirms', async () => {
      let promptMessage: string | null = null
      const result = await checkRecentEvalsSafetyNudge({
        key: 'my.flag',
        fetchSparklines: async () => ({
          ok: true,
          rows: [{environment: 'production', days: [today], counts: [42]}],
        }),
        async prompt(msg: string) {
          promptMessage = msg
          return true
        },
        warn() {},
      })
      expect(result.proceed).to.equal(true)
      expect(result.evals24h).to.equal(42)
      expect(result.telemetryFailed).to.equal(false)
      expect(promptMessage).to.match(/42/)
      expect(promptMessage).to.match(/my\.flag/)
      expect(promptMessage).to.match(/cleanup remove/)
    })

    it('returns proceed=false when user declines the safety prompt', async () => {
      const result = await checkRecentEvalsSafetyNudge({
        key: 'my.flag',
        fetchSparklines: async () => ({
          ok: true,
          rows: [{environment: 'production', days: [today], counts: [3]}],
        }),
        prompt: async () => false,
        warn() {},
      })
      expect(result).to.deep.equal({proceed: false, evals24h: 3, telemetryFailed: false})
    })

    it('warns and proceeds without prompting when the telemetry call fails', async () => {
      let warnedMessage: string | null = null
      let promptCalled = false
      const result = await checkRecentEvalsSafetyNudge({
        key: 'my.flag',
        fetchSparklines: async () => ({ok: false, error: 'network down'}),
        async prompt() {
          promptCalled = true
          return true
        },
        warn(msg: string) {
          warnedMessage = msg
        },
      })
      expect(result).to.deep.equal({proceed: true, evals24h: 0, telemetryFailed: true})
      expect(promptCalled).to.equal(false)
      expect(warnedMessage).to.match(/network down/i)
    })
  })
})
