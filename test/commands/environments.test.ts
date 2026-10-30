import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import {server} from '../responses/environments.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

// qfg-r3a47: agents guessed "production" because no command listed the
// workspace's environment names.
describe('environments', () => {
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
    .command(['environments'])
    .it('lists the environment names, sorted, without deleted ones', (ctx) => {
      const lines = ctx.stdout.trim().split('\n')
      const names = lines.filter((l) => /^(development|production|staging)\b/.test(l)).map((l) => l.split(/\s+/)[0])
      expect(names).to.eql(['development', 'production', 'staging'])
      expect(ctx.stdout).to.not.contain('old')
      expect(ctx.stdout).to.match(/production\s+protected/)
      expect(ctx.stdout).to.contain('[Default]')
    })

  test
    .stdout()
    .command(['environments', '--json'])
    .it('returns names, ids and protected in --json', (ctx) => {
      expect(JSON.parse(ctx.stdout)).to.eql({
        environments: [
          {id: 'env-dev-uuid', name: 'development', protected: false},
          {id: 'env-prod-uuid', name: 'production', protected: true},
          {id: 'env-staging-uuid', name: 'staging', protected: false},
        ],
      })
    })

  test
    .stdout()
    .command(['envs', '--json'])
    .it('supports the `envs` alias', (ctx) => {
      expect(JSON.parse(ctx.stdout).environments).to.have.length(3)
    })
})
