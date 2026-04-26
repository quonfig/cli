import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
import * as overrideResponses from '../responses/override.js'
import {TEST_USER_EMAIL, server} from '../responses/override.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('override', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    overrideResponses.resetCaptured()
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  describe('set', () => {
    test
      .stdout()
      .command(['override', 'feature.simple', 'true', '--env=Development'])
      .it('sends bool override with userEmail, env, currentSha (acceptance #1, #8)', () => {
        const sent = overrideResponses.lastFindOrCreateInput
        expect(sent, 'request body captured').to.not.equal(null)
        expect(sent.flagKey).to.equal('feature.simple')
        expect(sent.userEmail).to.equal(TEST_USER_EMAIL)
        expect(sent.env).to.equal('Development')
        expect(sent.value).to.deep.equal({type: 'bool', value: true})
        expect(sent.currentSha).to.equal('sha-current')
      })

    test
      .stdout()
      .command(['override', 'feature.simple', '42', '--env=Development'])
      .it('infers int from "42" (acceptance #8)', () => {
        const sent = overrideResponses.lastFindOrCreateInput
        expect(sent.value).to.deep.equal({type: 'int', value: 42})
      })

    test
      .stdout()
      .command(['override', 'feature.simple', '3.14', '--env=Development'])
      .it('infers double from "3.14" (acceptance #8)', () => {
        const sent = overrideResponses.lastFindOrCreateInput
        expect(sent.value).to.deep.equal({type: 'double', value: 3.14})
      })

    test
      .stdout()
      .command(['override', 'feature.simple', 'hello', '--env=Development'])
      .it('infers string from "hello" (acceptance #8)', () => {
        const sent = overrideResponses.lastFindOrCreateInput
        expect(sent.value).to.deep.equal({type: 'string', value: 'hello'})
      })

    test
      .stdout()
      .command(['override', 'feature.simple', '{"a":1}', '--env=Development'])
      .it('infers json from "{...}" (acceptance #9)', () => {
        const sent = overrideResponses.lastFindOrCreateInput
        expect(sent.value).to.deep.equal({type: 'json', value: {a: 1}})
      })

    test
      .stdout()
      .command(['override', 'feature.simple', 'true', '--env=Development'])
      .it('prints success with the new commit SHA (acceptance #12)', (ctx) => {
        expect(ctx.stdout).to.contain('feature.simple')
        expect(ctx.stdout).to.contain('sha-after-write')
      })
  })

  describe('idempotency (acceptance #10)', () => {
    test
      .stdout()
      .command(['override', 'feature.idempotent', 'true', '--env=Development'])
      .it('detects already-set and skips the API call', (ctx) => {
        expect(ctx.stdout).to.contain('already set')
        expect(overrideResponses.findOrCreateCallCount).to.equal(0)
      })
  })

  describe('remove (acceptance #2, #11)', () => {
    test
      .stdout()
      .command(['override', 'feature.with-mine', '--remove', '--env=Development'])
      .it('sends remove with userEmail, env, currentSha', () => {
        const sent = overrideResponses.lastRemoveInput
        expect(sent, 'request body captured').to.not.equal(null)
        expect(sent.flagKey).to.equal('feature.with-mine')
        expect(sent.userEmail).to.equal(TEST_USER_EMAIL)
        expect(sent.env).to.equal('Development')
        expect(sent.currentSha).to.equal('sha-current')
      })

    test
      .stdout()
      .command(['override', 'feature.no-override', '--remove', '--env=Development'])
      .it('exits 0 with helpful message when no override exists', (ctx) => {
        expect(ctx.stdout).to.contain('no override')
        expect(overrideResponses.removeCallCount).to.equal(0)
      })
  })

  describe('list (acceptance #5)', () => {
    test
      .stdout()
      .command(['override', '--env=Development'])
      .it('prints flags where the current user has an override', (ctx) => {
        expect(ctx.stdout).to.contain('feature.with-mine')
        expect(ctx.stdout).to.not.contain('feature.someone-else')
      })
  })

  describe('clear (acceptance #6)', () => {
    test
      .stdout()
      .command(['override', '--clear', '--env=Development'])
      .it('removes every override the current user has in this env', () => {
        // The fixture has two flags with TEST_USER_EMAIL overrides
        // (feature.with-mine + feature.idempotent); --clear must hit both.
        expect(overrideResponses.removeCallCount).to.equal(2)
        // Each remove call must have been for the current user.
        expect(overrideResponses.lastRemoveInput.userEmail).to.equal(TEST_USER_EMAIL)
      })
  })

  describe('production warning (acceptance #4)', () => {
    test
      .stdout()
      .stderr()
      .command(['override', 'feature.simple', 'true', '--env=production'])
      .it('warns that overrides are inert in production but still sends the call', (ctx) => {
        expect(ctx.stderr).to.match(/production/i)
        expect(ctx.stderr).to.match(/quonfig-user\.email|inert|no effect|harmless/i)
        // Side-effect still happens — warning is soft.
        expect(overrideResponses.findOrCreateCallCount).to.equal(1)
      })
  })

  describe('stale SHA retry (acceptance #7)', () => {
    test
      .stdout()
      .do(() => overrideResponses.armStaleRetry())
      .command(['override', 'feature.stale-once', 'true', '--env=Development'])
      .it('retries once with a fresh SHA after a 409 conflict', () => {
        expect(overrideResponses.findOrCreateCallCount).to.equal(2)
        // The retry must have used the fresh SHA from the 409 message body.
        expect(overrideResponses.lastFindOrCreateInput.currentSha).to.equal('sha-fresh')
      })
  })

  describe('not logged in (acceptance #3)', () => {
    // Use a private describe block: tear down auth before, restore after.
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
      .command(['override', 'feature.simple', 'true', '--env=Development'])
      .catch((error) => {
        expect(error.message).to.match(/log in|qfg login|authentication/i)
      })
      .it('errors before any API call when no auth tokens are present', () => {
        expect(overrideResponses.findOrCreateCallCount).to.equal(0)
      })
  })
})
