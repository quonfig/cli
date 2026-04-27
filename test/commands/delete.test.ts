import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import * as deleteResponses from '../responses/delete.js'
import {server} from '../responses/delete.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('delete', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    deleteResponses.resetCaptured()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  describe('--yes (acceptance #1)', () => {
    test
      .stdout()
      .command(['delete', 'feature.flag.to-delete', '--yes'])
      .it('deletes a feature flag via flags/delete with workspaceId + flagKey', () => {
        expect(deleteResponses.flagDeleteCallCount).to.equal(1)
        expect(deleteResponses.configDeleteCallCount).to.equal(0)
        const sent = deleteResponses.lastFlagDeleteInput
        expect(sent, 'request body captured').to.not.equal(null)
        expect(sent.flagKey).to.equal('feature.flag.to-delete')
        expect(sent.workspaceId).to.be.a('string')
      })

    test
      .stdout()
      .command(['delete', 'config.to-delete', '--yes'])
      .it('deletes a config via configs/delete with workspaceId + configKey', () => {
        expect(deleteResponses.configDeleteCallCount).to.equal(1)
        expect(deleteResponses.flagDeleteCallCount).to.equal(0)
        const sent = deleteResponses.lastConfigDeleteInput
        expect(sent, 'request body captured').to.not.equal(null)
        expect(sent.configKey).to.equal('config.to-delete')
      })

    test
      .stdout()
      .command(['delete', 'log-level.to-delete', '--yes'])
      .it('deletes a log_level via logLevels/delete with workspaceId + logLevelKey', () => {
        expect(deleteResponses.logLevelDeleteCallCount).to.equal(1)
        const sent = deleteResponses.lastLogLevelDeleteInput
        expect(sent, 'request body captured').to.not.equal(null)
        expect(sent.logLevelKey).to.equal('log-level.to-delete')
      })

    test
      .stdout()
      .command(['delete', 'feature.flag.to-delete', '--yes'])
      .it('prints success message including the deleted key', (ctx) => {
        expect(ctx.stdout).to.contain('feature.flag.to-delete')
        expect(ctx.stdout.toLowerCase()).to.match(/delet/i)
      })
  })

  describe('confirmation gate (acceptance #2)', () => {
    test
      .stderr()
      .command(['delete', 'feature.flag.to-delete', '--no-interactive'])
      .catch((error) => {
        expect(error.message).to.match(/--yes|interactive/i)
      })
      .it('errors when no --yes is passed and not interactive, no API call', () => {
        expect(deleteResponses.flagDeleteCallCount).to.equal(0)
        expect(deleteResponses.configDeleteCallCount).to.equal(0)
      })
  })

  describe('unknown key (acceptance #4)', () => {
    test
      .stderr()
      .command(['delete', 'does.not.exist', '--yes'])
      .catch((error) => {
        expect(error.message).to.match(/not found|does\.not\.exist/i)
      })
      .it('errors with helpful message and does not call any delete endpoint', () => {
        expect(deleteResponses.flagDeleteCallCount).to.equal(0)
        expect(deleteResponses.configDeleteCallCount).to.equal(0)
        expect(deleteResponses.logLevelDeleteCallCount).to.equal(0)
      })
  })

  describe('not logged in (acceptance #5)', () => {
    let restored = false
    before(() => {
      cleanupTestAuth()
    })
    after(() => {
      if (!restored) {
        setupTestAuth()
        restored = true
      }
    })

    test
      .stderr()
      .command(['delete', 'feature.flag.to-delete', '--yes'])
      .catch((error) => {
        expect(error.message).to.match(/log in|qfg login|authentication|not logged/i)
      })
      .it('errors before any API call when no auth tokens are present', () => {
        expect(deleteResponses.flagDeleteCallCount).to.equal(0)
        expect(deleteResponses.configDeleteCallCount).to.equal(0)
      })
  })
})
