import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {
  activeFlagKey,
  nonFlagConfigKey,
  notReadyFlagKey,
  quietFlagKey,
  server,
  variantFlagKey,
} from '../../responses/cleanup.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('cleanup list', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  test
    .stdout()
    .command(['cleanup list'])
    .it('lists only flags with readyForCleanup=true (excludes non-flags and unmarked flags)', (ctx) => {
      expect(ctx.stdout).to.contain(quietFlagKey)
      expect(ctx.stdout).to.contain(activeFlagKey)
      expect(ctx.stdout).to.contain(variantFlagKey)
      expect(ctx.stdout).to.not.contain(notReadyFlagKey)
      expect(ctx.stdout).to.not.contain(nonFlagConfigKey)
    })

  test
    .stdout()
    .command(['cleanup list'])
    .it('classifies flags as quiet (0 evals in 2d) vs active', (ctx) => {
      // quietFlagKey has no eval rows in any env → quiet
      const quietRow = ctx.stdout.split('\n').find((line) => line.includes(quietFlagKey))
      expect(quietRow, 'expected a row for the quiet flag').to.exist
      expect(quietRow).to.match(/\bquiet\b/)

      // activeFlagKey has counts today+yesterday in production → active
      const activeRow = ctx.stdout.split('\n').find((line) => line.includes(activeFlagKey))
      expect(activeRow, 'expected a row for the active flag').to.exist
      expect(activeRow).to.match(/\bactive\b/)
    })

  test
    .stdout()
    .command(['cleanup list', '--json'])
    .it('--json returns structured rows with per-window eval counts summed across envs', (ctx) => {
      const output = JSON.parse(ctx.stdout) as {rows: Array<Record<string, unknown>>}
      expect(output.rows).to.be.an('array')

      const active = output.rows.find((r) => r.key === activeFlagKey)
      expect(active, 'expected activeFlagKey in --json rows').to.exist
      expect(active!.type).to.equal('bool')
      expect(active!.class).to.equal('active')

      // production row: today=3, yesterday=10, 5d-ago=50, 20d-ago=200
      // staging row:    yesterday=4
      // Summed: evals_24h (today) = 3 ; evals_2d (today+yesterday) = 3+10+4 = 17
      expect(active!.evals_24h).to.equal(3)
      // evals_2d (today + yesterday) summed across envs = 3 + 10 + 4 = 17
      expect(active!.evals_2d).to.equal(17)
      // evals_7d = today + yesterday + 5d-ago (production-only for activeFlag) = 3 + 10 + 4 + 50 = 67
      expect(active!.evals_7d).to.equal(67)
      // evals_30d = + 20d-ago (production) = 67 + 200 = 267
      expect(active!.evals_30d).to.equal(267)

      const quiet = output.rows.find((r) => r.key === quietFlagKey)
      expect(quiet!.evals_24h).to.equal(0)
      expect(quiet!.evals_2d).to.equal(0)
      expect(quiet!.evals_7d).to.equal(0)
      expect(quiet!.evals_30d).to.equal(0)
      expect(quiet!.class).to.equal('quiet')
    })

  test
    .stdout()
    .command(['cleanup list', '--json'])
    .it('sorts safest-first: quiet flags come before active flags', (ctx) => {
      const output = JSON.parse(ctx.stdout) as {rows: Array<{key: string; class: string}>}
      const firstActiveIndex = output.rows.findIndex((r) => r.class === 'active')
      const lastQuietIndex = output.rows.map((r) => r.class).lastIndexOf('quiet')
      // every quiet row appears before any active row
      expect(lastQuietIndex).to.be.lessThan(firstActiveIndex)
    })
})
