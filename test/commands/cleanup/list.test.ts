import {expect, test} from '@oclif/test'
import {HttpResponse, http} from 'msw'

import {resetClientCache} from '../../../src/util/get-client.js'
import {
  activeFlagKey,
  evalActivityRequests,
  logLevelKey,
  nonFlagConfigKey,
  notReadyFlagKey,
  quietFlagKey,
  schemaKey,
  server,
  variantFlagKey,
} from '../../responses/cleanup.js'
import {getApiBase} from '../../test-domain-helper.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('cleanup list', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  beforeEach(() => {
    evalActivityRequests.length = 0
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

  // qfg-1nyzs.2: one evalActivity call for the whole workspace replaces the
  // per-environment sparklines loop.
  test
    .stdout()
    .command(['cleanup list', '--json'])
    .it('fetches eval activity in a single request', () => {
      expect(evalActivityRequests).to.have.length(1)
      expect(evalActivityRequests[0].environment).to.equal(undefined)
    })

  test
    .stdout()
    .command(['cleanup list', '--json'])
    .it('--json rows carry kind, ready_for_cleanup and per_environment', (ctx) => {
      const output = JSON.parse(ctx.stdout) as {rows: Array<Record<string, unknown>>}
      const active = output.rows.find((r) => r.key === activeFlagKey)!
      expect(active.kind).to.equal('flag')
      expect(active.ready_for_cleanup).to.equal(true)
      expect(active.last_eval).to.equal(new Date().toISOString().slice(0, 10))
      const perEnv = active.per_environment as Array<Record<string, unknown>>
      expect(perEnv.map((e) => e.environment).sort()).to.deep.equal(['production', 'staging'])
      expect(perEnv.find((e) => e.environment === 'staging')!.evals_2d).to.equal(4)

      const quiet = output.rows.find((r) => r.key === quietFlagKey)!
      expect(quiet.last_eval).to.equal(null)
      expect(quiet.per_environment).to.deep.equal([])
    })

  describe('--all (prospecting)', () => {
    test
      .stdout()
      .command(['cleanup list', '--all', '--json'])
      .it('includes every flag and config, marked or not, but no log levels or schemas', (ctx) => {
        const output = JSON.parse(ctx.stdout) as {rows: Array<{key: string; kind: string; ready_for_cleanup: boolean}>}
        const keys = output.rows.map((r) => r.key)
        expect(keys).to.include.members([
          quietFlagKey,
          activeFlagKey,
          variantFlagKey,
          notReadyFlagKey,
          nonFlagConfigKey,
        ])
        expect(keys).to.not.include(logLevelKey)
        expect(keys).to.not.include(schemaKey)

        const config = output.rows.find((r) => r.key === nonFlagConfigKey)!
        expect(config.kind).to.equal('config')
        expect(config.ready_for_cleanup).to.equal(false)
        expect(output.rows.find((r) => r.key === notReadyFlagKey)!.ready_for_cleanup).to.equal(false)
      })

    test
      .stdout()
      .command(['cleanup list', '--all'])
      .it('table shows KIND and MARKED columns', (ctx) => {
        const lines = ctx.stdout.split('\n')
        expect(lines[0]).to.match(/\bKIND\b/)
        expect(lines[0]).to.match(/\bMARKED\b/)
        const configRow = lines.find((l) => l.includes(nonFlagConfigKey))!
        expect(configRow).to.match(/\bconfig\b/)
        expect(configRow).to.match(/\bquiet\b/)
        const markedRow = lines.find((l) => l.includes(activeFlagKey))!
        expect(markedRow).to.match(/\byes\b/)
      })

    test
      .stdout()
      .command(['cleanup list'])
      .it('default table keeps its original columns', (ctx) => {
        const header = ctx.stdout.split('\n')[0]
        expect(header).to.not.match(/\bKIND\b|\bMARKED\b/)
      })
  })

  describe('--environment', () => {
    test
      .stdout()
      .command(['cleanup list', '--environment', 'staging', '--json'])
      .it('scopes the windows to one environment', (ctx) => {
        expect(evalActivityRequests[0].environment).to.equal('staging')
        const output = JSON.parse(ctx.stdout) as {rows: Array<Record<string, unknown>>}
        const active = output.rows.find((r) => r.key === activeFlagKey)!
        expect(active.evals_24h).to.equal(0)
        expect(active.evals_2d).to.equal(4)
      })

    // An unknown env would return zero rows and make every key look dead.
    test
      .stdout()
      .command(['cleanup list', '--environment', 'prodution'])
      .catch((error) => {
        expect(error.message).to.match(/prodution/)
        expect(error.message).to.match(/production/)
      })
      .it('rejects an unknown environment instead of reporting everything quiet')
  })

  // Empty rows on a ClickHouse outage would read as "everything is dead".
  test
    .stdout()
    .do(() => {
      server.use(
        http.post(`${getApiBase()}/api/v1/analytics/evalActivity`, () =>
          HttpResponse.json({json: {available: false, windowDays: 90, rows: []}}),
        ),
      )
    })
    .command(['cleanup list', '--all'])
    .catch((error) => {
      expect(error.message).to.match(/unavailable/i)
    })
    .it('errors when eval data is unavailable rather than listing everything as quiet')
})
