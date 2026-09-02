import {expect, test} from '@oclif/test'

import {resetClientCache} from '../../src/util/get-client.js'
// Shares the set-default mock server: `log-level` talks to the same
// metadata/getByKey + logLevels/update endpoints.
import {logLevelsUpdateCapture, server} from '../responses/set-default.js'
import {cleanupTestAuth, setupTestAuth} from '../test-auth-helper.js'

describe('log-level', () => {
  before(() => {
    setupTestAuth()
    server.listen()
  })
  afterEach(() => {
    server.resetHandlers()
    resetClientCache()
    logLevelsUpdateCapture.body = null
  })
  after(() => {
    server.close()
    cleanupTestAuth()
  })

  // qfg-qjdm: an environment with no block of its own is seeded from a clone
  // of `default.rules` before the merge, the same way `set-default` and the
  // UI's "stop inheriting" do. Starting from an empty list silently dropped
  // the inherited rules for that environment.
  test
    .stdout()
    .command([
      'log-level',
      'log-level.test-app',
      '--target=New.Logger',
      '--value=ERROR',
      '--environment=production',
      '--json',
    ])
    .it('seeds a missing environment from default.rules before merging', () => {
      const body = logLevelsUpdateCapture.body
      expect(body, 'logLevels/update was never called').to.not.be.null
      const environments = body.json.logLevel.environments as Array<{id: string; rules: any[]}>
      const prod = environments.find((e) => e.id === 'production')
      expect(prod, 'production env missing from update payload').to.exist
      // [new targeting rule, inherited targeting rule, inherited fallback]
      expect(prod!.rules).to.have.length(3)
      expect(prod!.rules[0].criteria[0].valueToMatch.value).to.deep.equal(['New.Logger'])
      expect(prod!.rules[0].value).to.deep.equal({type: 'log_level', value: 'ERROR'})
      expect(prod!.rules[1].criteria[0].valueToMatch.value, 'inherited targeting rule kept').to.deep.equal([
        'Existing.Logger',
      ])
      expect(prod!.rules[2].value, 'inherited fallback kept').to.deep.equal({type: 'log_level', value: 'WARN'})
    })

  test
    .stdout()
    .command(['log-level', 'log-level.test-app', '--target=Existing.Logger', '--value=ERROR', '--json'])
    .it('still merges into the default scope by value, not by insertion', () => {
      const body = logLevelsUpdateCapture.body
      expect(body, 'logLevels/update was never called').to.not.be.null
      const rules = (body.json.logLevel.default as {rules: any[]}).rules
      expect(rules).to.have.length(2)
      expect(rules[0].value).to.deep.equal({type: 'log_level', value: 'ERROR'})
    })
})
