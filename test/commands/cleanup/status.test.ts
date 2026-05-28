import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {activeFlagKey, quietFlagKey, server} from '../../responses/cleanup.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('cleanup status', () => {
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
    .command(['cleanup status', activeFlagKey])
    .it('shows the flag key and per-env rule summary', (ctx) => {
      expect(ctx.stdout).to.contain(activeFlagKey)
      // The default rules summary should mention the unconditional value (true)
      expect(ctx.stdout.toLowerCase()).to.contain('true')
    })

  test
    .stdout()
    .command(['cleanup status', activeFlagKey, '--json'])
    .it('--json returns rule shape + per-env aggregated evals from configSparklines', (ctx) => {
      const json = JSON.parse(ctx.stdout) as {
        key: string
        readyForCleanup: boolean
        evals: {evals_24h: number; evals_2d: number; evals_7d: number; evals_30d: number}
        environments: Array<{environment: string; total: number}>
      }
      expect(json.key).to.equal(activeFlagKey)
      expect(json.readyForCleanup).to.equal(true)
      // production: today=3, yesterday=10, 5d-ago=50, 20d-ago=200
      // staging:    yesterday=4
      expect(json.evals.evals_24h).to.equal(3)
      expect(json.evals.evals_2d).to.equal(17)
      expect(json.evals.evals_7d).to.equal(67)
      expect(json.evals.evals_30d).to.equal(267)
      // env-level totals
      const prod = json.environments.find((e) => e.environment === 'production')
      const staging = json.environments.find((e) => e.environment === 'staging')
      expect(prod?.total).to.equal(263) // 200 + 50 + 10 + 3
      expect(staging?.total).to.equal(4)
    })

  test
    .stdout()
    .command(['cleanup status', quietFlagKey, '--json'])
    .it('--json for a quiet flag reports zero evals across all windows', (ctx) => {
      const json = JSON.parse(ctx.stdout) as {
        evals: {evals_24h: number; evals_2d: number; evals_7d: number; evals_30d: number}
        environments: unknown[]
      }
      expect(json.evals.evals_24h).to.equal(0)
      expect(json.evals.evals_2d).to.equal(0)
      expect(json.evals.evals_7d).to.equal(0)
      expect(json.evals.evals_30d).to.equal(0)
      expect(json.environments).to.deep.equal([])
    })
})
