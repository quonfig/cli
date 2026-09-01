import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../../src/util/get-client.js'
import {activeFlagKey, quietFlagKey, server} from '../../responses/cleanup.js'
import {cleanupTestAuth, setupTestAuth} from '../../test-auth-helper.js'

describe('cleanup verify', () => {
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
    .command(['cleanup verify'])
    .catch((error) => {
      expect(error.message.toLowerCase()).to.match(/key/)
    })
    .it('errors when no key is supplied')

  test
    .stdout()
    .command(['cleanup verify', quietFlagKey])
    .it('prints a safe-to-delete message and exits 0 when there are no recent evals', (ctx) => {
      expect(ctx.stdout.toLowerCase()).to.contain('safe')
      expect(ctx.stdout).to.contain(quietFlagKey)
    })

  test
    .stdout()
    .command(['cleanup verify', quietFlagKey, '--json'])
    .it('--json reports safe=true with zero evals and a null lastEval for a quiet flag', (ctx) => {
      const json = JSON.parse(ctx.stdout) as {
        daysChecked: number
        evals: number
        key: string
        lastEval: string | null
        safe: boolean
      }
      expect(json.key).to.equal(quietFlagKey)
      expect(json.daysChecked).to.equal(7)
      expect(json.evals).to.equal(0)
      expect(json.lastEval).to.equal(null)
      expect(json.safe).to.equal(true)
    })

  test
    .command(['cleanup verify', activeFlagKey])
    .catch((error) => {
      // active flag has 67 evals in last 7 days; latest is today
      expect(error.message).to.match(/67/)
      expect(error.message.toLowerCase()).to.match(/7/)
      expect(error.message.toLowerCase()).to.contain('last')
    })
    .it('exits non-zero with the eval count + latest date when the trailing window is dirty')

  test
    .stdout()
    .command(['cleanup verify', activeFlagKey, '--json'])
    .it('--json reports safe=false with the eval count and lastEval for an active flag', (ctx) => {
      // --json mode always exits 0 and emits the payload; agents read `safe`.
      // Shell chaining (`verify && delete`) uses the no-flag mode where exit
      // status matters.
      const json = JSON.parse(ctx.stdout) as {
        daysChecked: number
        evals: number
        key: string
        lastEval: string | null
        safe: boolean
      }
      expect(json.key).to.equal(activeFlagKey)
      expect(json.daysChecked).to.equal(7)
      expect(json.evals).to.equal(67)
      expect(json.lastEval).to.be.a('string')
      expect(json.safe).to.equal(false)

      // qfg-hzmb regression: `cleanup verify` shadows --json with its own flag
      // and deliberately succeeds on a dirty window so agents can read `safe`.
      // The new JSON error path in BaseCommand.catch() must not turn that into
      // an error envelope.
      expect(ctx.stdout).to.not.include('"error"')
      expect(json).to.not.have.property('error')
    })

  test
    .stdout()
    .command(['cleanup verify', activeFlagKey, '--days', '1', '--json'])
    .it('--days 1 narrows the window — today bucket only (3 evals from production)', (ctx) => {
      const json = JSON.parse(ctx.stdout) as {daysChecked: number; evals: number; safe: boolean}
      expect(json.daysChecked).to.equal(1)
      // today=3 (production), staging has none today
      expect(json.evals).to.equal(3)
      expect(json.safe).to.equal(false)
    })

  test
    .command(['cleanup verify', 'flag.does-not-exist'])
    .catch((error) => {
      expect(error.message).to.match(/not found/i)
    })
    .it('errors when the flag is missing on the server')
})
